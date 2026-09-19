import { expect, test } from "bun:test";
import { createGuard } from "../src/guard";
import { createJevJudge, MODEL, redact } from "../src/jev";

const action = {
  userGoal: "Read a document",
  tool: "Read",
  arguments: { path: "notes.txt" },
  evidence: [],
};
const valid = {
  model: MODEL,
  answers: Object.fromEntries(
    ["intentDrift", "dataDisclosure", "instructionOverride"].map((k) => [
      k,
      { type: "noul", noul: 0.01 },
    ]),
  ),
  usage: { input_tokens: 123 },
};
const fakeFetch = (callback: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  callback as typeof fetch;

test("provider uses pinned model, fixed HTTPS endpoint and redacted context", async () => {
  const judge = createJevJudge({
    apiKey: "test-key",
    fetch: fakeFetch(async (url, init) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(MODEL);
      expect(body.state.arguments.password).toBe("[REDACTED]");
      expect(body.questions.intentDrift.type).toBe("noul");
      return Response.json(valid);
    }),
  });
  const result = await judge({ ...action, arguments: { password: "synthetic-secret" } });
  expect(result.inputTokens).toBe(123);
  expect(result.scores.intentDrift).toBe(0.01);
});
test("malformed, nonfinite, missing and wrong model responses cannot allow actions", async () => {
  for (const payload of [
    {},
    { ...valid, model: "different" },
    { ...valid, answers: {} },
    { ...valid, answers: { ...valid.answers, intentDrift: { type: "noul", noul: 2 } } },
  ]) {
    const judge = createJevJudge({
      apiKey: "test",
      fetch: fakeFetch(async () => Response.json(payload)),
    });
    const d = await createGuard({
      policy: { version: 1, mode: "enforce", tools: { Read: { effect: "allow" } } },
      judge,
    }).check(action);
    expect(d.verdict).toBe("review");
    expect(d.semantic).toBe("unavailable");
  }
});
test("HTTP errors and oversized responses are rejected without reflecting provider text", async () => {
  for (const response of [
    new Response("private provider content", { status: 429 }),
    new Response("x".repeat(17000)),
  ]) {
    await expect(
      createJevJudge({ apiKey: "test", fetch: fakeFetch(async () => response) })(action),
    ).rejects.toThrow();
  }
});
test("redaction handles nested credential fields and bearer values", () => {
  const result = JSON.stringify(
    redact({ nested: [{ api_key: "secret" }], command: "Authorization: Bearer synthetic-token" }),
  );
  expect(result).not.toContain("secret");
  expect(result).not.toContain("synthetic-token");
});
test("network deadline cancels a stalled request", async () => {
  const judge = createJevJudge({
    apiKey: "test",
    timeoutMs: 10,
    fetch: fakeFetch(
      async (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        }),
    ),
  });
  await expect(judge(action)).rejects.toThrow("timeout");
});
