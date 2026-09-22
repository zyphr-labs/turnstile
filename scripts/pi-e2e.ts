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
let pilot = false;
let pilotStep = 0;
let pilotActions: { name: string; arguments: Record<string, unknown> }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Not found", { status: 404 });
    if (++requests > (pilot ? 12 : 3))
      return new Response("Fixture request limit exceeded", { status: 429 });
    const payload = (await request.json()) as { messages?: { role?: string }[] };
    const action = pilot ? pilotActions[pilotStep++] : undefined;
    const finished = pilot ? !action : payload.messages?.some((message) => message.role === "tool");
    const delta = finished
      ? { role: "assistant", content: "Integration fixture complete." }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: pilot ? `pilot_call_${requests}` : "turnstile_fixture_write",
              type: "function",
              function: action
                ? { name: action.name, arguments: JSON.stringify(action.arguments) }
                : { name: "write", arguments: JSON.stringify({ path: marker, content }) },
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
  const cases = ["observe", "deny", "review", ...(live ? ["allow"] : [])] as const;
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
      (["deny", "review"].includes(name) ? actual === undefined : actual === content) &&
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
  if (!process.exitCode) await runPilot();
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}

async function runPilot() {
  pilot = true;
  requests = 0;
  const cwd = join(root, "pilot");
  const agentDir = join(cwd, "pi-home");
  await mkdir(join(cwd, ".turnstile"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const config = defaultConfig(cwd);
  config.policy.mode = "enforce";
  config.jev.enabled = false;
  await writeFile(join(cwd, ".turnstile/config.json"), JSON.stringify(config));
  await writeFile(join(cwd, "add.ts"), "export const add = (a: number, b: number) => a - b;\n");
  await writeFile(
    join(cwd, "add.test.ts"),
    'import { expect, test } from "bun:test";\nimport { add } from "./add";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n',
  );
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
  const child = Bun.spawn(
    [
      pi as string,
      "--offline",
      "--mode",
      "rpc",
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
      "read,edit,bash",
      "-e",
      extension,
    ],
    {
      cwd,
      env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const phases = [
    {
      goal: "Fix add.ts so add returns the sum. Do not edit add.test.ts or any other files.",
      actions: [
        { name: "read", arguments: { path: "add.ts" } },
        {
          name: "edit",
          // Pi 0.85 accepts this shape; 0.86 prepares it as a batch before the hook.
          arguments: { path: "add.ts", oldText: "a - b", newText: "a + b" },
        },
      ],
    },
    {
      goal: "Now run the tests.",
      actions: [{ name: "bash", arguments: { command: "bun test add.test.ts" } }],
    },
    {
      goal: "Ask before creating rejected.txt. I will reject the action.",
      actions: [{ name: "bash", arguments: { command: "touch rejected.txt" } }],
    },
  ];
  let phase = 0;
  let confirmations = 0;
  let completed = false;
  const toolResults: { toolName: string; isError: boolean; result: unknown }[] = [];
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const startPhase = () => {
    pilotStep = 0;
    pilotActions = phases[phase]?.actions ?? [];
    send({ id: `pilot-${phase}`, type: "prompt", message: phases[phase]?.goal });
  };
  const timeout = setTimeout(() => child.kill(), 30000);
  const stderrPromise = new Response(child.stderr).text();
  try {
    startPhase();
    let buffer = "";
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "response" && event.success === false)
          throw new Error(`Pi RPC command failed: ${event.command}`);
        if (event.type === "extension_error") throw new Error("Pi extension error");
        if (event.type === "extension_ui_request" && event.method === "confirm") {
          if (!event.message?.includes("Request:") || !event.message?.includes("Arguments:"))
            throw new Error("Pi confirmation omitted exact action");
          confirmations++;
          send({ type: "extension_ui_response", id: event.id, confirmed: phase !== 2 });
        }
        if (event.type === "tool_execution_end") toolResults.push(event);
        if (event.type === "agent_settled") {
          if (++phase < phases.length) startPhase();
          else {
            completed = true;
            child.kill();
          }
        }
      }
    }
    await child.exited;
    const decisions = (await readFile(join(cwd, ".turnstile/decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const outcomes = (await readFile(join(cwd, ".turnstile/outcomes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const testResult = toolResults.find((entry) => entry.toolName === "bash" && !entry.isError);
    const combinedGoal = `Direct user instructions in chronological order. Preserve earlier restrictions unless the user explicitly changes them.\n[1] ${phases[0]?.goal}\n\n[2] ${phases[1]?.goal}`;
    const testRequestHash = hash(
      requestSchema.parse(
        normalizeEndpointAction({
          harness: "pi",
          sessionId: "unused",
          cwd,
          userGoal: combinedGoal,
          tool: "bash",
          arguments: { command: "bun test add.test.ts" },
        }),
      ),
    );
    const passed =
      completed &&
      confirmations === 4 &&
      requests === 7 &&
      decisions.length === 4 &&
      decisions.every((decision) => decision.verdict === "review" && decision.enforced) &&
      decisions[2]?.requestHash === testRequestHash &&
      (await readFile(join(cwd, "add.ts"), "utf8")).includes("a + b") &&
      (await readFile(join(cwd, "rejected.txt"), "utf8").catch(() => undefined)) === undefined &&
      toolResults.length === 4 &&
      toolResults.slice(0, 3).every((entry) => !entry.isError) &&
      toolResults[3]?.isError === true &&
      JSON.stringify(testResult?.result ?? "").includes("1 pass") &&
      outcomes.filter((entry) => entry.outcome === "approved").length === 3 &&
      outcomes.filter((entry) => entry.outcome === "released").length === 3 &&
      outcomes.filter((entry) => entry.outcome === "rejected").length === 1 &&
      outcomes.filter((entry) => entry.outcome === "blocked").length === 1;
    console.log(
      JSON.stringify({
        test: "Pi enforced RPC read/edit/test pilot",
        passed,
        confirmations,
        localModelRequests: requests,
        decisions: decisions.length,
        originalRestrictionsPreserved: decisions[2]?.requestHash === testRequestHash,
        testPassed: JSON.stringify(testResult?.result ?? "").includes("1 pass"),
        rejectedActionBlocked: toolResults[3]?.isError === true,
        outcomes: outcomes.map((entry) => entry.outcome),
        toolResults: toolResults.map((entry) => ({
          toolName: entry.toolName,
          isError: entry.isError,
        })),
      }),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    const stderr = await stderrPromise;
    if (!completed && stderr) console.error(stderr.slice(0, 1500));
  }
}
