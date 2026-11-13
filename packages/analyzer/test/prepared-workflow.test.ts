import { expect, it } from "vitest";
import { parseYamlWorkflow } from "../src/parse/yaml.js";
import { scanPreparedWorkflow } from "../src/scan.js";

it("analyzes prepared workflow context without reparsing the child source", () => {
  const workflow = parseYamlWorkflow(
    ".github/workflows/child.yml",
    `on: workflow_call
permissions: {}
jobs:
  agent:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: Static prompt
`,
  );
  workflow.triggers = [{ event: "issues" }];
  const result = scanPreparedWorkflow(workflow);
  expect(result.workflow.triggers).toEqual([{ event: "issues" }]);
  expect(result.workflow.jobs[0]?.steps[0]?.kind).toBe("agent");
  expect(workflow.jobs[0]?.steps[0]?.kind).toBe("action");
});
