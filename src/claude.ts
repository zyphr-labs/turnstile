import { realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { configSchema, endpointAuthorization } from "./endpoint";
import { createGuard, hash } from "./guard";
import { createJevJudge } from "./jev";
import { appendAudit, privateWrite, readBounded } from "./storage";

const envelope = z.object({
  hook_event_name: z.enum(["UserPromptSubmit", "PreToolUse", "SessionEnd"]),
  session_id: z.string().min(1).max(256),
  cwd: z.string(),
  prompt: z.string().max(16000).optional(),
  tool_name: z.string().min(1).max(256).optional(),
  tool_input: z.record(z.string(), z.json()).optional(),
});

export async function claudeHook(
  input: unknown,
  configPath: string,
  apiKey?: string,
): Promise<unknown> {
  const event = envelope.parse(input);
  const config = configSchema.parse(JSON.parse(await readBounded(configPath)));
  const stateDir = join(dirname(configPath), "sessions");
  const statePath = join(stateDir, `${hash(event.session_id)}.json`);
  if (event.hook_event_name === "SessionEnd") {
    await unlink(statePath).catch(() => {});
    return {};
  }
  if ((await realpath(event.cwd)) !== (await realpath(config.root)))
    throw new Error("Unexpected hook workspace");
  if (event.hook_event_name === "UserPromptSubmit") {
    if (event.prompt === undefined) throw new Error("Missing user prompt");
    await privateWrite(statePath, { goal: event.prompt, updatedAt: Date.now() });
    return {};
  }
  if (!event.tool_name || !event.tool_input) throw new Error("Missing tool action");
  let userGoal = "";
  try {
    const saved = z
      .object({ goal: z.string().max(16000), updatedAt: z.number() })
      .parse(JSON.parse(await readBounded(statePath)));
    const age = Date.now() - saved.updatedAt;
    if (age >= 0 && age <= 86400000) userGoal = saved.goal;
  } catch {
    /* Missing, expired or invalid intent requires review. */
  }
  const guard = createGuard({
    policy: config.policy,
    judge:
      config.jev.enabled && apiKey
        ? createJevJudge({ apiKey, model: config.jev.model, timeoutMs: config.jev.timeoutMs })
        : undefined,
    authorize: endpointAuthorization(config.root),
    audit: (decision) => appendAudit(join(dirname(configPath), "decisions.jsonl"), decision),
  });
  const decision = await guard.check({
    userGoal,
    tool: event.tool_name,
    arguments: event.tool_input,
  });
  // Never emit "allow": that can bypass the host's normal permission prompt.
  if (!decision.enforced) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.verdict === "deny" ? "deny" : "ask",
      permissionDecisionReason: `Turnstile: ${decision.reasons.join(", ")}. Decision ${decision.id}`,
    },
  };
}
