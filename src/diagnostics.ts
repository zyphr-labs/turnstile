import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { configSchema } from "./endpoint";
import { loadEndpoint } from "./runtime";
import { decisionSchema } from "./schema";
import { readBounded, retention } from "./storage";

const outcomeSchema = z.object({
  harness: z.enum(["claude", "opencode", "pi", "gemini", "cursor"]),
  timestamp: z.string().datetime(),
  outcome: z.enum(["approved", "rejected", "blocked", "released", "unknown"]),
});

export async function diagnoseEndpoint(configPath: string) {
  const path = resolve(configPath);
  const directory = dirname(path);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid storage directory");
  const parsed = configSchema.parse(JSON.parse(await readBounded(path)));
  const config = await loadEndpoint(path, parsed.root);
  const warnings: string[] = [];
  const locks: string[] = [];
  for (const name of ["decisions.jsonl.lock", "outcomes.jsonl.lock", "sessions.lock"]) {
    try {
      await lstat(join(directory, name));
      locks.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push("lock_status_unreadable");
    }
  }
  const decisions: z.infer<typeof decisionSchema>[] = [];
  const outcomes: z.infer<typeof outcomeSchema>[] = [];
  for (const name of ["decisions.jsonl", "outcomes.jsonl"]) {
    for (let index = 0; index <= retention.auditArchives; index++) {
      const file = join(directory, index ? `${name}.${index}` : name);
      try {
        const stat = await lstat(file);
        if (!stat.isFile()) throw new Error("Invalid audit file");
        if (stat.size > retention.auditBytes) {
          warnings.push(`${name}.migration_pending`);
          continue;
        }
        if (Date.now() - stat.mtimeMs > retention.auditAgeMs) continue;
        const lines = (await readBounded(file, retention.auditBytes)).split("\n").filter(Boolean);
        for (const line of lines) {
          if (name === "decisions.jsonl") {
            const decision = decisionSchema.parse(JSON.parse(line));
            if (Date.parse(decision.timestamp) >= Date.now() - retention.auditAgeMs)
              decisions.push(decision);
          } else {
            const outcome = outcomeSchema.parse(JSON.parse(line));
            if (Date.parse(outcome.timestamp) >= Date.now() - retention.auditAgeMs)
              outcomes.push(outcome);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${name}.unreadable`);
      }
    }
  }
  const observed = ["claude", "opencode", "pi", "gemini", "cursor"].map((harness) => {
    const checks = decisions.filter((decision) => decision.harness === harness);
    const events = outcomes.filter((outcome) => outcome.harness === harness);
    return {
      harness,
      decisions: checks.length,
      latestDecisionAt:
        checks
          .map((decision) => decision.timestamp)
          .sort()
          .at(-1) ?? null,
      enforceDecisions: checks.filter((decision) => decision.mode === "enforce").length,
      outcomes: Object.fromEntries(
        ["approved", "rejected", "blocked", "released", "unknown"].map((outcome) => [
          outcome,
          events.filter((event) => event.outcome === outcome).length,
        ]),
      ),
    };
  });
  return {
    configured: true,
    mode: config.policy.mode,
    jev: {
      enabled: config.jev.enabled,
      credentialPresent: Boolean(process.env.TYPESAFE_API_KEY),
      connectivity: "not_checked",
    },
    evidence: decisions.length ? "decisions_observed" : "no_decisions_observed",
    observed,
    hostLoaded: "unknown",
    hostEnforcement: "unknown",
    execution: "unknown",
    retention,
    locks,
    warnings: [...new Set(warnings)],
    notes: [
      "Local receipts show adapter activity, not proof that a host is currently loaded or enforced an action.",
      "Released means the adapter returned control; execution remains unverified.",
      "Retention is applied on audit append and session access, not by a background service.",
      ...(locks.length
        ? [
            "A lock may belong to an active writer. Stop all hooks before removing a leftover empty lock directory.",
          ]
        : []),
    ],
  };
}
