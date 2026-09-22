import { realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { configSchema, endpointAuthorization } from "./endpoint";
import { createGuard, hash } from "./guard";
import { createJevJudge } from "./jev";
import type { ActionRequest, Decision } from "./schema";
import {
  appendAudit,
  cleanupSessions,
  privateWrite,
  readBounded,
  retention,
  withStorageLock,
} from "./storage";

export type Harness = "claude" | "opencode" | "pi" | "gemini" | "cursor";
export type EndpointInput = {
  harness: Harness;
  sessionId: string;
  cwd: string;
  userGoal: string;
  tool: string;
  arguments: Record<string, unknown>;
  configPath?: string;
  apiKey?: string;
};
const rawArguments = z.record(z.string(), z.json());

export function normalizeEndpointAction(input: EndpointInput): ActionRequest {
  const args = rawArguments.parse(input.arguments);
  const mapping: Record<Harness, Record<string, string>> = {
    claude: { Read: "Read", Write: "Write", Edit: "Edit", Bash: "Bash" },
    opencode: { read: "Read", write: "Write", edit: "Edit", bash: "Bash" },
    pi: { read: "Read", write: "Write", edit: "Edit", bash: "Bash" },
    gemini: { read_file: "Read", write_file: "Write", replace: "Edit", run_shell_command: "Bash" },
    cursor: { Read: "Read", Write: "Write", Edit: "Edit", Shell: "Bash" },
  };
  const tools = mapping[input.harness];
  const canonical = Object.hasOwn(tools, input.tool) ? tools[input.tool] : undefined;
  if (!canonical)
    return { userGoal: input.userGoal, tool: `${input.harness}:${input.tool}`, arguments: args };
  const pathKey =
    input.harness === "opencode" ? "filePath" : input.harness === "pi" ? "path" : "file_path";
  const normalized = { ...args };
  // Only Pi's native Edit uses batched replacements. An unrelated argument from
  // another host must not replace validation of that host's actual edit fields.
  delete normalized.edits;
  // Use only the documented path field. An unrelated alias must not authorize a different file.
  if (["Read", "Write", "Edit"].includes(canonical)) {
    const path = args[pathKey];
    delete normalized.file_path;
    if (
      typeof path === "string" &&
      path.length &&
      !path.startsWith("~") &&
      (input.harness !== "gemini" || isAbsolute(path))
    )
      normalized.file_path = resolve(input.cwd, path);
    if (canonical === "Edit" && ["opencode", "pi"].includes(input.harness)) {
      delete normalized.old_string;
      delete normalized.new_string;
      delete normalized.oldText;
      delete normalized.newText;
      delete normalized.oldString;
      delete normalized.newString;
      if (input.harness === "pi" && Object.hasOwn(args, "edits")) {
        const edits = z
          .array(z.object({ oldText: z.string(), newText: z.string() }).strict())
          .min(1)
          .safeParse(args.edits);
        normalized.edits = edits.success
          ? edits.data.map((edit) => ({ old_string: edit.oldText, new_string: edit.newText }))
          : null;
      } else {
        const old = args[input.harness === "pi" ? "oldText" : "oldString"];
        const next = args[input.harness === "pi" ? "newText" : "newString"];
        if (typeof old === "string") normalized.old_string = old;
        if (typeof next === "string") normalized.new_string = next;
      }
    }
  }
  return { userGoal: input.userGoal, tool: canonical, arguments: normalized };
}

export async function loadEndpoint(configPath: string, cwd: string) {
  const config = configSchema.parse(JSON.parse(await readBounded(configPath)));
  if ((await realpath(cwd)) !== (await realpath(config.root)))
    throw new Error("Unexpected hook workspace");
  return config;
}

export async function evaluateEndpoint(input: EndpointInput): Promise<Decision> {
  if (!input.sessionId || input.sessionId.length > 512) throw new Error("Invalid endpoint session");
  const configPath = resolve(
    input.configPath ?? process.env.TURNSTILE_CONFIG ?? join(input.cwd, ".turnstile/config.json"),
  );
  const config = await loadEndpoint(configPath, input.cwd);
  const apiKey = input.apiKey ?? process.env.TYPESAFE_API_KEY;
  const guard = createGuard({
    policy: config.policy,
    judge:
      config.jev.enabled && apiKey
        ? createJevJudge({ apiKey, model: config.jev.model, timeoutMs: config.jev.timeoutMs })
        : undefined,
    authorize: endpointAuthorization(config.root),
    authorizationIdentity: { kind: "endpoint-paths-v2", root: config.root },
    audit: (decision) =>
      appendAudit(join(dirname(configPath), "decisions.jsonl"), {
        ...decision,
        adapterVersion: "0.1.0-alpha.3",
        harness: input.harness,
        sessionHash: hash([input.harness, input.sessionId]),
      }),
  });
  return guard.check(normalizeEndpointAction(input));
}

function sessionPath(configPath: string, harness: Harness, sessionId: string) {
  if (!sessionId || sessionId.length > 512) throw new Error("Invalid endpoint session");
  return join(dirname(configPath), "sessions", `${hash([harness, sessionId])}.json`);
}
export async function saveGoal(
  configPath: string,
  harness: Harness,
  sessionId: string,
  goal: string,
  turnId?: string,
) {
  z.string().max(16000).parse(goal);
  const path = sessionPath(configPath, harness, sessionId);
  await withStorageLock(dirname(path), async () => {
    await cleanupSessions(dirname(path));
    await privateWrite(path, { goal, updatedAt: Date.now(), turnId });
  });
}
export async function readGoal(
  configPath: string,
  harness: Harness,
  sessionId: string,
  turnId?: string,
) {
  try {
    const path = sessionPath(configPath, harness, sessionId);
    return await withStorageLock(dirname(path), async () => {
      await cleanupSessions(dirname(path));
      const saved = z
        .object({
          goal: z.string().max(16000),
          updatedAt: z.number().finite(),
          turnId: z.string().optional(),
        })
        .parse(JSON.parse(await readBounded(path)));
      const age = Date.now() - saved.updatedAt;
      return age >= 0 && age <= retention.sessionAgeMs && saved.turnId === turnId ? saved.goal : "";
    });
  } catch {
    return "";
  }
}
export async function clearGoal(configPath: string, harness: Harness, sessionId: string) {
  const path = sessionPath(configPath, harness, sessionId);
  await withStorageLock(dirname(path), async () => {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
}

const outcomeInputSchema = z
  .object({
    harness: z.enum(["claude", "opencode", "pi", "gemini", "cursor"]),
    sessionId: z.string().min(1).max(512),
    cwd: z.string(),
    configPath: z.string().optional(),
    decisionId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    toolCallId: z.string().max(512).optional(),
    outcome: z.enum(["approved", "rejected", "blocked", "released", "unknown"]),
    // Machine reason codes only. Never store a host error or tool output here.
    reason: z
      .string()
      .regex(/^[a-z0-9_.-]{1,128}$/)
      .optional(),
  })
  .strict();
export type EndpointOutcomeInput = z.infer<typeof outcomeInputSchema>;

export async function recordEndpointOutcome(input: EndpointOutcomeInput): Promise<void> {
  const checked = outcomeInputSchema.parse(input);
  const configPath = resolve(
    checked.configPath ??
      process.env.TURNSTILE_CONFIG ??
      join(checked.cwd, ".turnstile/config.json"),
  );
  await loadEndpoint(configPath, checked.cwd);
  await appendAudit(join(dirname(configPath), "outcomes.jsonl"), {
    version: 1,
    timestamp: new Date().toISOString(),
    adapterVersion: "0.1.0-alpha.3",
    harness: checked.harness,
    sessionHash: hash([checked.harness, checked.sessionId]),
    decisionId: checked.decisionId,
    requestHash: checked.requestHash,
    ...(checked.toolCallId ? { toolCallHash: hash(checked.toolCallId) } : {}),
    outcome: checked.outcome,
    ...(checked.reason ? { reason: checked.reason } : {}),
  });
}
