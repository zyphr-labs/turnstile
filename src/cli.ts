#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claudeHook } from "./claude";
import { defaultConfig } from "./endpoint";
import { combine } from "./guard";
import { decisionSchema, thresholdsSchema } from "./schema";
import { readBounded } from "./storage";

const args = process.argv.slice(2);
const command = args.shift();
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("Missing option value");
  args.splice(index, 2);
  return value;
}
function noExtras() {
  if (args.length) throw new Error("Unknown argument");
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64000) throw new Error("Hook input exceeds limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (!command || command === "--help" || command === "help") {
    console.log(
      `Turnstile 0.1.0-alpha.1\n\n  init --project PATH       Create observe-only config; no host settings changed\n  claude-settings --config PATH\n                           Print hook settings to merge or pass to claude --settings\n  hook --config PATH       Handle Claude Code hook JSON on stdin\n  replay FILE [--review N] [--deny N]\n                           Recompute semantic thresholds from metadata-only audit\n\nJev is opt-in in config.json and requires TYPESAFE_API_KEY.\nSee docs/claude-code.md for scoped installation and removal.`,
    );
    return;
  }
  if (command === "init") {
    const project = option("--project");
    noExtras();
    if (!project) throw new Error("--project required");
    const root = await realpath(resolve(project));
    const dir = join(root, ".turnstile");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "config.json"), `${JSON.stringify(defaultConfig(root), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      `Created ${join(dir, "config.json")} in observe mode. Jev is disabled. Add .turnstile/ to your project's ignore file.`,
    );
    return;
  }
  if (command === "claude-settings") {
    const config = option("--config");
    noExtras();
    if (!config || !existsSync(config)) throw new Error("Existing --config required");
    const hook = `${quote(process.execPath)} ${quote(resolve(import.meta.dir, "cli.ts"))} hook --config ${quote(resolve(config))}`;
    console.log(
      JSON.stringify(
        {
          hooks: Object.fromEntries(
            ["UserPromptSubmit", "PreToolUse", "SessionEnd"].map((event) => [
              event,
              [{ hooks: [{ type: "command", command: hook, timeout: 15 }] }],
            ]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "hook") {
    const config = option("--config");
    noExtras();
    if (!config) throw new Error("--config required");
    // Exit before the host timeout, which can otherwise let the tool continue.
    const deadline = setTimeout(() => {
      console.error("Turnstile hook timed out; action blocked.");
      process.exit(2);
    }, 12000);
    try {
      console.log(
        JSON.stringify(
          await claudeHook(
            JSON.parse(await stdin()),
            resolve(config),
            process.env.TYPESAFE_API_KEY,
          ),
        ),
      );
    } finally {
      clearTimeout(deadline);
    }
    return;
  }
  if (command === "replay") {
    const review = option("--review"),
      deny = option("--deny");
    const file = args.shift();
    noExtras();
    if (!file) throw new Error("Audit file required");
    const thresholds = thresholdsSchema.parse({
      review: review === undefined ? 0.35 : Number(review),
      deny: deny === undefined ? 0.85 : Number(deny),
    });
    const decisions = (await readBounded(resolve(file), 16 * 1024 * 1024))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => decisionSchema.parse(JSON.parse(line)));
    const rows = decisions.map((d) => ({
      id: d.id,
      previous: d.verdict,
      replayed:
        d.semantic === "evaluated" && d.scores
          ? combine(d.hard, d.scores, thresholds).verdict
          : d.verdict,
    }));
    console.log(
      JSON.stringify(
        {
          thresholds,
          total: rows.length,
          changed: rows.filter((row) => row.previous !== row.replayed).length,
          decisions: rows,
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("Unknown command");
}

main().catch(() => {
  // Avoid echoing malformed input, paths, provider bodies or credentials into host logs.
  console.error(
    command === "hook"
      ? "Turnstile could not evaluate this action. Check configuration and audit storage; action blocked."
      : "Turnstile failed. Check arguments, file permissions and configuration. Run --help for usage.",
  );
  process.exitCode = command === "hook" ? 2 : 1;
});
