import { ActionBlocked, createGuard, type Judge } from "../src/index";

// A deterministic fixture keeps the quickstart offline. See scripts/live.ts for Jev.
const judge: Judge = async () => ({
  model: "offline-example",
  inputTokens: 0,
  scores: { intentDrift: 0.02, dataDisclosure: 0.01, instructionOverride: 0.01 },
});
const guard = createGuard({
  policy: {
    version: 1,
    mode: "enforce",
    tools: {
      "note.write": { effect: "allow", argumentEquals: { path: "notes/summary.txt" } },
      "note.publish": { effect: "deny" },
    },
  },
  judge,
});
let executions = 0;
const run = async (args: Record<string, unknown>) => {
  executions++;
  return args.path;
};
const safe = await guard.execute(
  {
    userGoal: "Save a local summary in notes/summary.txt",
    tool: "note.write",
    arguments: { path: "notes/summary.txt" },
  },
  run,
);
console.log(`Local note: ${safe.decision.verdict}; executor called.`);
try {
  await guard.execute(
    {
      userGoal: "Save a local summary",
      tool: "note.publish",
      arguments: { destination: "public.example" },
    },
    run,
  );
  throw new Error("A denied action executed");
} catch (error) {
  if (!(error instanceof ActionBlocked)) throw error;
  console.log(`Public upload: ${error.decision.verdict}; executor not called.`);
}
if (executions !== 1) throw new Error("Unexpected execution count");
