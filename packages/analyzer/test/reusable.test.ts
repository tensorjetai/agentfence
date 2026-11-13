import { describe, expect, it } from "vitest";
import { applyWorkflowInvocationContext, resolveReusableWorkflows } from "../src/index.js";

describe("resolveReusableWorkflows", () => {
  it("resolves nested local calls and maps caller inputs", async () => {
    const files: Record<string, string> = {
      ".github/workflows/root.yml":
        "on: workflow_dispatch\njobs:\n  child:\n    uses: ./.github/workflows/child.yml\n    with:\n      prompt: ${{ inputs.text }}\n",
      ".github/workflows/child.yml":
        "on:\n  workflow_call:\n    inputs:\n      prompt: {}\njobs:\n  run:\n    uses: ./.github/workflows/leaf.yml\n",
      ".github/workflows/leaf.yml":
        "on: workflow_call\njobs:\n  done:\n    steps:\n      - run: echo ok\n",
    };
    const result = await resolveReusableWorkflows(
      ".github/workflows/root.yml",
      files[".github/workflows/root.yml"]!,
      async (path) => files[path],
    );
    expect(result.workflows.map((workflow) => workflow.path)).toEqual(Object.keys(files));
    expect(
      result.diagnostics.every((item) => item.code === "reusable-unknown-permission-ceiling"),
    ).toBe(true);
    expect(result.completeness).toBe("partial");
  });

  it("terminates cycles and depth overflow", async () => {
    const files: Record<string, string> = {
      "a.yml": "jobs:\n  b:\n    uses: ./b.yml\n",
      "b.yml": "jobs:\n  a:\n    uses: ./a.yml\n",
    };
    const result = await resolveReusableWorkflows(
      "a.yml",
      files["a.yml"]!,
      async (path) => files[path],
      1,
    );
    expect(result.completeness).toBe("partial");
    expect(
      result.diagnostics.some(
        (item) => item.code === "reusable-cycle" || item.code === "reusable-depth",
      ),
    ).toBe(true);
  });

  it("keeps a bounded context for each local workflow invocation", async () => {
    const files: Record<string, string> = {
      ".github/workflows/root.yml":
        "on: workflow_dispatch\njobs:\n  first:\n    uses: ./.github/workflows/child.yml\n    with:\n      prompt: ${{ github.event.issue.body }}\n    secrets:\n      token: ${{ secrets.FIRST_TOKEN }}\n  second:\n    uses: ./.github/workflows/child.yml\n    with:\n      prompt: trusted text\n    secrets: inherit\n",
      ".github/workflows/child.yml":
        "on:\n  workflow_call:\n    inputs:\n      prompt: {}\n    secrets:\n      token: {}\njobs:\n  run:\n    steps:\n      - run: echo ${{ inputs.prompt }}\n",
    };
    const result = await resolveReusableWorkflows(
      ".github/workflows/root.yml",
      files[".github/workflows/root.yml"]!,
      async (path) => files[path],
    );

    const children = result.workflows.filter((workflow) => workflow.path.endsWith("/child.yml"));
    expect(children).toHaveLength(2);
    expect(children.map((workflow) => workflow.invocation?.callerJobId)).toEqual([
      "first",
      "second",
    ]);
    expect(children[0]?.invocation?.inputs).toEqual({ prompt: "${{ github.event.issue.body }}" });
    const contextual = applyWorkflowInvocationContext(children[0]!);
    expect(contextual.jobs[0]?.steps[0]?.expressions[0]?.path).toBe("github.event.issue.body");
    expect(contextual.jobs[0]?.steps[0]?.expressions[0]?.raw).toBe("inputs.prompt");
    expect(children[0]?.invocation?.secrets).toEqual({ token: "${{ secrets.FIRST_TOKEN }}" });
    expect(children[1]?.invocation?.secrets).toEqual({ "*": "inherit" });
  });

  it("resolves nested input references through each caller without rewriting source", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "permissions:\n  contents: read\non: pull_request\njobs:\n  child:\n    uses: ./child.yml\n    with:\n      prompt: ${{ github.event.issue.body }}\n",
      "child.yml":
        "on: workflow_call\njobs:\n  leaf:\n    uses: ./leaf.yml\n    with:\n      prompt: ${{ inputs.prompt }}\n",
      "leaf.yml":
        "on: workflow_call\njobs:\n  run:\n    steps:\n      - run: echo ${{ inputs.prompt }}\n",
    };
    const result = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );
    const leaf = result.workflows.find((workflow) => workflow.path === "leaf.yml")!;
    const mapped = applyWorkflowInvocationContext(leaf).jobs[0]?.steps[0]?.expressions[0];

    expect(mapped?.path).toBe("github.event.issue.body");
    expect(mapped?.raw).toBe("inputs.prompt");
    expect(leaf.permissions).toEqual({ contents: "read" });
    expect(result.diagnostics).toEqual([]);
  });

  it("maps supported expression references through env and applies workflow_call defaults", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "on: workflow_dispatch\njobs:\n  child:\n    uses: ./child.yml\n    with:\n      supplied: ${{ github.event.issue.body }}\n",
      "child.yml":
        "on:\n  workflow_call:\n    inputs:\n      supplied: {}\n      fallback:\n        default: trusted-default\njobs:\n  run:\n    env:\n      MESSAGE: ${{ format('prefix {0}', inputs.supplied) }}\n    steps:\n      - run: echo ${{ inputs.supplied && env.MESSAGE }} ${{ inputs.fallback }}\n",
    };
    const result = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );
    const child = result.workflows.find((workflow) => workflow.path === "child.yml")!;
    const mapped = applyWorkflowInvocationContext(child);

    expect(mapped.jobs[0]?.steps[0]?.expressions.map((item) => item.path)).toEqual([
      "github.event.issue.body",
      "env.MESSAGE",
    ]);
    expect(mapped.jobs[0]?.steps[0]?.expressions[0]?.raw).toBe("inputs.supplied");
    expect(mapped.jobs[0]?.steps[0]?.expressions[0]?.mappedFrom).toBe("inputs.supplied");
    expect(mapped.invocation?.inputs.fallback).toBe("trusted-default");
    expect(result.diagnostics.some((item) => item.code === "reusable-input-in-env")).toBe(false);
    expect(
      result.diagnostics.some((item) => item.code === "reusable-unsupported-input-expression"),
    ).toBe(false);
  });

  it("projects workflow_call outputs onto the reusable caller job", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "on: workflow_dispatch\njobs:\n  child:\n    uses: ./child.yml\n  consume:\n    needs: child\n    steps:\n      - run: echo ${{ needs.child.outputs.answer }}\n",
      "child.yml":
        "on:\n  workflow_call:\n    outputs:\n      answer:\n        value: ${{ jobs.build.outputs.result }}\njobs:\n  build:\n    outputs:\n      result: ${{ steps.agent.outputs.final-message }}\n    steps:\n      - id: agent\n        uses: openai/codex-action@v1\n        with:\n          prompt: do work\n",
    };
    const result = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );
    const root = result.workflows[0]!;
    expect(root.jobs[0]?.reusableOutputSources?.answer).toEqual([
      "steps.agent.outputs.final-message",
    ]);
    expect(result.diagnostics.some((item) => item.code === "reusable-output-unsupported")).toBe(
      false,
    );
  });

  it("projects workflow_call outputs through nested reusable calls", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "on: workflow_dispatch\njobs:\n  middle:\n    uses: ./middle.yml\n  consume:\n    needs: middle\n    steps:\n      - run: echo ${{ needs.middle.outputs.answer }}\n",
      "middle.yml":
        "on:\n  workflow_call:\n    outputs:\n      answer:\n        value: ${{ jobs.leaf.outputs.result }}\njobs:\n  leaf:\n    uses: ./leaf.yml\n",
      "leaf.yml":
        "on:\n  workflow_call:\n    outputs:\n      result:\n        value: ${{ jobs.build.outputs.result }}\njobs:\n  build:\n    outputs:\n      result: ${{ steps.agent.outputs.final-message }}\n    steps:\n      - id: agent\n        uses: openai/codex-action@v1\n        with:\n          prompt: do work\n",
    };
    const result = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );

    expect(result.workflows[0]?.jobs[0]?.reusableOutputSources?.answer).toEqual([
      "steps.agent.outputs.final-message",
    ]);
    expect(result.diagnostics.some((item) => item.code === "reusable-output-unsupported")).toBe(
      false,
    );
  });

  it("keeps workflow output provenance scoped to its producing job", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "on: workflow_dispatch\njobs:\n  child:\n    uses: ./child.yml\n  consume:\n    needs: child\n    steps:\n      - run: echo ${{ needs.child.outputs.answer }}\n",
      "child.yml":
        "on:\n  workflow_call:\n    outputs:\n      answer:\n        value: ${{ jobs.build.outputs.result }}\njobs:\n  other:\n    steps:\n      - id: agent\n        uses: openai/codex-action@v1\n        with:\n          prompt: work\n  build:\n    outputs:\n      result: ${{ steps.agent.outputs.final-message }}\n    steps:\n      - id: setup\n        run: echo setup\n",
    };
    const result = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );

    expect(result.workflows[0]?.jobs[0]?.reusableOutputSources?.answer).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "reusable-output-unsupported")).toBe(
      true,
    );
  });

  it("does not project disabled providers as reusable agent outputs", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "on: workflow_dispatch\njobs:\n  child:\n    uses: ./child.yml\n  consume:\n    needs: child\n    steps:\n      - run: echo ${{ needs.child.outputs.answer }}\n",
      "child.yml":
        "on:\n  workflow_call:\n    outputs:\n      answer:\n        value: ${{ jobs.build.outputs.result }}\njobs:\n  build:\n    outputs:\n      result: ${{ steps.agent.outputs.final-message }}\n    steps:\n      - id: agent\n        uses: openai/codex-action@v1\n        with:\n          prompt: work\n",
    };
    const result = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
      5,
      { enabledProviders: ["gemini"] },
    );

    expect(result.workflows[0]?.jobs[0]?.reusableOutputSources?.answer).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "reusable-output-unsupported")).toBe(
      true,
    );
  });

  it("caps child job permissions and fails closed on unsupported reusable behavior", async () => {
    const files: Record<string, string> = {
      "root.yml":
        "permissions: read-all\non: workflow_dispatch\njobs:\n  shared:\n    uses: ./child.yml\n  remote:\n    uses: org/repo/.github/workflows/build.yml@main\n  consume:\n    steps:\n      - uses: ./actions/local\n        with:\n          value: ${{ needs.shared.outputs.value }}\n",
      "child.yml":
        "on:\n  workflow_call:\npermissions:\n  contents: write\njobs:\n  run:\n    permissions:\n      contents: write\n    steps:\n      - run: echo ok\n",
    };
    const result = await resolveReusableWorkflows(
      "root.yml",
      files["root.yml"]!,
      async (path) => files[path],
    );
    const child = result.workflows.find((workflow) => workflow.path === "child.yml")!;

    expect(child.permissions).toEqual({ contents: "read" });
    expect(child.jobs[0]?.permissions).toEqual({ contents: "read" });
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "reusable-remote-unsupported",
        "reusable-local-action-unsupported",
        "reusable-output-unsupported",
      ]),
    );
    expect(result.completeness).toBe("partial");
  });
});
