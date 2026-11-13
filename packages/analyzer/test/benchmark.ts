import { performance } from "node:perf_hooks";
import { scanWorkflow } from "../src/index.js";

const source = `on: pull_request
permissions:
  contents: write
jobs:
  review:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.pull_request.body }}
`;
const durations: number[] = [];
for (let index = 0; index < 200; index += 1) {
  const start = performance.now();
  scanWorkflow({ path: `.github/workflows/benchmark-${index}.yml`, source });
  durations.push(performance.now() - start);
}
durations.sort((left, right) => left - right);
const median = durations[Math.floor(durations.length / 2)] ?? Number.POSITIVE_INFINITY;
console.log(
  JSON.stringify({ files: durations.length, medianMs: Number(median.toFixed(3)), targetMs: 200 }),
);
if (median >= 200) process.exitCode = 1;
