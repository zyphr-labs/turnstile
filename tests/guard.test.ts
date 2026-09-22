import { expect, test } from "bun:test";
import { ActionBlocked, createGuard, type Judge, type Policy } from "../src/index";

const policy: Policy = {
  version: 1,
  mode: "enforce",
  tools: {
    save: { effect: "allow", argumentEquals: { recipient: "self" } },
    publish: { effect: "deny" },
    shell: { effect: "review" },
  },
};
const safe: Judge = async () => ({
  model: "fixture",
  inputTokens: 3,
  scores: { intentDrift: 0.01, dataDisclosure: 0.01, instructionOverride: 0.01 },
});
const action = {
  userGoal: "Save my note privately",
  tool: "save",
  arguments: { recipient: "self", text: "hello" },
};

test("authorized benign action reaches executor exactly once", async () => {
  let calls = 0;
  const result = await createGuard({ policy, judge: safe }).execute(action, async () => ++calls);
  expect(result.value).toBe(1);
  expect(result.decision.verdict).toBe("allow");
});
test("hard denial, argument mismatch and review never call the model or executor", async () => {
  let calls = 0;
  const guard = createGuard({
    policy,
    judge: async (r) => {
      calls++;
      return safe(r);
    },
  });
  for (const request of [
    { ...action, tool: "publish" },
    { ...action, tool: "shell" },
    { ...action, arguments: { recipient: "someone-else" } },
    { ...action, tool: "unknown" },
  ]) {
    await expect(
      guard.execute(request, async () => {
        calls++;
      }),
    ).rejects.toBeInstanceOf(ActionBlocked);
  }
  expect(calls).toBe(0);
});
test("semantic drift blocks permitted actions before side effects", async () => {
  const guard = createGuard({
    policy,
    judge: async () => ({
      model: "fixture",
      inputTokens: 3,
      scores: { intentDrift: 0.95, dataDisclosure: 0.01, instructionOverride: 0.01 },
    }),
  });
  let executed = false;
  await expect(
    guard.execute(action, async () => {
      executed = true;
    }),
  ).rejects.toBeInstanceOf(ActionBlocked);
  expect(executed).toBe(false);
});
test("uncertain, absent, invalid and failed judgments require review", async () => {
  const judges: (Judge | undefined)[] = [
    undefined,
    async () => {
      throw new Error("private upstream error");
    },
    async () => ({
      model: "fixture",
      inputTokens: 0,
      scores: { intentDrift: 0.5, dataDisclosure: 0, instructionOverride: 0 },
    }),
    async () => ({
      model: "fixture",
      inputTokens: 0,
      scores: { intentDrift: Number.NaN, dataDisclosure: 0, instructionOverride: 0 },
    }),
  ];
  for (const judge of judges) {
    const d = await createGuard({ policy, judge }).check(action);
    expect(d.verdict).toBe("review");
    expect(JSON.stringify(d)).not.toContain("private upstream error");
  }
});
test("missing intent does not get a semantic approval", async () => {
  expect(
    (await createGuard({ policy, judge: safe }).check({ ...action, userGoal: "" })).verdict,
  ).toBe("review");
});
test("observe records denial without preventing execution", async () => {
  const result = await createGuard({ policy: { ...policy, mode: "observe" } }).execute(
    { ...action, tool: "publish" },
    async () => "ran",
  );
  expect(result.value).toBe("ran");
  expect(result.decision.verdict).toBe("deny");
  expect(result.decision.enforced).toBe(false);
});
test("caller mutation during judgment cannot change executed arguments", async () => {
  const request = structuredClone(action);
  const guard = createGuard({
    policy,
    judge: async (r) => {
      request.arguments.recipient = "public";
      r.arguments.recipient = "public";
      return safe(r);
    },
  });
  const result = await guard.execute(request, async (args) => args.recipient);
  expect(result.value).toBe("self");
});
test("audit callback mutation cannot undo enforcement", async () => {
  const guard = createGuard({
    policy,
    audit: async (d) => {
      d.enforced = false;
    },
  });
  await expect(
    guard.execute({ ...action, tool: "publish" }, async () => "ran"),
  ).rejects.toBeInstanceOf(ActionBlocked);
});
test("audit failure prevents execution", async () => {
  const guard = createGuard({
    policy,
    judge: safe,
    audit: async () => {
      throw new Error("disk full");
    },
  });
  let called = false;
  await expect(
    guard.execute(action, async () => {
      called = true;
    }),
  ).rejects.toThrow();
  expect(called).toBe(false);
});
test("invalid policy and oversized or malformed actions are rejected", async () => {
  expect(() =>
    createGuard({ policy: { ...policy, thresholds: { review: 0.9, deny: 0.2 } } }),
  ).toThrow();
  await expect(
    createGuard({ policy }).check({ ...action, arguments: { text: "x".repeat(65000) } }),
  ).rejects.toThrow();
});
test("decision receipts omit goal, tool arguments and evidence", async () => {
  const d = await createGuard({ policy, judge: safe }).check({
    ...action,
    evidence: [{ source: "doc", content: "private evidence" }],
  });
  const json = JSON.stringify(d);
  expect(json).not.toContain("hello");
  expect(json).not.toContain("private evidence");
  expect(json).not.toContain(action.userGoal);
});

test("missing evidence stays unassessed instead of recording a low override score", async () => {
  const guard = createGuard({ policy, judge: safe });
  const absent = await guard.check(action);
  expect(absent.verdict).toBe("allow");
  expect(absent.evidenceStatus).toBe("absent");
  expect(absent.scores?.instructionOverride).toBeUndefined();
  const supplied = await guard.check({
    ...action,
    evidence: [{ source: "fixture", content: "A note to save privately." }],
  });
  expect(supplied.evidenceStatus).toBe("provided");
  expect(supplied.scores?.instructionOverride).toBe(0.01);
});

test("a judge must assess instruction influence when evidence was provided", async () => {
  const guard = createGuard({
    policy,
    judge: async () => ({
      model: "fixture",
      inputTokens: 1,
      scores: { intentDrift: 0, dataDisclosure: 0 },
    }),
  });
  const d = await guard.check({ ...action, evidence: [{ source: "fixture", content: "note" }] });
  expect(d.verdict).toBe("review");
  expect(d.semanticFailure).toBe("invalid_response");
});

test("authorization identity is fingerprinted separately without retaining configuration", async () => {
  const identity = { root: "/synthetic/private/project", version: "paths-v1" };
  const guard = createGuard({ policy, judge: safe, authorizationIdentity: identity });
  identity.root = "/changed";
  const first = await guard.check(action);
  const second = await createGuard({ policy, judge: safe, authorizationIdentity: identity }).check(
    action,
  );
  expect(first.policyHash).toBe(second.policyHash);
  expect(first.authorizationHash).not.toBe(second.authorizationHash);
  expect(JSON.stringify(first)).not.toContain("/synthetic/private/project");
});
