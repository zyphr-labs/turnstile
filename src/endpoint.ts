import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { CheckedRequest, HardDecision } from "./schema";
import { policySchema } from "./schema";

export const configSchema = z
  .object({
    version: z.literal(1),
    root: z.string().refine(isAbsolute, "root must be absolute"),
    policy: policySchema,
    jev: z
      .object({
        enabled: z.boolean().default(false),
        model: z.literal("jev-1.13.0").default("jev-1.13.0"),
        timeoutMs: z.number().int().min(1).max(10000).default(4000),
      })
      .strict(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export function defaultConfig(root: string): Config {
  return configSchema.parse({
    version: 1,
    root: resolve(root),
    policy: {
      version: 1,
      tools: {
        Read: { effect: "allow" },
        Write: { effect: "allow" },
        Edit: { effect: "allow" },
        Bash: { effect: "review" },
      },
    },
    jev: { enabled: false },
  });
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Resolve the nearest existing ancestor so writes to new files still honor symlinks.
async function physicalPath(path: string): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    const resolvedParent = await physicalPath(parent);
    return resolve(resolvedParent, relative(parent, path));
  }
  return await realpath(path);
}

export function endpointAuthorization(root: string) {
  return async (request: CheckedRequest): Promise<HardDecision> => {
    if (!["Read", "Write", "Edit"].includes(request.tool))
      return { verdict: "review", reasons: ["endpoint.unmediated_tool"] };
    const path = request.arguments.file_path;
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
      return { verdict: "deny", reasons: ["endpoint.invalid_path"] };
    const logicalRoot = resolve(root);
    const logicalPath = resolve(path);
    const physicalRoot = await realpath(logicalRoot);
    const physical = await physicalPath(logicalPath);
    if (!inside(logicalRoot, logicalPath) || !inside(physicalRoot, physical))
      return { verdict: "deny", reasons: ["endpoint.outside_workspace"] };
    const parts = [
      ...relative(logicalRoot, logicalPath).split(sep),
      ...relative(physicalRoot, physical).split(sep),
    ];
    if (
      parts.some((part) =>
        /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.secrets|.*\.(?:pem|key|p12|pfx))$/i.test(part),
      )
    )
      return { verdict: "deny", reasons: ["endpoint.sensitive_path"] };
    if (parts.some((part) => [".turnstile", ".claude", ".git"].includes(part)))
      return { verdict: "deny", reasons: ["endpoint.control_path"] };
    if (request.tool === "Write" && typeof request.arguments.content !== "string")
      return { verdict: "deny", reasons: ["endpoint.invalid_arguments"] };
    if (
      request.tool === "Edit" &&
      (typeof request.arguments.old_string !== "string" ||
        typeof request.arguments.new_string !== "string")
    )
      return { verdict: "deny", reasons: ["endpoint.invalid_arguments"] };
    return { verdict: "allow", reasons: ["endpoint.workspace_file"] };
  };
}
