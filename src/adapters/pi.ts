import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateEndpoint } from "../runtime";

// Structural subset of Pi's extension API, checked against Pi 0.85.1.
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

export function createPiExtension(check: typeof evaluateEndpoint = evaluateEndpoint) {
  return (pi: PiAPI): void => {
    let goal = "";
    let goalAt = 0;
    let pending: { text: string; at: number }[] = [];
    let sessionId: string | undefined;
    let generation = 0;
    const ttl = 24 * 60 * 60 * 1000;
    const reset = () => {
      goal = "";
      goalAt = 0;
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
      goal = index < 0 ? "" : (pending[index]?.text ?? "");
      goalAt = Date.now();
      if (index >= 0) pending.splice(index, 1);
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
          userGoal: Date.now() - goalAt < ttl ? goal : "",
          tool: event.toolName,
          arguments: snapshot,
        });
        const block = (): Block => ({
          block: true,
          reason: `Turnstile: ${decision.verdict} (${decision.reasons.join(", ")})`,
        });
        if (!currentAction())
          return { block: true, reason: "Turnstile: session changed during evaluation" };
        if (JSON.stringify(event.input) !== serialized)
          return { block: true, reason: "Turnstile: tool arguments changed during evaluation" };
        if (!decision.enforced) return;
        if (decision.verdict !== "review" || !ctx.hasUI || typeof ctx.ui?.confirm !== "function")
          return block();
        const approved = await ctx.ui.confirm(
          "Turnstile: approve this action?",
          `Tool: ${event.toolName}\nCall: ${event.toolCallId}\nRequest: ${decision.requestHash}\nReasons: ${decision.reasons.join(", ")}\nArguments: ${serialized}`,
        );
        if (!approved || !currentAction() || JSON.stringify(event.input) !== serialized)
          return block();
        // Approval applies only to this handler invocation, never to a future action.
        return;
      } catch {
        return { block: true, reason: "Turnstile: evaluation failed; tool blocked" };
      }
    });
  };
}

export default createPiExtension();
