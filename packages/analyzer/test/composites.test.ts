import { describe, expect, it } from "vitest";
import { parseYamlWorkflow } from "../src/parse/yaml.js";
import { expandCompositeActions } from "../src/composites/index.js";

describe("expandCompositeActions", () => {
  it("expands nested local composites with scoped IDs, defaults, and caller context", async () => {
    const workflow = parseYamlWorkflow(
      ".github/workflows/ci.yml",
      `on: pull_request\njobs:\n  test:\n    env:\n      ROOT_ENV: inherited\n    steps:\n      - id: setup\n        uses: ./.github/actions/outer\n        with:\n          prompt: \${{ github.event.pull_request.title }}\n      - run: echo \${{ steps.setup.outputs.result }}\n`,
    );
    const files: Record<string, string> = {
      ".github/actions/outer/action.yml": `name: outer\ninputs:\n  prompt:\n    required: true\noutputs:\n  result:\n    value: \${{ steps.inner.outputs.answer }}\nruns:\n  using: composite\n  steps:\n    - id: inner\n      uses: ./.github/actions/inner\n      with:\n        text: \${{ inputs.prompt }}\n`,
      ".github/actions/inner/action.yaml": `name: inner\ninputs:\n  text:\n    default: fallback\noutputs:\n  answer:\n    value: \${{ steps.emit.outputs.answer }}\nruns:\n  using: composite\n  steps:\n    - id: emit\n      shell: bash\n      run: echo \${{ inputs.text }} \${{ env.ROOT_ENV }}\n`,
    };

    const result = await expandCompositeActions(workflow, async (path) => files[path]);

    expect(result.diagnostics).toEqual([]);
    expect(result.workflow.completeness).toBe("complete");
    const steps = result.workflow.jobs[0]!.steps;
    expect(steps.map((step) => step.id)).toEqual([
      "__af_composite_call_1__inner__emit",
      "__af_composite_call_1__inner",
      "setup",
      undefined,
    ]);
    expect(steps[0]?.run).toContain("inputs.text");
    expect(steps[0]?.expressionBindings?.run?.map((item) => item.path)).toContain(
      "github.event.pull_request.title",
    );
    expect(steps[0]?.env.ROOT_ENV).toBe("inherited");
    expect(steps[0]?.range.path).toBe(".github/actions/inner/action.yaml");
    expect(steps[2]?.outputs.result).toBe("\${{ steps.inner.outputs.answer }}");
    expect(steps[2]?.expressionBindings?.["outputs.result"]?.[0]?.path).toBe(
      "steps.__af_composite_call_1__inner.outputs.answer",
    );
    expect(steps[2]?.range.path).toBe(".github/actions/outer/action.yml");
  });

  it("reports unsupported local action kinds and traversal without treating them as clean", async () => {
    const workflow = parseYamlWorkflow(
      "workflows/ci.yml",
      "jobs:\n  test:\n    steps:\n      - uses: ./actions/docker\n      - uses: ../../outside\n",
    );
    const files: Record<string, string> = {
      "actions/docker/action.yml": "runs:\n  using: docker\n  image: Dockerfile\n",
    };
    const result = await expandCompositeActions(workflow, async (path) => files[path]);

    expect(result.workflow.jobs[0]?.steps).toHaveLength(2);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["composite-unsupported-action", "composite-invalid-path"]),
    );
    expect(result.completeness).toBe("partial");
  });

  it("bounds recursive composite expansion", async () => {
    const workflow = parseYamlWorkflow(
      "workflow.yml",
      "jobs:\n  test:\n    steps:\n      - id: cycle\n        uses: ./actions/a\n",
    );
    const files: Record<string, string> = {
      "actions/a/action.yml":
        "runs:\n  using: composite\n  steps:\n    - id: next\n      uses: ./actions/b\n",
      "actions/b/action.yml":
        "runs:\n  using: composite\n  steps:\n    - id: again\n      uses: ./actions/a\n",
    };

    const result = await expandCompositeActions(workflow, async (path) => files[path]);

    expect(result.diagnostics.map((item) => item.code)).toContain("composite-cycle");
    expect(result.completeness).toBe("partial");
  });

  it("keeps source text intact and does not scope caller-provided step references", async () => {
    const workflow = parseYamlWorkflow(
      "workflow.yml",
      `jobs:\n  test:\n    steps:\n      - id: collect\n        uses: ./actions/show\n        with:\n          value: \${{ steps.agent.outputs.value }}\n      - uses: ./actions/show\n        with:\n          value: \${{ steps.agent.outputs.value }}\n`,
    );
    const files: Record<string, string> = {
      "actions/show/action.yml": `inputs:\n  value:\n    default: fallback\nruns:\n  using: composite\n  steps:\n    - run: echo \${{ inputs.value }}\n`,
    };

    const result = await expandCompositeActions(workflow, async (path) => files[path]);
    const expandedSteps = result.workflow.jobs[0]!.steps;
    const [first, second] = [
      expandedSteps.find((step) => step.run),
      expandedSteps.filter((step) => step.run)[1],
    ];

    expect(first?.run).toBe("echo ${{ inputs.value }}");
    expect(first?.expressionBindings?.run?.map((item) => item.path)).toEqual([
      "steps.agent.outputs.value",
    ]);
    expect(second?.id).toBeUndefined();
    expect(second?.expressionBindings?.run?.[0]?.path).toBe("steps.agent.outputs.value");
  });

  it("treats expression-looking metadata defaults as literal input values", async () => {
    const workflow = parseYamlWorkflow(
      "workflow.yml",
      "jobs:\n  test:\n    steps:\n      - uses: ./actions/show\n",
    );
    const files: Record<string, string> = {
      "actions/show/action.yml": `inputs:\n  value:\n    default: '\${{ steps.agent.outputs.value }}'\nruns:\n  using: composite\n  steps:\n    - run: echo \${{ inputs.value }}\n`,
    };

    const result = await expandCompositeActions(workflow, async (path) => files[path]);
    const expanded = result.workflow.jobs[0]!.steps[0]!;

    expect(expanded.run).toBe("echo ${{ inputs.value }}");
    expect(expanded.expressionBindings?.run).toEqual([]);
  });

  it("gives repeated anonymous nested composites distinct internal IDs", async () => {
    const workflow = parseYamlWorkflow(
      "workflow.yml",
      "jobs:\n  test:\n    steps:\n      - uses: ./actions/parent\n",
    );
    const files: Record<string, string> = {
      "actions/parent/action.yml":
        "runs:\n  using: composite\n  steps:\n    - uses: ./actions/child\n    - uses: ./actions/child\n",
      "actions/child/action.yml":
        "runs:\n  using: composite\n  steps:\n    - id: work\n      run: echo ok\n",
    };

    const result = await expandCompositeActions(workflow, async (path) => files[path]);
    const ids = result.workflow.jobs[0]!.steps.map((step) => step.id);

    expect(ids).toEqual([
      "__af_composite_call_1__anonymous_1__work",
      "__af_composite_call_1__anonymous_2__work",
    ]);
  });

  it("preserves the caller condition on every expanded step", async () => {
    const workflow = parseYamlWorkflow(
      "workflow.yml",
      `jobs:\n  test:\n    steps:\n      - id: guarded\n        if: \${{ github.event.pull_request.head.repo.fork == false }}\n        uses: ./actions/guarded\n`,
    );
    const files: Record<string, string> = {
      "actions/guarded/action.yml":
        "runs:\n  using: composite\n  steps:\n    - run: echo trusted\n",
    };

    const result = await expandCompositeActions(workflow, async (path) => files[path]);
    const expanded = result.workflow.jobs[0]!.steps[0]!;

    expect(expanded.if).toContain("github.event.pull_request.head.repo.fork == false");
    expect(expanded.expressionBindings?.if?.[0]?.path).toBe(
      "github.event.pull_request.head.repo.fork",
    );
  });

  it("rejects oversized action metadata before YAML parsing", async () => {
    const workflow = parseYamlWorkflow(
      "workflow.yml",
      "jobs:\n  test:\n    steps:\n      - uses: ./actions/large\n",
    );
    const files: Record<string, string> = {
      "actions/large/action.yml": `runs:\n  using: composite\n  steps: []\n#${"x".repeat(1_000_001)}`,
    };

    const result = await expandCompositeActions(workflow, async (path) => files[path]);

    expect(result.diagnostics.map((item) => item.code)).toContain("composite-parse-error");
    expect(result.completeness).toBe("partial");
  });
});
