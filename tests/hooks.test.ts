import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/endpoint";
import { readGoal } from "../src/runtime";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function run(args: string[], input?: unknown) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TYPESAFE_API_KEY: "" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
async function fixture(mode: "enforce" | "observe" = "enforce") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "turnstile-hooks-")));
  dirs.push(root);
  expect((await run(["init", "--project", root])).code).toBe(0);
  const configPath = join(root, ".turnstile/config.json");
  const config = defaultConfig(root);
  config.policy.mode = mode;
  await writeFile(configPath, JSON.stringify(config));
  return { root, configPath };
}
test("Gemini protocol denies sensitive reads and review without unsupported ask", async () => {
  const { root, configPath } = await fixture();
  const args = ["hook", "--config", configPath, "--harness", "gemini"];
  const base = { session_id: "s", cwd: root };
  expect(
    (await run(args, { ...base, hook_event_name: "BeforeAgent", prompt: "Read notes" })).code,
  ).toBe(0);
  for (const [tool_name, tool_input] of [
    ["read_file", { file_path: join(root, ".env") }],
    ["run_shell_command", { command: "echo hello" }],
  ] as const) {
    const result = await run(args, {
      ...base,
      hook_event_name: "BeforeTool",
      tool_name,
      tool_input,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("deny");
  }
  const config = JSON.parse((await run(["gemini-settings", "--config", configPath])).stdout);
  expect(config.hooks.BeforeTool[0].hooks[0].timeout).toBe(15000);
  await run(args, { ...base, hook_event_name: "SessionEnd" });
  expect(await readGoal(configPath, "gemini", "s")).toBe("");
});
test("Cursor binds intent to generation and uses enforced deny for reviews", async () => {
  const { root, configPath } = await fixture();
  const args = ["hook", "--config", configPath, "--harness", "cursor"];
  const base = { conversation_id: "c", generation_id: "g1", workspace_roots: [root] };
  expect(
    JSON.parse(
      (await run(args, { ...base, hook_event_name: "beforeSubmitPrompt", prompt: "Read notes" }))
        .stdout,
    ).continue,
  ).toBe(true);
  expect(await readGoal(configPath, "cursor", "c", "g1")).toBe("Read notes");
  expect(await readGoal(configPath, "cursor", "c", "g2")).toBe("");
  const result = await run(args, {
    ...base,
    hook_event_name: "preToolUse",
    cwd: root,
    tool_name: "Shell",
    tool_input: { command: "echo hello" },
  });
  expect(JSON.parse(result.stdout).permission).toBe("deny");
  expect(result.stdout).not.toContain('"ask"');
  const config = JSON.parse((await run(["cursor-settings", "--config", configPath])).stdout);
  expect(config.hooks.preToolUse[0].failClosed).toBe(true);
  expect(config.version).toBe(1);
});
test("observe protocol permits actions and receipts identify each harness", async () => {
  const { root, configPath } = await fixture("observe");
  const gemini = await run(["hook", "--config", configPath, "--harness", "gemini"], {
    session_id: "same",
    cwd: root,
    hook_event_name: "BeforeTool",
    tool_name: "read_file",
    tool_input: { file_path: join(root, ".env") },
  });
  const cursor = await run(["hook", "--config", configPath, "--harness", "cursor"], {
    conversation_id: "same",
    generation_id: "g",
    workspace_roots: [root],
    hook_event_name: "preToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, ".env") },
  });
  expect(JSON.parse(gemini.stdout)).toEqual({});
  expect(JSON.parse(cursor.stdout)).toEqual({ permission: "allow" });
  const audit = (await readFile(join(root, ".turnstile/decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(audit.map((d) => d.harness)).toEqual(["gemini", "cursor"]);
  expect(audit[0].sessionHash).not.toBe(audit[1].sessionHash);
  expect((await run(["replay", join(root, ".turnstile/decisions.jsonl")])).code).toBe(0);
});
test("invalid host schemas and unsupported harness fail as blocking protocol errors", async () => {
  const { root, configPath } = await fixture();
  for (const harness of ["cursor", "gemini", "not-a-host"]) {
    const r = await run(["hook", "--config", configPath, "--harness", harness], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  }
});

test("Gemini path correction cannot choose a target outside the checked argument", async () => {
  const { root, configPath } = await fixture();
  for (const file_path of ["notes.txt", "@notes.txt"]) {
    const result = await run(["hook", "--config", configPath, "--harness", "gemini"], {
      session_id: "s",
      cwd: root,
      hook_event_name: "BeforeTool",
      tool_name: "read_file",
      tool_input: { file_path },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("deny");
  }
  const receipts = (await readFile(join(root, ".turnstile/decisions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    receipts.every(
      (receipt) =>
        receipt.hard.verdict === "deny" && receipt.hard.reasons.includes("endpoint.invalid_path"),
    ),
  ).toBe(true);
});
