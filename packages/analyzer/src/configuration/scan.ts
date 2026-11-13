import { createHash } from "node:crypto";
import { isSuppressed } from "@agentfence/policy";
import type { ScanInput } from "../scan.js";
import type { Finding, ScanResult } from "../ir/types.js";
import { analyzeMcpConfiguration } from "./mcp.js";

export function scanConfiguration(input: ScanInput): ScanResult {
  const analysis = analyzeMcpConfiguration(input.path, input.source);
  const completeness = analysis.diagnostics.length ? "partial" : "complete";
  const findings: Finding[] = analysis.issues.map((issue) => {
    const suppression = input.policy
      ? isSuppressed(input.policy, "AF007", input.path, input.now)
      : undefined;
    return {
      fingerprint: createHash("sha256")
        .update(
          [
            input.repository ?? "",
            input.path,
            "AF007",
            issue.code,
            String(issue.range.start.offset),
          ].join("\0"),
        )
        .digest("hex"),
      ruleId: "AF007",
      severity: issue.severity,
      confidence: "high",
      path: input.path,
      range: issue.range,
      source: issue.code,
      sink: "repository MCP configuration",
      privilegeContext: [],
      trace: [],
      explanation: issue.message,
      remediation: issue.remediation,
      completeness,
      ...(suppression
        ? {
            suppressed: {
              reason: suppression.reason,
              ...(suppression.expires ? { expires: suppression.expires } : {}),
            },
          }
        : {}),
    };
  });
  return {
    path: input.path,
    findings,
    completeness,
    diagnostics: analysis.diagnostics,
    workflow: {
      path: input.path,
      kind: "agent-config",
      triggers: [],
      env: {},
      inputs: [],
      secrets: [],
      jobs: [],
      completeness,
      diagnostics: analysis.diagnostics,
      source: input.source,
    },
  };
}
