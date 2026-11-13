import { describe, expect, it } from "vitest";
import { parseYamlWorkflow } from "../src/parse/yaml.js";
import { implicitPromptReferences } from "../src/providers/implicit.js";
import { ProviderRegistry } from "../src/providers/index.js";

function refs(source: string) {
  const workflow = parseYamlWorkflow("workflow.yml", source);
  const job = workflow.jobs[0]!;
  const step = new ProviderRegistry().decorate(job.steps[0]!);
  return implicitPromptReferences(workflow, job, step).map((reference) => reference.path);
}

describe("implicit provider prompt ingestion", () => {
  it("models issue and comment text for Claude interactive issue-comment mode", () => {
    expect(
      refs(
        `on: issue_comment\njobs:\n  x:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n        with:\n          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}\n`,
      ),
    ).toEqual(["github.event.issue.title", "github.event.issue.body", "github.event.comment.body"]);
  });

  it("models PR body and review-comment text for Claude interactive review-comment mode", () => {
    expect(
      refs(
        `on: pull_request_review_comment\njobs:\n  x:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n`,
      ),
    ).toEqual([
      "github.event.pull_request.title",
      "github.event.pull_request.body",
      "github.event.comment.body",
    ]);
  });

  it("does not infer interactive context when an explicit prompt selects agent mode", () => {
    expect(
      refs(
        `on: issue_comment\njobs:\n  x:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n        with:\n          prompt: Review this\n`,
      ),
    ).toEqual([]);
  });

  it("does not infer issue-body ingestion from Gemini event context or an issue number", () => {
    expect(
      refs(
        `on: issues\njobs:\n  x:\n    steps:\n      - uses: google-github-actions/run-gemini-cli@v0\n        with:\n          prompt: Triage issue \${{ github.event.issue.number }}\n`,
      ),
    ).toEqual([]);
  });

  it("does not invent implicit GitHub context for Codex", () => {
    expect(
      refs(
        `on: pull_request\njobs:\n  x:\n    steps:\n      - uses: openai/codex-action@v1\n        with:\n          prompt: Inspect this repository\n`,
      ),
    ).toEqual([]);
  });

  it("does not model unpinned or unsupported Claude versions", () => {
    expect(
      refs(
        `on: issues\njobs:\n  x:\n    steps:\n      - uses: anthropics/claude-code-action@main\n`,
      ),
    ).toEqual([]);
  });
});
