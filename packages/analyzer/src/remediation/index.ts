import type { RuleId } from "../ir/types.js";

const remediation: Record<RuleId, string> = {
  AF001:
    "Add a trusted-actor or approval-label gate, then isolate write operations in a separate job.",
  AF002: "Parse agent output as a strict schema and map allowlisted values to fixed commands.",
  AF003: "Analyze the base revision in an unprivileged job; pass only validated artifacts forward.",
  AF004: "Require a trusted actor association, membership check, label, or protected environment.",
  AF005: "Set top-level `permissions: {}` and grant only required read scopes at job level.",
  AF006:
    "Remove the secret from the agent job; mint scoped credentials in a separate approved stage.",
  AF007:
    "Review MCP server commands and tool authority; use explicit versions and narrow allowlists.",
};

export function remediationFor(ruleId: RuleId): string {
  return remediation[ruleId];
}

export function permissionPatch(path: string): string {
  return `--- a/${path}\n+++ b/${path}\n@@\n+permissions: {}\n`;
}
