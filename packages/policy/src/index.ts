import { parse } from "yaml";
import { z } from "zod";

const severitySchema = z.enum(["critical", "high", "medium", "low"]);
const ruleSchema = z.enum(["AF001", "AF002", "AF003", "AF004", "AF005", "AF006", "AF007"]);

const suppressionSchema = z
  .object({
    rule: ruleSchema,
    path: z.string().min(1).optional(),
    reason: z.string().trim().min(1),
    expires: z.iso.date().optional(),
  })
  .strict();

export const policySchema = z
  .object({
    version: z.literal(1),
    blockingSeverity: severitySchema.default("critical"),
    providers: z
      .object({
        enabled: z.array(
          z.enum(["github-agentic-workflows", "claude", "codex", "gemini", "actions-ai-inference"]),
        ),
      })
      .strict()
      .default({
        enabled: ["github-agentic-workflows", "claude", "codex", "gemini", "actions-ai-inference"],
      }),
    limits: z
      .object({ reusableWorkflowDepth: z.number().int().min(1).max(5).default(5) })
      .strict()
      .default({ reusableWorkflowDepth: 5 }),
    suppressions: z.array(suppressionSchema).default([]),
  })
  .strict();

export type AgentFencePolicy = z.infer<typeof policySchema>;
export type Suppression = z.infer<typeof suppressionSchema>;
export interface PolicyWarning {
  code: "expired-suppression";
  message: string;
  suppression: Suppression;
}

export function parsePolicy(
  source: string,
  now = new Date(),
): { policy: AgentFencePolicy; warnings: PolicyWarning[] } {
  if (Buffer.byteLength(source) > 65_536) {
    throw new Error("Policy exceeds 65536 bytes");
  }
  const parsed: unknown = parse(source);
  const policy = policySchema.parse(parsed);
  const today = now.toISOString().slice(0, 10);
  const warnings = policy.suppressions
    .filter((suppression) => suppression.expires !== undefined && suppression.expires < today)
    .map((suppression) => ({
      code: "expired-suppression" as const,
      message: `${suppression.rule} suppression expired ${suppression.expires}`,
      suppression,
    }));
  return { policy, warnings };
}

export function isSuppressed(
  policy: AgentFencePolicy,
  ruleId: string,
  path: string,
  now = new Date(),
): Suppression | undefined {
  const today = now.toISOString().slice(0, 10);
  return policy.suppressions.find(
    (item) =>
      item.rule === ruleId &&
      (item.path === undefined || item.path === path) &&
      (item.expires === undefined || item.expires >= today),
  );
}
