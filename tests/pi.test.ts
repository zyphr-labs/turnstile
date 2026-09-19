import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiExtension, type PiAPI, type PiContext } from "../src/adapters/pi";
import { createGuard } from "../src/guard";
import type { evaluateEndpoint } from "../src/runtime";

type Input = Parameters<typeof evaluateEndpoint>[0];
type Handler = (event: never, ctx: PiContext) => unknown;

async function fixture(effect: "allow" | "review" | "deny" = "allow", observe = false) {
  const cwd = await mkdtemp(join(tmpdir(), "turnstile-pi-"));
  await writeFile(join(cwd, "hello.txt"), "hello");
  const requests: Input[] = [];
  const prompts: string[] = [];
  const handlers = new Map<string, Handler>();
  const guard = createGuard({
    policy: {
      version: 1,
      mode: observe ? "observe" : "enforce",
      tools: { read: { effect }, write: { effect }, bash: { effect: "review" } },
    },
    judge: async () => ({
      scores: { intentDrift: 0, dataDisclosure: 0, instructionOverride: 0 },
      model: "test",
      inputTokens: 1,
    }),
  });
  createPiExtension(async (input) => {
    requests.push(input);
    return guard.check({
      userGoal: input.userGoal,
      tool: input.tool,
      arguments: input.arguments as Record<string, string>,
    });
  })({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as PiAPI);
  const ctx: PiContext = {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => "synthetic-session" },
    ui: {
      confirm: async (_title, message) => {
        prompts.push(message);
        return true;
      },
    },
  };
  const dispatch = async (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event as never, ctx);
  const consume = async (text: string, source = "interactive") => {
    await dispatch("input", { text, source });
    await dispatch("message_start", {
      message: { role: "user", content: [{ type: "text", text }] },
    });
  };
  const tool = (toolName = "read", input: Record<string, unknown> = { path: "hello.txt" }) =>
    dispatch("tool_call", { toolName, toolCallId: "call-1", input });
  return {
    cwd,
    requests,
    prompts,
    ctx,
    dispatch,
    consume,
    tool,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("Pi extension consumes trusted input and normalizes the action actually executed", async () => {
  const f = await fixture();
  try {
    await f.consume("Read hello.txt");
    const args = { path: "@hello.txt" };
    expect(await f.tool("read", args)).toBeUndefined();
    expect(args.path).toBe(join(f.cwd, "hello.txt"));
    expect(f.requests[0]).toMatchObject({
      harness: "pi",
      sessionId: "synthetic-session",
      userGoal: "Read hello.txt",
      arguments: args,
    });
  } finally {
    await f.cleanup();
  }
});

test("Pi does not activate queued input before it reaches the agent", async () => {
  const f = await fixture();
  try {
    await f.consume("Read hello.txt");
    await f.dispatch("input", {
      text: "Write another file",
      source: "rpc",
      streamingBehavior: "followUp",
    });
    await f.tool();
    expect(f.requests.at(-1)?.userGoal).toBe("Read hello.txt");
    await f.dispatch("message_start", { message: { role: "user", content: "Write another file" } });
    await f.tool();
    expect(f.requests.at(-1)?.userGoal).toBe("Write another file");
  } finally {
    await f.cleanup();
  }
});

test("Pi extension messages and resumed sessions cannot supply trusted goals", async () => {
  const f = await fixture();
  try {
    await f.consume("Read hello.txt", "extension");
    expect(await f.tool()).toMatchObject({ block: true });
    expect(f.requests.at(-1)?.userGoal).toBe("");
    await f.consume("Read hello.txt");
    await f.dispatch("session_start");
    expect(await f.tool()).toMatchObject({ block: true });
  } finally {
    await f.cleanup();
  }
});

test("Pi binds trusted and pending goals to the active session", async () => {
  const f = await fixture();
  try {
    await f.consume("Read hello.txt");
    await f.dispatch("input", { text: "Queued old-session goal", source: "rpc" });
    f.ctx.sessionManager.getSessionId = () => "different-session";
    expect(await f.tool()).toMatchObject({ block: true });
    expect(f.requests.at(-1)).toMatchObject({ sessionId: "different-session", userGoal: "" });
    await f.dispatch("message_start", {
      message: { role: "user", content: "Queued old-session goal" },
    });
    expect(await f.tool()).toMatchObject({ block: true });
    await f.consume("Read hello.txt in this session");
    expect(await f.tool()).toBeUndefined();
    expect(f.requests.at(-1)?.userGoal).toBe("Read hello.txt in this session");
  } finally {
    await f.cleanup();
  }
});

test("Pi navigation clears active and queued goals even when session id is unchanged", async () => {
  const f = await fixture();
  try {
    for (const event of [
      "session_before_switch",
      "session_before_fork",
      "session_before_tree",
      "session_tree",
    ]) {
      await f.consume("Read hello.txt");
      await f.dispatch("input", { text: "Old queued goal", source: "interactive" });
      await f.dispatch(event);
      expect(await f.tool()).toMatchObject({ block: true });
      await f.dispatch("message_start", { message: { role: "user", content: "Old queued goal" } });
      expect(await f.tool()).toMatchObject({ block: true });
      expect(f.requests.at(-1)?.userGoal).toBe("");
    }
    await f.consume("Read hello.txt after navigation");
    expect(await f.tool()).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("Pi approval cannot survive navigation while the dialog is open", async () => {
  const f = await fixture("review");
  try {
    await f.consume("Read hello.txt");
    f.ctx.hasUI = true;
    f.ctx.ui.confirm = async () => {
      await f.dispatch("session_tree");
      return true;
    };
    expect(await f.tool()).toMatchObject({ block: true });
  } finally {
    await f.cleanup();
  }
});

test("Pi review blocks without UI; interactive approval binds each action", async () => {
  const f = await fixture("review");
  try {
    await f.consume("Read hello.txt");
    expect(await f.tool()).toMatchObject({ block: true });
    expect(f.prompts).toHaveLength(0);
    f.ctx.hasUI = true;
    expect(await f.tool()).toBeUndefined();
    expect(await f.tool()).toBeUndefined();
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[0]).toContain("call-1");
    expect(f.prompts[0]).toContain(join(f.cwd, "hello.txt"));
    f.ctx.ui.confirm = async () => false;
    expect(await f.tool()).toMatchObject({ block: true });
  } finally {
    await f.cleanup();
  }
});

test("Pi denial never prompts and observe mode remains nonblocking", async () => {
  for (const observe of [false, true]) {
    const f = await fixture("deny", observe);
    try {
      f.ctx.hasUI = true;
      await f.consume("Read hello.txt");
      const result = await f.tool();
      if (observe) expect(result).toBeUndefined();
      else expect(result).toMatchObject({ block: true });
      expect(f.prompts).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  }
});

test("Pi rejects an action changed while its approval dialog is open", async () => {
  const f = await fixture("review");
  try {
    await f.consume("Read hello.txt");
    f.ctx.hasUI = true;
    const args = { path: "hello.txt" };
    f.ctx.ui.confirm = async () => {
      args.path = "different.txt";
      return true;
    };
    expect(await f.tool("read", args)).toMatchObject({ block: true });
  } finally {
    await f.cleanup();
  }
});

test("Pi unknown tools require review and missing reads fail before alternate-path lookup", async () => {
  const f = await fixture();
  try {
    await f.consume("Inspect this workspace");
    expect(await f.tool("custom_tool", { payload: "synthetic" })).toMatchObject({ block: true });
    expect(await f.tool("read", { path: "missing.txt" })).toMatchObject({ block: true });
  } finally {
    await f.cleanup();
  }
});
