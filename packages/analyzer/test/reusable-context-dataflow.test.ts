import { describe, expect, it } from "vitest";
import { agentOutputShellPath, promptTaintPaths } from "../src/dataflow/index.js";
import { ProviderRegistry } from "../src/providers/index.js";
import { applyWorkflowInvocationContext, resolveReusableWorkflows } from "../src/reusable/index.js";

describe("reusable workflow dataflow context", () => {
  it("resolves caller taint through an env expression function", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "on: issues\njobs:\n  child:\n    uses: ./child.yml\n    with:\n      prompt: ${{ github.event.issue.body }}\n",
      "child.yml":
        "on: workflow_call\njobs:\n  run:\n    env:\n      MESSAGE: ${{ format('prefix {0}', inputs.prompt) }}\n    steps:\n      - uses: openai/codex-action@v1\n        with:\n          prompt: ${{ env.MESSAGE }}\n",
    };
    const resolved = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );
    const child = applyWorkflowInvocationContext(resolved.workflows[1]!);
    child.jobs = child.jobs.map((job) => ({
      ...job,
      steps: job.steps.map((step) => new ProviderRegistry().decorate(step)),
    }));

    const paths = promptTaintPaths(child, child.jobs[0]!, child.jobs[0]!.steps[0]!);
    expect(paths.map((item) => item.source)).toEqual(["github.event.issue.body"]);
  });

  it("does not treat a literal workflow_call default as untrusted input", async () => {
    const files: Record<string, string> = {
      "root.yml": "on: workflow_dispatch\njobs:\n  child:\n    uses: ./child.yml\n",
      "child.yml":
        "on:\n  workflow_call:\n    inputs:\n      prompt:\n        default: trusted-default\njobs:\n  run:\n    env:\n      MESSAGE: ${{ inputs.prompt }}\n    steps:\n      - uses: openai/codex-action@v1\n        with:\n          prompt: ${{ env.MESSAGE }}\n",
    };
    const resolved = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );
    const child = applyWorkflowInvocationContext(resolved.workflows[1]!);
    child.jobs = child.jobs.map((job) => ({
      ...job,
      steps: job.steps.map((step) => new ProviderRegistry().decorate(step)),
    }));

    expect(promptTaintPaths(child, child.jobs[0]!, child.jobs[0]!.steps[0]!)).toEqual([]);
  });

  it("resolves a reusable output reference at a downstream shell sink", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "on: workflow_dispatch\njobs:\n  child:\n    uses: ./child.yml\n  consume:\n    needs: child\n    steps:\n      - run: echo ${{ needs.child.outputs.answer }}\n",
      "child.yml":
        "on:\n  workflow_call:\n    outputs:\n      answer:\n        value: ${{ jobs.build.outputs.result }}\njobs:\n  build:\n    outputs:\n      result: ${{ steps.agent.outputs.final-message }}\n    steps:\n      - id: agent\n        uses: openai/codex-action@v1\n        with:\n          prompt: do work\n",
    };
    const resolved = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );
    const root = resolved.workflows[0]!;
    const sinkJob = root.jobs[1]!;

    expect(agentOutputShellPath(root, sinkJob, sinkJob.steps[0]!)).toMatchObject({
      label: "AGENT_OUTPUT",
      source: "needs.child.outputs.answer",
    });
    expect(resolved.diagnostics.some((item) => item.code === "reusable-output-unsupported")).toBe(
      false,
    );
  });
});
