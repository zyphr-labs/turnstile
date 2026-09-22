import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/endpoint";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function run(args: string[], input?: unknown) {
  const process = Bun.spawn([Bun.env.BUN_EXEC_PATH ?? Bun.which("bun") ?? "bun", cli, ...args], {
    stdin:
      input === undefined
        ? "ignore"
        : new Blob([typeof input === "string" ? input : JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, TYPESAFE_API_KEY: "" },
  });
  return {
    code: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}
async function fixture(mode: "observe" | "enforce" = "enforce") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "turnstile-cli-")));
  dirs.push(root);
  expect((await run(["init", "--project", root])).code).toBe(0);
  const configPath = join(root, ".turnstile/config.json");
  const config = defaultConfig(root);
  config.policy.mode = mode;
  await writeFile(configPath, JSON.stringify(config));
  return { root, configPath, event: { session_id: "test-session", cwd: root } };
}
test("init is observe-only, opt-in for cloud, and does not overwrite", async () => {
  const { root, configPath } = await fixture("observe");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  expect(config.jev.enabled).toBe(false);
  expect((await run(["init", "--project", root])).code).toBe(1);
  expect((await run(["claude-settings", "--config", configPath])).stdout).toContain("PreToolUse");
  expect(await Bun.file(join(root, ".claude/settings.json")).exists()).toBe(false);
});
test("real stdin/stdout hook denies sensitive files, asks for shell, cleans session", async () => {
  const { root, configPath, event } = await fixture();
  const args = ["hook", "--config", configPath];
  expect(
    (
      await run(args, {
        ...event,
        hook_event_name: "UserPromptSubmit",
        prompt: "Read the project note",
      })
    ).code,
  ).toBe(0);
  const deny = await run(args, {
    ...event,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, ".env") },
  });
  expect(deny.code).toBe(0);
  expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  const review = await run(args, {
    ...event,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
  });
  expect(JSON.parse(review.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  const audit = await readFile(join(root, ".turnstile/decisions.jsonl"), "utf8");
  expect(audit).not.toContain("echo hello");
  expect(audit).not.toContain("Read the project note");
  expect((await stat(join(root, ".turnstile/decisions.jsonl"))).mode & 0o777).toBe(0o600);
  await run(args, { ...event, hook_event_name: "SessionEnd" });
  expect(await readdir(join(root, ".turnstile/sessions"))).toEqual([]);
});
test("missing prompt and absent Jev ask rather than auto-approve", async () => {
  const { root, configPath, event } = await fixture();
  const result = await run(["hook", "--config", configPath], {
    ...event,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, "notes.txt") },
  });
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
});
test("observe emits no permission override even for a policy denial", async () => {
  const { root, configPath, event } = await fixture("observe");
  const result = await run(["hook", "--config", configPath], {
    ...event,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, ".env") },
  });
  expect(JSON.parse(result.stdout)).toEqual({});
});
test("malformed, oversized or unconfigured hooks exit 2 without reflecting input", async () => {
  for (const input of ["not json secret-value", "x".repeat(65000), {}]) {
    const result = await run(["hook", "--config", "/missing-turnstile-config"], input);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("secret-value");
  }
});
test("replay preserves hard denials and unavailable-model reviews", async () => {
  const { root, configPath, event } = await fixture();
  await run(["hook", "--config", configPath], {
    ...event,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, ".env") },
  });
  const result = await run([
    "replay",
    join(root, ".turnstile/decisions.jsonl"),
    "--review",
    "0.9",
    "--deny",
    "0.99",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).decisions[0].replayed).toBe("deny");
});

test("doctor distinguishes configured from observed adapter activity and never claims host execution", async () => {
  const { root, configPath, event } = await fixture();
  const empty = JSON.parse((await run(["doctor", "--config", configPath])).stdout);
  expect(empty.configured).toBe(true);
  expect(empty.evidence).toBe("no_decisions_observed");
  expect(empty.jev.credentialPresent).toBe(false);
  await run(["hook", "--config", configPath], {
    ...event,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, ".env") },
  });
  const populated = JSON.parse((await run(["doctor", "--config", configPath])).stdout);
  expect(populated.evidence).toBe("decisions_observed");
  expect(
    populated.observed.find((row: { harness: string }) => row.harness === "claude").decisions,
  ).toBe(1);
  expect(populated.hostLoaded).toBe("unknown");
  expect(populated.hostEnforcement).toBe("unknown");
  expect(populated.execution).toBe("unknown");
});

test("endpoint outcomes link decisions without raw session or tool identifiers and preserve replay", async () => {
  const { recordEndpointOutcome } = await import("../src/runtime");
  const { root, configPath, event } = await fixture();
  await run(["hook", "--config", configPath], {
    ...event,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, ".env") },
  });
  const decision = JSON.parse(
    (await readFile(join(root, ".turnstile/decisions.jsonl"), "utf8")).trim(),
  );
  const input = {
    harness: "pi" as const,
    cwd: root,
    configPath,
    sessionId: "synthetic-private-session",
    decisionId: decision.id,
    requestHash: decision.requestHash,
    toolCallId: "synthetic-private-tool-call",
    outcome: "blocked" as const,
    reason: "policy.denied",
  };
  await recordEndpointOutcome(input);
  const raw = await readFile(join(root, ".turnstile/outcomes.jsonl"), "utf8");
  expect(raw).not.toContain(input.sessionId);
  expect(raw).not.toContain(input.toolCallId);
  expect(JSON.parse(raw).decisionId).toBe(decision.id);
  await expect(
    recordEndpointOutcome({ ...input, reason: "raw error with private data" }),
  ).rejects.toThrow();
  expect((await run(["replay", join(root, ".turnstile/decisions.jsonl")])).code).toBe(0);
  const doctor = JSON.parse((await run(["doctor", "--config", configPath])).stdout);
  expect(
    doctor.observed.find((row: { harness: string }) => row.harness === "pi").outcomes.blocked,
  ).toBe(1);
});
