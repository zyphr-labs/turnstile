import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/endpoint";

// Opt-in: invokes the locally installed Claude Code and consumes model usage.
if (!process.env.TYPESAFE_API_KEY || !Bun.which("claude"))
  throw new Error("Claude Code and TYPESAFE_API_KEY are required");
const root = await realpath(await mkdtemp(join(tmpdir(), "turnstile-host-")));
const cli = resolve(import.meta.dir, "../src/cli.ts");
const spawn = async (command: string[], cwd = root) => {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
};
try {
  const initialized = await spawn([process.execPath, cli, "init", "--project", root]);
  if (initialized.code) throw new Error("Could not initialize isolated fixture");
  const configPath = join(root, ".turnstile/config.json");
  const settings = await spawn([process.execPath, cli, "claude-settings", "--config", configPath]);
  if (settings.code) throw new Error("Could not generate scoped hooks");
  const settingsPath = join(root, "hooks.json");
  await writeFile(settingsPath, settings.stdout);
  const config = defaultConfig(root);
  config.policy.mode = "enforce";
  config.jev.enabled = true;
  config.jev.timeoutMs = 10000;
  for (const effect of ["allow", "deny"] as const) {
    config.policy.tools.Write = { effect };
    await writeFile(configPath, JSON.stringify(config));
    const marker = join(root, `${effect}.txt`);
    const result = await spawn([
      "claude",
      "--print",
      "--model",
      "haiku",
      "--max-budget-usd",
      "0.50",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--settings",
      settingsPath,
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--tools",
      "Write",
      "--allowedTools",
      "Write",
      "--output-format",
      "json",
      "--system-prompt",
      "You are testing a file-writing integration in an isolated temporary directory. Use only the supplied Write tool. If it is denied, stop and report the denial. Never try alternate methods.",
      `Use Write once to create ${marker} with exactly the content Hello. Then stop.`,
    ]);
    const exists = await Bun.file(marker).exists();
    const receipts = (
      await readFile(join(root, ".turnstile/decisions.jsonl"), "utf8").catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const last = receipts.at(-1);
    const passed =
      result.code === 0 &&
      exists === (effect === "allow") &&
      last?.verdict === effect &&
      (effect === "deny" || last?.semantic === "evaluated");
    console.log(
      JSON.stringify({
        test: `Claude Code ${effect}`,
        passed,
        exitCode: result.code,
        fileCreated: exists,
        verdict: last?.verdict,
        model: last?.model,
      }),
    );
    if (!passed) {
      // Synthetic fixture output only; provider keys are never sent in prompts.
      console.error(
        "Host integration did not meet the expected outcome. Check Claude authentication and hook support.",
      );
      console.error(
        (result.stderr || result.stdout)
          .replaceAll(process.env.TYPESAFE_API_KEY ?? "unused", "[REDACTED]")
          .slice(0, 3000),
      );
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
