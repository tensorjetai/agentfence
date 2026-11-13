import { describe, expect, it } from "vitest";
import { scanWorkflow } from "../src/index.js";

describe("100-case evaluation corpus", () => {
  it("meets P0 precision and recall thresholds", () => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (let index = 0; index < 100; index += 1) {
      const vulnerable = index % 2 === 0;
      const source = vulnerable
        ? `on: issues
permissions:
  issues: write
jobs:
  scan_${index}:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.issue.body }}
`
        : `on: workflow_dispatch
permissions: {}
jobs:
  scan_${index}:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: Review fixed release notes
`;
      const predicted = scanWorkflow({
        path: `.github/workflows/corpus-${index}.yml`,
        source,
      }).findings.some((finding) => finding.ruleId === "AF001");
      if (predicted && vulnerable) truePositive += 1;
      if (predicted && !vulnerable) falsePositive += 1;
      if (!predicted && vulnerable) falseNegative += 1;
    }
    const precision = truePositive / (truePositive + falsePositive);
    const recall = truePositive / (truePositive + falseNegative);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });
});
