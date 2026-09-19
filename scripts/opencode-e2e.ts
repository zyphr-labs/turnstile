import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/endpoint";
import { hash } from "../src/guard";
import { normalizeEndpointAction } from "../src/runtime";
import { requestSchema } from "../src/schema";

// Runs the installed host with a deterministic loopback model. No model account is used.
// --live additionally sends the synthetic allowed action to Jev using TYPESAFE_API_KEY.
const binary = process.env.OPENCODE_BIN ?? Bun.which("opencode");
if (!binary) throw new Error("Install OpenCode or set OPENCODE_BIN to its executable.");
const live = process.argv.includes("--live");
if (live && !process.env.TYPESAFE_API_KEY) throw new Error("--live requires TYPESAFE_API_KEY.");
const root = await realpath(await mkdtemp(join(tmpdir(), "turnstile-opencode-e2e-")));
const plugin = resolve(import.meta.dir, "../src/adapters/opencode.ts");
let marker = "";
let toolCalls = 0;
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
      return new Response("Not found", { status: 404 });
    requests++;
    if (requests > 20) return new Response("Fixture request limit", { status: 429 });
    const body = (await request.json()) as {
      stream?: boolean;
      messages?: { role: string }[];
      tools?: { function?: { name?: string } }[];
    };
    const write = body.tools?.some((tool) => tool.function?.name === "write");
    const finished = body.messages?.some((message) => message.role === "tool");
    const emitTool = write && !finished;
    if (emitTool) toolCalls++;
    const call = {
      id: "call_turnstile_fixture",
      type: "function",
      function: {
        name: "write",
        arguments: JSON.stringify({ filePath: marker, content: "Hello." }),
      },
    };
    const message = emitTool
      ? { role: "assistant", content: null, tool_calls: [call] }
      : { role: "assistant", content: "Fixture complete." };
    const base = { id: "fixture-completion", created: 1, model: "fixture" };
    if (!body.stream)
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: emitTool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    const delta = emitTool
      ? { role: "assistant", tool_calls: [{ index: 0, ...call }] }
      : { role: "assistant", content: "Fixture complete." };
    const chunks = [
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
      },
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: emitTool ? "tool_calls" : "stop" }],
      },
    ];
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  },
});

try {
  const cases = ["observe", "deny", ...(live ? ["live"] : [])];
  for (const name of cases) {
    const project = join(root, name);
    await mkdir(join(project, ".opencode/plugins"), { recursive: true });
    await mkdir(join(project, ".turnstile"), { recursive: true });
    marker = join(project, "marker.txt");
    toolCalls = 0;
    requests = 0;
    const goal = `Create ${marker} with exactly the content Hello. using the write tool once. Then stop.`;
    const config = defaultConfig(project);
    config.policy.mode = name === "observe" ? "observe" : "enforce";
    config.policy.tools.Write = { effect: name === "deny" ? "deny" : "allow" };
    config.jev.enabled = name === "live";
    config.jev.timeoutMs = 10000;
    await writeFile(join(project, ".turnstile/config.json"), JSON.stringify(config));
    await writeFile(
      join(project, ".opencode/plugins/turnstile.ts"),
      `export { default } from ${JSON.stringify(plugin)};\n`,
    );
    await writeFile(
      join(project, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        share: "disabled",
        model: "fixture/fixture",
        small_model: "fixture/fixture",
        enabled_providers: ["fixture"],
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Loopback test fixture",
            options: {
              baseURL: `http://127.0.0.1:${server.port}/v1`,
              apiKey: "synthetic-fixture-key",
            },
            models: {
              fixture: {
                name: "Fixture",
                limit: { context: 32000, output: 1024 },
                tool_call: true,
              },
            },
          },
        },
      }),
    );
    const child = Bun.spawn(
      [
        binary,
        "run",
        "--format",
        "json",
        "--title",
        "Turnstile fixture",
        "--model",
        "fixture/fixture",
      ],
      {
        cwd: project,
        env: {
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: join(project, "xdg-config"),
          XDG_DATA_HOME: join(project, "xdg-data"),
          XDG_CACHE_HOME: join(project, "xdg-cache"),
          XDG_STATE_HOME: join(project, "xdg-state"),
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          ...(name === "live" ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY } : {}),
        },
        stdin: new Blob([goal]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60000);
    let result: { stdout: string; stderr: string; code: number };
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      result = { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
      child.kill();
    }
    const fileCreated = await Bun.file(marker).exists();
    const contentMatches = !fileCreated || (await readFile(marker, "utf8")) === "Hello.";
    const receipts = (
      await readFile(join(project, ".turnstile/decisions.jsonl"), "utf8").catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const receipt = receipts.at(-1);
    const expectedHash = hash(
      requestSchema.parse(
        normalizeEndpointAction({
          harness: "opencode",
          sessionId: "unused",
          cwd: project,
          userGoal: goal,
          tool: "write",
          arguments: { filePath: marker, content: "Hello." },
        }),
      ),
    );
    const expectedVerdict = name === "observe" ? "review" : name === "deny" ? "deny" : "allow";
    const passed =
      !timedOut &&
      result.code === 0 &&
      toolCalls === 1 &&
      receipts.length === 1 &&
      fileCreated === (name !== "deny") &&
      contentMatches &&
      receipt?.verdict === expectedVerdict &&
      receipt?.requestHash === expectedHash &&
      (name !== "live" || receipt?.semantic === "evaluated");
    console.log(
      JSON.stringify({
        test: `OpenCode ${name}`,
        passed,
        fileCreated,
        toolCalls,
        verdict: receipt?.verdict,
        reasons: receipt?.reasons,
        trustedGoalMatched: receipt?.requestHash === expectedHash,
        model: receipt?.model,
        timedOut,
        exitCode: result.code,
      }),
    );
    if (!passed) {
      // All host inputs are synthetic; still redact the optional key from diagnostics.
      const key = process.env.TYPESAFE_API_KEY;
      const details = result.stderr + result.stdout;
      console.error((key ? details.replaceAll(key, "[REDACTED]") : details).slice(-4000));
      throw new Error(`OpenCode ${name} fixture failed`);
    }
  }
} finally {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
}
