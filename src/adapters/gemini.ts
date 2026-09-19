import { z } from "zod";
import { clearGoal, evaluateEndpoint, loadEndpoint, readGoal, saveGoal } from "../runtime";

const envelope = z.object({
  hook_event_name: z.enum(["BeforeAgent", "BeforeTool", "SessionEnd"]),
  session_id: z.string().min(1).max(256),
  cwd: z.string().min(1),
  prompt: z.string().max(16000).optional(),
  tool_name: z.string().min(1).max(256).optional(),
  tool_input: z.record(z.string(), z.json()).optional(),
});

export async function geminiHook(
  input: unknown,
  configPath: string,
  apiKey?: string,
): Promise<unknown> {
  const event = envelope.parse(input);
  await loadEndpoint(configPath, event.cwd);
  if (event.hook_event_name === "SessionEnd") {
    await clearGoal(configPath, "gemini", event.session_id);
    return {};
  }
  if (event.hook_event_name === "BeforeAgent") {
    if (event.prompt === undefined) throw new Error("Missing user prompt");
    await saveGoal(configPath, "gemini", event.session_id, event.prompt);
    return {};
  }
  if (!event.tool_name || !event.tool_input) throw new Error("Missing tool action");
  const decision = await evaluateEndpoint({
    harness: "gemini",
    sessionId: event.session_id,
    cwd: event.cwd,
    configPath,
    apiKey,
    userGoal: await readGoal(configPath, "gemini", event.session_id),
    tool: event.tool_name,
    arguments: event.tool_input,
  });
  if (!decision.enforced) return {};
  // BeforeTool exposes allow/deny, not a human-approval callback.
  return {
    decision: "deny",
    reason: `Turnstile: ${decision.verdict}. ${decision.reasons.join(", ")}. Decision ${decision.id}`,
  };
}
