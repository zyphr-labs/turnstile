import { realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { configSchema, endpointAuthorization } from "./endpoint";
import { createGuard, hash } from "./guard";
import { createJevJudge } from "./jev";
import type { ActionRequest, Decision } from "./schema";
import { appendAudit, privateWrite, readBounded } from "./storage";

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
      const old = args[input.harness === "pi" ? "oldText" : "oldString"];
      const next = args[input.harness === "pi" ? "newText" : "newString"];
      if (typeof old === "string") normalized.old_string = old;
      if (typeof next === "string") normalized.new_string = next;
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
    audit: (decision) =>
      appendAudit(join(dirname(configPath), "decisions.jsonl"), {
        ...decision,
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
  await privateWrite(sessionPath(configPath, harness, sessionId), {
    goal,
    updatedAt: Date.now(),
    turnId,
  });
}
export async function readGoal(
  configPath: string,
  harness: Harness,
  sessionId: string,
  turnId?: string,
) {
  try {
    const saved = z
      .object({
        goal: z.string().max(16000),
        updatedAt: z.number().finite(),
        turnId: z.string().optional(),
      })
      .parse(JSON.parse(await readBounded(sessionPath(configPath, harness, sessionId))));
    const age = Date.now() - saved.updatedAt;
    return age >= 0 && age <= 86400000 && saved.turnId === turnId ? saved.goal : "";
  } catch {
    return "";
  }
}
export async function clearGoal(configPath: string, harness: Harness, sessionId: string) {
  await unlink(sessionPath(configPath, harness, sessionId)).catch(() => {});
}
