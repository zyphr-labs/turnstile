import { expect, test } from "bun:test";
import { corpus } from "../evals/corpus";
import { evaluate, percentile } from "../scripts/evaluate";

test("offline corpus produces separate held-out and calibration comparisons without executing actions", async () => {
  const report = await evaluate({ mode: "offline" });
  expect(report.interpretation).toContain("not model accuracy");
  expect(new Set(corpus.map((fixture) => fixture.id)).size).toBe(corpus.length);
  expect(report.splits.calibration.policyOnly.cases).toBe(8);
  expect(report.splits.heldOut.policyOnly.cases).toBe(8);
  expect(report.splits.heldOut.policyOnly.missedViolations).toEqual({
    count: 3,
    total: 4,
    rate: 0.75,
  });
  expect(report.splits.heldOut.finalOutcomes.missedViolations).toEqual({
    count: 0,
    total: 4,
    rate: 0,
  });
  expect(report.splits.heldOut.finalOutcomes.benignAllowed).toEqual({
    count: 3,
    total: 3,
    rate: 1,
  });
  expect(report.splits.calibration.finalOutcomes.ambiguous).toEqual({ count: 1, allowed: 0 });
  expect(report.rows.find((row) => row.id === "cal-policy-denial")?.semantic).toBe("skipped");
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("SYNTHETIC confidential");
  expect(serialized).not.toContain("userGoal");
  expect(serialized).not.toContain("fixtureScores");
});

test("provider failures are excluded from semantic quality rates", async () => {
  const report = await evaluate({
    mode: "live",
    judge: async () => {
      throw new Error("fixture provider failure");
    },
  });
  expect(report.splits.calibration.providerFailures.count).toBe(6);
  expect(report.splits.heldOut.providerFailures.count).toBe(7);
  expect(report.splits.heldOut.finalOutcomes.benignReviews).toEqual({
    count: 3,
    total: 3,
    rate: 1,
  });
  expect(report.splits.heldOut.semanticCompleted.policyPlusJev.missedViolations).toEqual({
    count: 0,
    total: 0,
    rate: null,
  });
  expect(report.splits.heldOut.semanticCompletedLatencyMs.p95).toBeNull();
});

test("nearest-rank latency percentiles handle empty and small samples", () => {
  expect(percentile([], 95)).toBeNull();
  expect(percentile([5], 95)).toBe(5);
  expect(percentile([30, 10, 20, 40], 50)).toBe(20);
  expect(percentile([30, 10, 20, 40], 95)).toBe(40);
});

test("live mode never silently falls back to fixture scores", async () => {
  await expect(evaluate({ mode: "live" })).rejects.toThrow("requires a judge");
});
