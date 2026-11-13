import type { ExpressionReference, WorkflowIR, WorkflowJob, WorkflowStep } from "../ir/types.js";

const claudeInteractiveEvents: Record<string, string[]> = {
  issue_comment: [
    "github.event.issue.title",
    "github.event.issue.body",
    "github.event.comment.body",
  ],
  pull_request_review_comment: [
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.comment.body",
  ],
  issues: ["github.event.issue.title", "github.event.issue.body"],
  pull_request_review: [
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.review.body",
  ],
};

const geminiInteractiveEvents: Record<string, string[]> = {
  issues: ["github.event.issue.title", "github.event.issue.body"],
  issue_comment: [
    "github.event.issue.title",
    "github.event.issue.body",
    "github.event.comment.body",
  ],
  pull_request: ["github.event.pull_request.title", "github.event.pull_request.body"],
  pull_request_target: ["github.event.pull_request.title", "github.event.pull_request.body"],
  pull_request_review: [
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.review.body",
  ],
  pull_request_review_comment: [
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.comment.body",
  ],
};

/**
 * Returns provider-documented event content consumed as prompt context without
 * an explicit prompt. Actor/mention guards are intentionally independent: they
 * control whether Claude runs, not whether the supplied event text is trusted.
 */
export function implicitPromptReferences(
  workflow: WorkflowIR,
  _job: WorkflowJob,
  step: WorkflowStep,
): ExpressionReference[] {
  const paths = new Set<string>();
  if (
    step.providerId === "anthropics/claude-code-action" &&
    step.uses === "anthropics/claude-code-action@v1" &&
    (step.with.prompt ?? "").trim() === ""
  ) {
    for (const trigger of workflow.triggers) {
      for (const path of claudeInteractiveEvents[trigger.event] ?? []) paths.add(path);
    }
  } else if (
    step.providerId === "google-github-actions/run-gemini-cli" &&
    (step.with.prompt ?? "").trim() === ""
  ) {
    for (const trigger of workflow.triggers) {
      for (const path of geminiInteractiveEvents[trigger.event] ?? []) paths.add(path);
    }
  }

  return [...paths].map((path) => ({
    path,
    raw: path,
    // Synthetic context has no expression text range in the workflow source.
    range: { start: 0, end: 0 },
    mappedFrom: "provider-implicit-context",
  }));
}
