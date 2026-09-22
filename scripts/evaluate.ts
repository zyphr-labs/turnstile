import { createHash } from "node:crypto";
import { CORPUS_VERSION, corpus, type EvaluationCase, evaluationPolicy } from "../evals/corpus";
import {
  createGuard,
  createJevJudge,
  type Decision,
  type Judge,
  MODEL,
  type Verdict,
} from "../src/index";

type Row = Pick<EvaluationCase, "id" | "split" | "label" | "category"> & {
  policyOnly: Verdict;
  final: Verdict;
  semantic: Decision["semantic"];
  latencyMs: number;
  inputTokens: number;
  providerFailure?: string;
  evidenceStatus?: Decision["evidenceStatus"];
  evaluatorVersion?: string;
  evaluatorHash?: string;
  model?: string;
};

function ratio(count: number, total: number) {
  return { count, total, rate: total ? count / total : null };
}

export function outcomeMetrics(rows: Row[], field: "policyOnly" | "final") {
  const legitimate = rows.filter((row) => row.label === "legitimate");
  const unwanted = rows.filter((row) => row.label === "unwanted");
  const ambiguous = rows.filter((row) => row.label === "ambiguous");
  return {
    cases: rows.length,
    missedViolations: ratio(
      unwanted.filter((row) => row[field] === "allow").length,
      unwanted.length,
    ),
    unwantedReviewed: ratio(
      unwanted.filter((row) => row[field] === "review").length,
      unwanted.length,
    ),
    unwantedDenied: ratio(unwanted.filter((row) => row[field] === "deny").length, unwanted.length),
    benignBlocks: ratio(
      legitimate.filter((row) => row[field] === "deny").length,
      legitimate.length,
    ),
    benignReviews: ratio(
      legitimate.filter((row) => row[field] === "review").length,
      legitimate.length,
    ),
    benignAllowed: ratio(
      legitimate.filter((row) => row[field] === "allow").length,
      legitimate.length,
    ),
    ambiguous: {
      count: ambiguous.length,
      allowed: ambiguous.filter((row) => row[field] === "allow").length,
    },
  };
}

// Nearest-rank percentiles. No observations returns null, never zero latency.
export function percentile(values: number[], percentage: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)] ?? null;
}

export async function evaluate(options: {
  mode: "offline" | "live";
  judge?: Judge;
  cases?: EvaluationCase[];
}) {
  if (options.mode === "live" && !options.judge)
    throw new Error("Live evaluation requires a judge.");
  const cases = options.cases ?? corpus;
  const rows: Row[] = [];
  for (const fixture of cases) {
    const judge: Judge =
      options.judge ??
      (async () => ({
        model: "offline-fixture",
        inputTokens: 0,
        scores: structuredClone(fixture.fixtureScores),
      }));
    const decision = await createGuard({ policy: evaluationPolicy, judge }).check(fixture.request);
    rows.push({
      id: fixture.id,
      split: fixture.split,
      label: fixture.label,
      category: fixture.category,
      policyOnly: decision.hard.verdict,
      final: decision.verdict,
      semantic: decision.semantic,
      latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens ?? 0,
      ...(decision.evidenceStatus ? { evidenceStatus: decision.evidenceStatus } : {}),
      ...(decision.model ? { model: decision.model } : {}),
      ...(decision.evaluatorVersion ? { evaluatorVersion: decision.evaluatorVersion } : {}),
      ...(decision.evaluatorHash ? { evaluatorHash: decision.evaluatorHash } : {}),
      ...(decision.semantic === "unavailable"
        ? {
            providerFailure: decision.semanticFailure ?? "unknown",
          }
        : {}),
    });
  }
  const splitReport = (split: EvaluationCase["split"]) => {
    const subset = rows.filter((row) => row.split === split);
    const assessed = subset.filter((row) => row.semantic === "evaluated");
    const failures = subset.filter((row) => row.semantic === "unavailable");
    return {
      policyOnly: outcomeMetrics(subset, "policyOnly"),
      finalOutcomes: outcomeMetrics(subset, "final"),
      // Fail-closed provider errors are interruptions, not successful semantic detections.
      semanticCompleted: {
        policyOnly: outcomeMetrics(assessed, "policyOnly"),
        policyPlusJev: outcomeMetrics(assessed, "final"),
      },
      providerFailures: {
        count: failures.length,
        categories: Object.fromEntries(
          [...new Set(failures.map((row) => row.providerFailure))].map((category) => [
            category,
            failures.filter((row) => row.providerFailure === category).length,
          ]),
        ),
      },
      semanticSkipped: subset.filter((row) => row.semantic === "skipped").length,
      guardLatencyMs: {
        p50: percentile(
          subset.map((row) => row.latencyMs),
          50,
        ),
        p95: percentile(
          subset.map((row) => row.latencyMs),
          95,
        ),
      },
      semanticCompletedLatencyMs: {
        p50: percentile(
          assessed.map((row) => row.latencyMs),
          50,
        ),
        p95: percentile(
          assessed.map((row) => row.latencyMs),
          95,
        ),
      },
      inputTokens: subset.reduce((total, row) => total + row.inputTokens, 0),
    };
  };
  return {
    reportVersion: 1,
    corpusVersion: CORPUS_VERSION,
    corpusHash: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
    policyHash: createHash("sha256").update(JSON.stringify(evaluationPolicy)).digest("hex"),
    generatedAt: new Date().toISOString(),
    runtime: Bun.version,
    mode: options.mode,
    model: options.mode === "live" ? MODEL : "offline-fixture",
    thresholds: evaluationPolicy.thresholds,
    interpretation:
      options.mode === "offline"
        ? "Fixed fixture scores validate report plumbing only. These are not model accuracy measurements."
        : "One synthetic sample per case. This small corpus cannot establish production accuracy or task completion.",
    definitions: {
      policyOnly:
        "Deterministic hard verdict from the same check, before missing-context and semantic handling.",
      benignBlocks:
        "Legitimate actions denied. Benign reviews are separate and also interrupt enforced SDK execution.",
      semanticCompleted:
        "Only cases with a successful judgment; provider errors cannot count as semantic detections.",
      ambiguous: "Incomplete authorization context; excluded from legitimate and unwanted rates.",
      latency:
        "Sequential whole-guard check latency, including provider time when invoked. Nearest-rank percentiles.",
      split:
        "Fixed calibration and held-out groups. Thresholds are unchanged; do not tune them using held-out results.",
      scope:
        "No proposed action is executed. This measures SDK decisions, not adapter coverage or completed coding tasks.",
    },
    splits: { calibration: splitReport("calibration"), heldOut: splitReport("held-out") },
    rows,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--live") || args.length > 1) {
    console.error("Usage: bun run scripts/evaluate.ts [--live]");
    process.exitCode = 1;
  } else {
    const live = args.includes("--live");
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (live && !apiKey) {
      console.error("Set TYPESAFE_API_KEY for opt-in synthetic live evaluation.");
      process.exitCode = 1;
    } else {
      const report = await evaluate({
        mode: live ? "live" : "offline",
        ...(live && apiKey ? { judge: createJevJudge({ apiKey, timeoutMs: 10000 }) } : {}),
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.rows.some((row) => row.semantic === "unavailable")) process.exitCode = 1;
    }
  }
}
