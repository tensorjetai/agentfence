import { z } from "zod";
import { parseExpressions } from "../expressions/index.js";
import type { WorkflowStep } from "../ir/types.js";

const capabilitySchema = z.object({
  shell: z.union([z.boolean(), z.literal("configurable")]),
  network: z.boolean(),
  repositoryWrite: z.union([z.boolean(), z.literal("inferred-from-token")]),
});

export const providerProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    provider: z.enum([
      "github-agentic-workflows",
      "claude",
      "codex",
      "gemini",
      "actions-ai-inference",
    ]),
    matches: z.array(z.string().min(3)).min(1),
    promptInputs: z.array(z.string()).min(1),
    outputFields: z.array(z.string()),
    capabilities: capabilitySchema,
    permissionInputs: z.array(z.string()),
    secretInputs: z.array(z.string()),
    implicitActorGuard: z.enum(["write-access"]).optional(),
    pinnedFixtureVersion: z.string().min(1),
  })
  .strict();

export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const builtInProfiles: ProviderProfile[] = [
  {
    schemaVersion: 1,
    id: "github-agentic-workflows",
    provider: "github-agentic-workflows",
    matches: ["github-agentic-workflows/*"],
    promptInputs: ["prompt", "instructions"],
    outputFields: ["result"],
    capabilities: { shell: "configurable", network: true, repositoryWrite: "inferred-from-token" },
    permissionInputs: ["github-token"],
    secretInputs: ["api-key"],
    pinnedFixtureVersion: "gh-aw-public-preview-2026-07",
  },
  {
    schemaVersion: 1,
    id: "anthropics/claude-code-action",
    provider: "claude",
    matches: ["anthropics/claude-code-action@*"],
    promptInputs: ["prompt", "direct_prompt", "custom_instructions"],
    outputFields: ["execution_file", "branch_name"],
    capabilities: { shell: "configurable", network: true, repositoryWrite: "inferred-from-token" },
    permissionInputs: ["github_token"],
    secretInputs: ["anthropic_api_key", "claude_code_oauth_token"],
    pinnedFixtureVersion: "v1",
  },
  {
    schemaVersion: 1,
    id: "anthropics/claude-code-base-action",
    provider: "claude",
    matches: ["anthropics/claude-code-base-action@*"],
    promptInputs: ["prompt", "prompt_file", "direct_prompt", "custom_instructions"],
    outputFields: ["execution_file"],
    capabilities: { shell: "configurable", network: true, repositoryWrite: "inferred-from-token" },
    permissionInputs: ["github_token"],
    secretInputs: ["anthropic_api_key", "claude_code_oauth_token"],
    pinnedFixtureVersion: "v1",
  },
  {
    schemaVersion: 1,
    id: "openai/codex-action",
    provider: "codex",
    matches: ["openai/codex-action@*"],
    promptInputs: ["prompt", "prompt-file"],
    outputFields: ["final-message"],
    capabilities: { shell: "configurable", network: false, repositoryWrite: "inferred-from-token" },
    permissionInputs: [],
    secretInputs: ["openai-api-key"],
    implicitActorGuard: "write-access",
    pinnedFixtureVersion: "v1",
  },
  {
    schemaVersion: 1,
    id: "actions/ai-inference",
    provider: "actions-ai-inference",
    matches: ["actions/ai-inference@*"],
    promptInputs: [
      "prompt",
      "prompt-file",
      "input",
      "file_input",
      "system-prompt",
      "system-prompt-file",
    ],
    outputFields: ["response", "response-file"],
    capabilities: { shell: false, network: true, repositoryWrite: "inferred-from-token" },
    permissionInputs: ["token"],
    secretInputs: [],
    pinnedFixtureVersion: "v1",
  },
  {
    schemaVersion: 1,
    id: "google-github-actions/run-gemini-cli",
    provider: "gemini",
    matches: ["google-github-actions/run-gemini-cli@*"],
    promptInputs: ["prompt"],
    outputFields: ["summary", "error"],
    capabilities: { shell: "configurable", network: true, repositoryWrite: "inferred-from-token" },
    permissionInputs: [],
    secretInputs: ["gemini_api_key", "google_api_key"],
    pinnedFixtureVersion: "v0",
  },
].map((profile) => providerProfileSchema.parse(profile));

export class ProviderRegistry {
  constructor(readonly profiles: ProviderProfile[] = builtInProfiles) {
    for (const profile of profiles) providerProfileSchema.parse(profile);
    const matches = profiles.flatMap((profile) => profile.matches);
    if (new Set(matches).size !== matches.length)
      throw new Error("Ambiguous duplicate provider match");
  }

  match(uses: string): { profile: ProviderProfile; pattern: string } | undefined {
    const matches = this.profiles.flatMap((profile) =>
      profile.matches
        .filter((pattern) => globMatches(pattern, uses))
        .map((pattern) => ({ profile, pattern })),
    );
    if (matches.length > 1) throw new Error(`Ambiguous provider match for ${uses}`);
    return matches[0];
  }

  decorate(step: WorkflowStep): WorkflowStep {
    if (!step.uses) return step;
    const matched = this.match(step.uses);
    if (!matched) return step;
    const declaredMarkdownTools =
      step.kind === "agent" && step.providerId === "github-agentic-workflows";
    const capabilities = [
      ...(hasShellCapability(matched.profile, step) && !declaredMarkdownTools
        ? (["SHELL_CAPABILITY"] as const)
        : []),
      ...(matched.profile.capabilities.network ? (["NETWORK_CAPABILITY"] as const) : []),
    ];
    return {
      ...step,
      kind: "agent",
      providerId: matched.profile.id,
      capabilities: [...new Set([...step.capabilities, ...capabilities])],
      outputs: Object.fromEntries(
        matched.profile.outputFields.map((field) => [field, "agent output"]),
      ),
      promptExpressions: matched.profile.promptInputs.flatMap(
        (input) => parseExpressions(step.with[input] ?? "").references,
      ),
    };
  }
}

function hasShellCapability(profile: ProviderProfile, step: WorkflowStep): boolean {
  if (profile.provider === "actions-ai-inference") {
    const allowedTools = step.with["copilot-allow-tools"] ?? "";
    if (!allowedTools.trim()) return false;
    if (parseExpressions(allowedTools).references.length > 0) return true;
    return /(?:^|,)\s*shell\s*(?:\(|,|$)/i.test(allowedTools);
  }
  if (profile.provider === "claude") {
    const claudeArgs = step.with["claude_args"] ?? "";
    if (
      parseExpressions(claudeArgs).references.length > 0 ||
      /--dangerously-skip-permissions|--allowedTools[^,\n]*Bash/i.test(claudeArgs)
    ) {
      return true;
    }
    const allowed = (step.with["allowed_tools"] ?? step.with["allowed-tools"] ?? "").trim();
    if (allowed) {
      if (parseExpressions(allowed).references.length > 0) return true;
      const tools = allowed
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      return tools.some((tool) =>
        /^(?:\*|bash(?:\(|$)|shell(?:\(|$)|write|edit|multiedit)/i.test(tool),
      );
    }
    const disallowed = (
      step.with["disallowed_tools"] ??
      step.with["disallowed-tools"] ??
      ""
    ).trim();
    if (
      disallowed &&
      parseExpressions(disallowed).references.length === 0 &&
      /(?:^|[\s,])bash(?:\(|,|[\s]|$)/i.test(disallowed)
    ) {
      return false;
    }
    return true;
  }
  if (profile.provider === "codex") {
    const codexArgs = step.with["codex-args"] ?? "";
    if (
      /--dangerously-bypass-approvals-and-sandbox|--yolo/i.test(codexArgs) ||
      parseExpressions(codexArgs).references.length > 0
    ) {
      return true;
    }
    const sandbox = (step.with["sandbox"] ?? "").trim().toLowerCase();
    if (sandbox === "read-only") return false;
    return Boolean(profile.capabilities.shell);
  }
  return Boolean(profile.capabilities.shell);
}

export function hasImplicitWriteActorGuard(step: WorkflowStep): boolean {
  if (!step.uses) return false;
  const profile = builtInProfiles.find((candidate) => candidate.id === step.providerId);
  if (!profile?.implicitActorGuard || !step.uses.endsWith(`@${profile.pinnedFixtureVersion}`))
    return false;

  const overrideInputs = profile.provider === "codex" ? ["allow-users", "allow-bot-users"] : [];
  const permitsNonWriters = overrideInputs.some((input) => (step.with[input] ?? "").trim());
  const botBypass =
    profile.provider === "codex" &&
    !["", "false"].includes((step.with["allow-bots"] ?? "false").trim().toLowerCase());
  return !permitsNonWriters && !botBypass;
}

function globMatches(pattern: string, input: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(input);
}
