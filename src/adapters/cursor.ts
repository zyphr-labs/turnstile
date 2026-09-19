import { z } from "zod";
import { clearGoal, evaluateEndpoint, loadEndpoint, readGoal, saveGoal } from "../runtime";

const envelope = z.object({
  hook_event_name: z.enum(["beforeSubmitPrompt", "preToolUse", "sessionEnd"]),
  conversation_id: z.string().min(1).max(256),
  generation_id: z.string().min(1).max(256),
  workspace_roots: z.array(z.string().min(1)).length(1),
  cwd: z.string().optional(),
  prompt: z.string().max(16000).optional(),
  tool_name: z.string().min(1).max(256).optional(),
  tool_input: z.record(z.string(), z.json()).optional(),
});

export async function cursorHook(
  input: unknown,
  configPath: string,
  apiKey?: string,
): Promise<unknown> {
  const event = envelope.parse(input);
  const cwd = event.workspace_roots[0];
  if (!cwd) throw new Error("Missing workspace");
  await loadEndpoint(configPath, cwd);
  if (event.hook_event_name === "sessionEnd") {
    await clearGoal(configPath, "cursor", event.conversation_id);
    return {};
  }
  if (event.hook_event_name === "beforeSubmitPrompt") {
    if (event.prompt === undefined) throw new Error("Missing user prompt");
    await saveGoal(configPath, "cursor", event.conversation_id, event.prompt, event.generation_id);
    return { continue: true };
  }
  if (!event.tool_name || !event.tool_input) throw new Error("Missing tool action");
  const decision = await evaluateEndpoint({
    harness: "cursor",
    sessionId: event.conversation_id,
    cwd: event.cwd ?? cwd,
    configPath,
    apiKey,
    userGoal: await readGoal(configPath, "cursor", event.conversation_id, event.generation_id),
    tool: event.tool_name,
    arguments: event.tool_input,
  });
  // Cursor requires a permission response. Its preToolUse "ask" is not enforced.
  if (!decision.enforced) return { permission: "allow" };
  const reason = `Turnstile: ${decision.verdict}. ${decision.reasons.join(", ")}. Decision ${decision.id}`;
  return { permission: "deny", user_message: reason, agent_message: reason };
}
