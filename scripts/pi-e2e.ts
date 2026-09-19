import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/endpoint";
import { hash } from "../src/guard";
import { normalizeEndpointAction } from "../src/runtime";
import { requestSchema } from "../src/schema";

// Uses the real Pi CLI and a loopback fixture model. No external model credentials required.
// --live adds a Jev-approved enforcement case using TYPESAFE_API_KEY from the environment.
const pi = Bun.which("pi");
if (!pi) throw new Error("Install Pi before running this opt-in host integration check.");
const live = process.argv.includes("--live");
if (live && !process.env.TYPESAFE_API_KEY) throw new Error("--live requires TYPESAFE_API_KEY.");
const root = await realpath(await mkdtemp(join(tmpdir(), "turnstile-pi-e2e-")));
const extension = resolve(import.meta.dir, "../src/adapters/pi.ts");
const content = "Hello from the Turnstile Pi integration test.\n";
let marker = "";
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Not found", { status: 404 });
    if (++requests > 3) return new Response("Fixture request limit exceeded", { status: 429 });
    const payload = (await request.json()) as { messages?: { role?: string }[] };
    const finished = payload.messages?.some((message) => message.role === "tool");
    const delta = finished
      ? { role: "assistant", content: "Integration fixture complete." }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "turnstile_fixture_write",
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: marker, content }) },
            },
          ],
        };
    const chunk = (value: unknown) =>
      `data: ${JSON.stringify({ id: "turnstile_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", ...(value as object) })}\n\n`;
    return new Response(
      chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
    );
  },
});

try {
  const cases = ["observe", "deny", ...(live ? ["allow"] : [])] as const;
  for (const name of cases) {
    requests = 0;
    const cwd = join(root, name);
    const agentDir = join(cwd, "pi-home");
    await mkdir(join(cwd, ".turnstile"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    marker = join(cwd, "marker.txt");
    const config = defaultConfig(cwd);
    config.policy.mode = name === "observe" ? "observe" : "enforce";
    config.policy.tools.Write = { effect: name === "deny" ? "deny" : "allow" };
    config.jev.enabled = name === "allow";
    config.jev.timeoutMs = 10000;
    await writeFile(join(cwd, ".turnstile/config.json"), JSON.stringify(config));
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "turnstile-fixture": {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: "openai-completions",
            apiKey: "synthetic-local-fixture",
            models: [{ id: "fixture", reasoning: false, contextWindow: 32000, maxTokens: 2048 }],
          },
        },
      }),
    );
    const goal = `Use write once to create ${marker} with exactly this content: ${content}Then stop.`;
    const child = Bun.spawn(
      [
        pi,
        "--offline",
        "--print",
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--no-approve",
        "--provider",
        "turnstile-fixture",
        "--model",
        "fixture",
        "--tools",
        "write",
        "-e",
        extension,
        goal,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          ...(name === "allow" ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY } : {}),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 30000);
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
    }
    const actual = await readFile(marker, "utf8").catch(() => undefined);
    const receipts = (
      await readFile(join(cwd, ".turnstile/decisions.jsonl"), "utf8").catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const decision = receipts[0];
    const expectedVerdict = name === "observe" ? "review" : name;
    const expectedHash = hash(
      requestSchema.parse(
        normalizeEndpointAction({
          harness: "pi",
          sessionId: "unused",
          cwd,
          userGoal: goal,
          tool: "write",
          arguments: { path: marker, content },
        }),
      ),
    );
    const passed =
      result.code === 0 &&
      requests === 2 &&
      receipts.length === 1 &&
      decision?.harness === "pi" &&
      decision?.verdict === expectedVerdict &&
      decision?.requestHash === expectedHash &&
      (name === "deny" ? actual === undefined : actual === content) &&
      (name !== "allow" || decision?.semantic === "evaluated");
    console.log(
      JSON.stringify({
        test: `Pi ${name}`,
        passed,
        exitCode: result.code,
        localModelRequests: requests,
        fileCreated: actual !== undefined,
        verdict: decision?.verdict,
        semantic: decision?.semantic,
        trustedGoalMatched: decision?.requestHash === expectedHash,
      }),
    );
    if (!passed) {
      const key = process.env.TYPESAFE_API_KEY;
      const diagnostic = result.stderr || result.stdout;
      console.error((key ? diagnostic.replaceAll(key, "[REDACTED]") : diagnostic).slice(0, 3000));
      process.exitCode = 1;
      break;
    }
  }
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
