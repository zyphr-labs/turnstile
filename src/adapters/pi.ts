import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateEndpoint, recordEndpointOutcome } from "../runtime";

// Structural subset of Pi's extension API, checked against Pi 0.86.1.
export interface PiContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: { confirm(title: string, message: string): Promise<boolean> };
}
interface InputEvent {
  text: string;
  source: string;
}
interface MessageEvent {
  message: { role: string; content: unknown };
}
interface ToolEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}
type Block = { block: true; reason: string };
export interface PiAPI {
  registerCommand(
    name: string,
    command: { description: string; handler: () => Promise<void> },
  ): void;
  on(
    name:
      | "session_start"
      | "session_before_switch"
      | "session_before_fork"
      | "session_before_tree"
      | "session_tree",
    handler: () => void,
  ): void;
  on(name: "input", handler: (event: InputEvent, ctx: PiContext) => void): void;
  on(name: "message_start", handler: (event: MessageEvent, ctx: PiContext) => void): void;
  on(
    name: "tool_call",
    handler: (event: ToolEvent, ctx: PiContext) => Promise<Block | undefined>,
  ): void;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((part) => part?.type === "text");
  if (!parts.every((part) => typeof part.text === "string")) return undefined;
  return parts.map((part) => part.text).join("\n");
}

async function normalizePath(event: ToolEvent, cwd: string): Promise<void> {
  if (!["read", "write", "edit"].includes(event.toolName)) return;
  if (typeof event.input.path !== "string") throw new Error("Invalid path");
  let path = event.input.path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  path = resolve(cwd, path);
  // Pi read otherwise tries alternate screenshot and Unicode filename spellings.
  if (event.toolName === "read") await access(path);
  event.input.path = path;
}

export function createPiExtension(
  check: typeof evaluateEndpoint = evaluateEndpoint,
  record: typeof recordEndpointOutcome = recordEndpointOutcome,
) {
  return (pi: PiAPI): void => {
    let instructions: { text: string; at: number }[] = [];
    let intentUnavailable = false;
    let pending: { text: string; at: number }[] = [];
    let sessionId: string | undefined;
    let generation = 0;
    const ttl = 24 * 60 * 60 * 1000;
    const reset = () => {
      instructions = [];
      intentUnavailable = false;
      pending = [];
      sessionId = undefined;
      generation++;
    };
    const bindSession = (ctx: PiContext) => {
      const current = ctx.sessionManager.getSessionId();
      if (current !== sessionId) {
        reset();
        sessionId = current;
      }
      return current;
    };
    pi.registerCommand("turnstile-reset", {
      description:
        "Clear Turnstile task intent. Restate the task and restrictions before continuing.",
      handler: async () => reset(),
    });
    const taskIntent = () => {
      if (instructions.some((entry) => Date.now() - entry.at >= ttl || entry.at > Date.now()))
        intentUnavailable = true;
      if (intentUnavailable) return "";
      if (instructions.length === 1) return instructions[0]?.text ?? "";
      return instructions.length
        ? `Direct user instructions in chronological order. Preserve earlier restrictions unless the user explicitly changes them.\n${instructions.map((entry, index) => `[${index + 1}] ${entry.text}`).join("\n\n")}`
        : "";
    };
    pi.on("session_start", reset);
    pi.on("session_before_switch", reset);
    pi.on("session_before_fork", reset);
    pi.on("session_before_tree", reset);
    pi.on("session_tree", reset);
    pi.on("input", (event, ctx) => {
      bindSession(ctx);
      if (!["interactive", "rpc"].includes(event.source)) return;
      if (!event.text.trim() || event.text.length > 16000) return;
      pending = pending.filter((entry) => Date.now() - entry.at < ttl).slice(-31);
      pending.push({ text: event.text, at: Date.now() });
    });
    pi.on("message_start", (event, ctx) => {
      bindSession(ctx);
      if (event.message.role !== "user") return;
      const text = messageText(event.message.content);
      const index = pending.findIndex(
        (entry) => entry.text === text && Date.now() - entry.at < ttl,
      );
      // Activate only after Pi actually consumes queued steering/follow-up input.
      // Expanded templates and extension messages require review instead of guessing intent.
      generation++;
      if (index < 0) {
        // Do not discard earlier restrictions and accept the next follow-up as a new task.
        intentUnavailable = true;
        return;
      }
      const entry = pending.splice(index, 1)[0];
      if (entry && !intentUnavailable) instructions.push(entry);
      if (instructions.length > 32 || taskIntent().length > 16000) {
        instructions = [];
        intentUnavailable = true;
      }
    });
    pi.on("tool_call", async (event, ctx) => {
      try {
        const actionSession = bindSession(ctx);
        const actionGeneration = generation;
        const currentAction = () =>
          actionGeneration === generation && ctx.sessionManager.getSessionId() === actionSession;
        await normalizePath(event, ctx.cwd);
        const snapshot = structuredClone(event.input);
        const serialized = JSON.stringify(snapshot);
        const decision = await check({
          harness: "pi",
          sessionId: actionSession,
          cwd: ctx.cwd,
          userGoal: taskIntent(),
          tool: event.toolName,
          arguments: snapshot,
        });
        const outcome = async (value: Parameters<typeof record>[0]["outcome"], reason: string) => {
          try {
            await record({
              harness: "pi",
              sessionId: actionSession,
              cwd: ctx.cwd,
              decisionId: decision.id,
              requestHash: decision.requestHash,
              toolCallId: event.toolCallId,
              outcome: value,
              reason,
            });
          } catch (error) {
            if (decision.mode === "enforce") throw error;
          }
        };
        const changed = () => !currentAction() || JSON.stringify(event.input) !== serialized;
        const block = async (reason: string): Promise<Block> => {
          await outcome("blocked", "adapter_blocked");
          return { block: true, reason: `Turnstile: ${reason}` };
        };
        if (changed())
          return await block("session, instruction, or tool arguments changed during evaluation");
        if (!decision.enforced) {
          await outcome("released", "adapter_release_requested");
          return changed() ? await block("action changed before release") : undefined;
        }
        if (decision.verdict !== "review" || !ctx.hasUI || typeof ctx.ui?.confirm !== "function")
          return await block(`${decision.verdict} (${decision.reasons.join(", ")})`);
        const approved = await ctx.ui.confirm(
          "Turnstile: approve this action?",
          `Tool: ${event.toolName}\nCall: ${event.toolCallId}\nRequest: ${decision.requestHash}\nReasons: ${decision.reasons.join(", ")}\nArguments: ${serialized}`,
        );
        await outcome(approved ? "approved" : "rejected", "operator_confirmation");
        if (!approved) return await block("operator rejected action");
        if (changed())
          return await block("session, instruction, or tool arguments changed during confirmation");
        // Approval applies only to this handler invocation, never to a future action.
        // Released records the adapter's release request, not Pi execution. A later
        // blocked outcome takes precedence if the action changes during recording.
        await outcome("released", "approved_action_release_requested");
        return changed() ? await block("action changed before release") : undefined;
      } catch {
        return { block: true, reason: "Turnstile: evaluation failed; tool blocked" };
      }
    });
  };
}

export default createPiExtension();
