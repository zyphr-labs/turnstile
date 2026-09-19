import { createHash, randomUUID } from "node:crypto";
import { type Judge, judgmentSchema } from "./jev";
import {
  type ActionRequest,
  type CheckedRequest,
  type Decision,
  type HardDecision,
  type Policy,
  policySchema,
  requestSchema,
  type Scores,
  scoresSchema,
  thresholdsSchema,
  type Verdict,
} from "./schema";

const rank: Record<Verdict, number> = { allow: 0, review: 1, deny: 2 };
export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function combine(
  hard: HardDecision,
  scores: Scores | undefined,
  thresholds: { review: number; deny: number },
): HardDecision {
  thresholdsSchema.parse(thresholds);
  if (!scores) return hard;
  scoresSchema.parse(scores);
  let verdict = hard.verdict;
  const reasons = [...hard.reasons];
  for (const [dimension, score] of Object.entries(scores)) {
    const next =
      score >= thresholds.deny ? "deny" : score >= thresholds.review ? "review" : "allow";
    if (next !== "allow") reasons.push(`semantic.${dimension}.${next}`);
    if (rank[next] > rank[verdict]) verdict = next;
  }
  return { verdict, reasons };
}

export class ActionBlocked extends Error {
  constructor(public readonly decision: Decision) {
    super(`Turnstile: ${decision.verdict} (${decision.reasons.join(", ")})`);
  }
}

export function createGuard(options: {
  policy: Policy;
  judge?: Judge;
  authorize?: (request: CheckedRequest) => Promise<HardDecision>;
  audit?: (decision: Decision) => Promise<void>;
}) {
  // Detach configuration from caller mutation.
  const policy = policySchema.parse(structuredClone(options.policy));
  async function check(input: ActionRequest): Promise<Decision> {
    const start = performance.now();
    const request = requestSchema.parse(structuredClone(input));
    if (Buffer.byteLength(JSON.stringify(request)) > 64000)
      throw new Error("Action exceeds 64 KB limit");
    const rule = Object.hasOwn(policy.tools, request.tool) ? policy.tools[request.tool] : undefined;
    let hard: HardDecision = {
      verdict: rule?.effect ?? policy.unknownTool,
      reasons: [rule ? `policy.${rule.effect}` : "policy.unknown_tool"],
    };
    if (
      rule?.argumentEquals &&
      Object.entries(rule.argumentEquals).some(
        ([key, value]) =>
          !Object.hasOwn(request.arguments, key) || request.arguments[key] !== value,
      )
    )
      hard = { verdict: "deny", reasons: ["policy.argument_mismatch"] };
    if (options.authorize) {
      try {
        const extra = await options.authorize(structuredClone(request));
        if (
          !Object.hasOwn(rank, extra.verdict) ||
          !Array.isArray(extra.reasons) ||
          !extra.reasons.every((r) => typeof r === "string")
        )
          throw new Error("Invalid authorization result");
        if (rank[extra.verdict] > rank[hard.verdict]) hard.verdict = extra.verdict;
        hard.reasons.push(...extra.reasons);
      } catch {
        hard = { verdict: "deny", reasons: ["policy.authorization_error"] };
      }
    }
    let semantic: Decision["semantic"] = "skipped";
    let judgment: Awaited<ReturnType<Judge>> | undefined;
    let result = hard;
    if (hard.verdict === "allow") {
      if (!request.userGoal.trim()) {
        result = { verdict: "review", reasons: [...hard.reasons, "context.missing_goal"] };
      } else if (!options.judge) {
        semantic = "disabled";
        result = { verdict: "review", reasons: [...hard.reasons, "semantic.disabled"] };
      } else {
        try {
          judgment = judgmentSchema.parse(await options.judge(structuredClone(request)));
          semantic = "evaluated";
          result = combine(hard, judgment.scores, policy.thresholds);
        } catch {
          judgment = undefined;
          semantic = "unavailable";
          result = { verdict: "review", reasons: [...hard.reasons, "semantic.unavailable"] };
        }
      }
    }
    const decision: Decision = {
      version: 1,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      policyHash: hash(policy),
      requestHash: hash(request),
      mode: policy.mode,
      verdict: result.verdict,
      enforced: policy.mode === "enforce" && result.verdict !== "allow",
      hard,
      reasons: result.reasons,
      semantic,
      ...(judgment
        ? { scores: judgment.scores, model: judgment.model, inputTokens: judgment.inputTokens }
        : {}),
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
    };
    if (options.audit) await options.audit(structuredClone(decision));
    return decision;
  }
  async function execute<T>(
    request: ActionRequest,
    run: (args: CheckedRequest["arguments"]) => Promise<T>,
  ): Promise<{ decision: Decision; value: T }> {
    // The executor gets the same snapshot that was checked, even if the caller mutates its original.
    const snapshot = requestSchema.parse(structuredClone(request));
    const decision = await check(snapshot);
    if (decision.enforced) throw new ActionBlocked(decision);
    return { decision, value: await run(structuredClone(snapshot.arguments)) };
  }
  return { check, execute };
}
