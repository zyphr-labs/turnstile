import { z } from "zod";

export const verdictSchema = z.enum(["allow", "review", "deny"]);
export type Verdict = z.infer<typeof verdictSchema>;
export const thresholdsSchema = z
  .object({
    review: z.number().min(0).max(1).default(0.35),
    deny: z.number().min(0).max(1).default(0.85),
  })
  .strict()
  .refine((x) => x.review < x.deny, "review must be below deny");
export const requestSchema = z
  .object({
    userGoal: z.string().max(16000),
    tool: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()),
    evidence: z
      .array(
        z
          .object({
            source: z.string().max(256),
            content: z.string().max(16000),
          })
          .strict(),
      )
      .max(16)
      .default([]),
  })
  .strict();
export type ActionRequest = z.input<typeof requestSchema>;
export type CheckedRequest = z.output<typeof requestSchema>;
export const policySchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["observe", "enforce"]).default("observe"),
    tools: z.record(
      z.string(),
      z
        .object({
          effect: verdictSchema,
          argumentEquals: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .optional(),
        })
        .strict(),
    ),
    unknownTool: z.enum(["review", "deny"]).default("review"),
    thresholds: thresholdsSchema.default({ review: 0.35, deny: 0.85 }),
  })
  .strict();
export type Policy = z.input<typeof policySchema>;
export const scoresSchema = z
  .object({
    intentDrift: z.number().min(0).max(1),
    dataDisclosure: z.number().min(0).max(1),
    instructionOverride: z.number().min(0).max(1),
  })
  .strict();
export type Scores = z.infer<typeof scoresSchema>;
export type HardDecision = { verdict: Verdict; reasons: string[] };
export const decisionSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    timestamp: z.string(),
    policyHash: z.string(),
    requestHash: z.string(),
    mode: z.enum(["observe", "enforce"]),
    verdict: verdictSchema,
    enforced: z.boolean(),
    hard: z.object({ verdict: verdictSchema, reasons: z.array(z.string()) }),
    reasons: z.array(z.string()),
    semantic: z.enum(["evaluated", "unavailable", "disabled", "skipped"]),
    scores: scoresSchema.optional(),
    model: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().nonnegative(),
  })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;
