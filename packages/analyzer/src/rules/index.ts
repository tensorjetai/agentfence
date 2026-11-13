import { createHash } from "node:crypto";
import { isSuppressed, type AgentFencePolicy } from "@agentfence/policy";
import { agentOutputShellPath, promptTaintPaths } from "../dataflow/index.js";
import { parseExpressions } from "../expressions/index.js";
import { hasImplicitWriteActorGuard } from "../providers/index.js";
import type {
  Finding,
  PermissionMap,
  RuleId,
  Severity,
  WorkflowIR,
  WorkflowJob,
  WorkflowStep,
} from "../ir/types.js";
import { permissionPatch, remediationFor } from "../remediation/index.js";
import { parseWorkflowSourceMetadata } from "../parse/inline-suppressions.js";

const publicEvents = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "discussion",
  "discussion_comment",
]);

export function evaluateRules(
  workflow: WorkflowIR,
  options: { repository?: string; policy?: AgentFencePolicy; now?: Date } = {},
): Finding[] {
  const sourceMetadata =
    workflow.kind === "actions-yaml" &&
    workflow.completeness === "complete" &&
    workflow.source.includes("agentfence-ignore")
      ? parseWorkflowSourceMetadata(workflow.source)
      : { suppressions: [], jobStartLines: new Map(), stepStartLines: new Map() };
  const inlineSuppressions = sourceMetadata.suppressions;
  const findings: Finding[] = [];
  for (const job of workflow.jobs) {
    const permissions = effectivePermissions(workflow.permissions, job.permissions);
    const privilege = privilegeContext(permissions);
    const agents = job.steps.filter((step) => step.kind === "agent");
    const jobSecrets = jobHasAnySecrets(job);
    for (const agent of agents) {
      const hasSecrets = agentHasSecrets(job, agent);
      const trustedGate = hasTrustGate(job, agent);
      const paths = promptTaintPaths(workflow, job, agent);
      for (const path of paths) {
        if (privilege.length > 0 || hasSecrets || agent.capabilities.includes("SHELL_CAPABILITY")) {
          findings.push(
            makeFinding(
              "AF001",
              "critical",
              workflow,
              agent,
              path.source,
              path.sink,
              privilege,
              path.trace,
            ),
          );
        }
        if (hasSecrets) {
          findings.push(
            makeFinding(
              "AF006",
              "critical",
              workflow,
              agent,
              path.source,
              "agent secret context",
              privilege,
              path.trace,
            ),
          );
        }
      }
      if (workflow.triggers.some((trigger) => publicEvents.has(trigger.event)) && !trustedGate) {
        findings.push(
          makeFinding(
            "AF004",
            "high",
            workflow,
            agent,
            workflow.triggers.map((item) => item.event).join(", "),
            "privileged agent trigger",
            privilege,
            [{ label: "UNTRUSTED_EVENT_TEXT", description: "public trigger", range: agent.range }],
          ),
        );
      }
      if (excessivePermissions(permissions)) {
        findings.push(
          makeFinding(
            "AF005",
            "high",
            workflow,
            agent,
            "job permissions",
            "agent capability context",
            privilege,
            [{ label: "WRITE_CAPABILITY", description: privilege.join(", "), range: agent.range }],
            permissionPatch(workflow.path),
          ),
        );
      }
    }
    for (const shell of job.steps.filter((step) => step.kind === "shell")) {
      const path = agentOutputShellPath(workflow, job, shell);
      if (path)
        findings.push(
          makeFinding(
            "AF002",
            "critical",
            workflow,
            shell,
            path.source,
            path.sink,
            privilege,
            path.trace,
          ),
        );
    }
    for (const checkout of job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"))) {
      const ref = checkout.with.ref ?? "";
      const explicitlyUntrusted = parseExpressions(ref).references.some((item) =>
        /pull_request\.head|head_ref/.test(item.path),
      );
      const defaultPullRequestCheckout =
        !ref && workflow.triggers.some((trigger) => trigger.event === "pull_request");
      const untrusted = explicitlyUntrusted || defaultPullRequestCheckout;
      if (untrusted && (privilege.length > 0 || jobSecrets)) {
        findings.push(
          makeFinding(
            "AF003",
            "critical",
            workflow,
            checkout,
            ref || "default pull_request merge ref",
            `privileged job ${job.id}`,
            privilege,
            [
              { label: "UNTRUSTED_REF", description: ref, range: checkout.range },
              {
                label: "UNTRUSTED_REPOSITORY_CONTENT",
                description: `checkout in ${job.id}`,
                range: checkout.range,
              },
            ],
          ),
        );
      }
    }
  }
  return dedupe(
    findings
      .map((finding) =>
        options.repository
          ? {
              ...finding,
              fingerprint: createHash("sha256")
                .update(`${options.repository}\0${finding.fingerprint}`)
                .digest("hex"),
            }
          : finding,
      )
      .map((finding) => {
        const suppression = options.policy
          ? isSuppressed(options.policy, finding.ruleId, finding.path, options.now)
          : undefined;
        const inlineSuppression =
          finding.completeness === "complete"
            ? inlineSuppressions.find(
                (item) =>
                  item.rules.includes(finding.ruleId) &&
                  appliesToFinding(item.line, finding, workflow, sourceMetadata),
              )
            : undefined;
        return suppression || inlineSuppression
          ? {
              ...finding,
              suppressed: {
                reason: suppression?.reason ?? inlineSuppression!.reason,
                ...(suppression?.expires ? { expires: suppression.expires } : {}),
              },
            }
          : finding;
      }),
  );
}

function appliesToFinding(
  suppressionLine: number,
  finding: Finding,
  workflow: WorkflowIR,
  sourceMetadata: ReturnType<typeof parseWorkflowSourceMetadata>,
): boolean {
  if (finding.path !== workflow.path) return false;
  const findingLine = finding.range.start.line;
  if (findingLine === suppressionLine || findingLine === suppressionLine + 1) return true;
  for (const job of workflow.jobs) {
    if (job.range.path !== finding.path) continue;
    for (const step of job.steps) {
      if (
        step.range.path === finding.path &&
        step.range.start.offset <= finding.range.start.offset &&
        step.range.end.offset >= finding.range.start.offset &&
        (sourceMetadata.jobStartLines.get(job.id) === suppressionLine + 1 ||
          sourceMetadata.stepStartLines.get(step.range.start.offset) === suppressionLine + 1)
      ) {
        return true;
      }
    }
  }
  return false;
}

function makeFinding(
  ruleId: RuleId,
  severity: Severity,
  workflow: WorkflowIR,
  step: WorkflowStep,
  source: string,
  sink: string,
  privilegeContext: string[],
  trace: Finding["trace"],
  suggestedPatch?: string,
): Finding {
  const identity = [step.range.path, ruleId, source, sink].join("\0");
  const explanation = explanations[ruleId];
  return {
    fingerprint: createHash("sha256").update(identity).digest("hex"),
    ruleId,
    severity,
    confidence: "high",
    path: step.range.path,
    range: step.range,
    source,
    sink,
    privilegeContext,
    trace,
    explanation,
    remediation: remediationFor(ruleId),
    ...(suggestedPatch ? { suggestedPatch } : {}),
    completeness: workflow.completeness,
  };
}

const explanations: Record<RuleId, string> = {
  AF001: "Attacker-controlled data can influence an agent with privileged capabilities.",
  AF002: "Free-form agent output can become executable shell input.",
  AF003: "Contributor-controlled repository content enters a privileged job.",
  AF004: "A public event can start a privileged agent without a static trust gate.",
  AF005: "Agent job receives broader GitHub permissions than least privilege requires.",
  AF006: "A secret is available where attacker-controlled data can influence agent behavior.",
  AF007: "Repository MCP configuration grants broad authority or runs an unpinned server package.",
};

function effectivePermissions(
  top: PermissionMap | undefined,
  job: PermissionMap | undefined,
): PermissionMap | undefined {
  return job ?? top;
}

function privilegeContext(permissions: PermissionMap | undefined): string[] {
  if (permissions === "write-all") return ["write-all"];
  if (!permissions || permissions === "read-all") return [];
  return Object.entries(permissions)
    .filter(([, value]) => value === "write")
    .map(([scope]) => `${scope}:write`);
}

function excessivePermissions(permissions: PermissionMap | undefined): boolean {
  return (
    permissions === undefined ||
    permissions === "write-all" ||
    privilegeContext(permissions).length > 0
  );
}

function agentHasSecrets(job: WorkflowJob, agent: WorkflowStep): boolean {
  const values = [
    ...Object.values(job.env),
    ...Object.values(agent.with),
    ...Object.values(agent.env),
  ];
  return job.secrets.length > 0 || values.some(hasSecretReference);
}

function jobHasAnySecrets(job: WorkflowJob): boolean {
  const values = [
    ...Object.values(job.env),
    ...job.steps.flatMap((step) => [...Object.values(step.with), ...Object.values(step.env)]),
  ];
  return job.secrets.length > 0 || values.some(hasSecretReference);
}

function hasSecretReference(value: string): boolean {
  return parseExpressions(value).references.some((reference) =>
    reference.path.startsWith("secrets."),
  );
}

function hasTrustGate(job: WorkflowJob, agent: WorkflowStep): boolean {
  const conditions = [job.if ?? "", agent.if ?? ""].join(" ");
  const trustedAssociation =
    /author_association\s*==\s*['"](?:OWNER|MEMBER|COLLABORATOR)['"]/i.test(conditions) ||
    /contains\([^)]*(?:OWNER|MEMBER|COLLABORATOR)[^)]*author_association[^)]*\)/i.test(conditions);
  const fixedActor = /github\.actor\s*==\s*['"][A-Za-z0-9](?:[A-Za-z0-9-]{0,38})['"]/i.test(
    conditions,
  );
  return trustedAssociation || fixedActor || hasImplicitWriteActorGuard(agent);
}

function dedupe(findings: Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = unique.get(finding.fingerprint);
    const suppressionStatusMatches = Boolean(existing?.suppressed) === Boolean(finding.suppressed);
    if (!existing || (existing.suppressed && !finding.suppressed) || suppressionStatusMatches) {
      unique.set(finding.fingerprint, finding);
    }
  }
  return [...unique.values()];
}
