import { createBenchmarkReport } from "./benchmark-runner.js";

const report = createBenchmarkReport();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode =
  report.fixtureCoverage === 1 && report.completenessMatches === report.fixtureCount ? 0 : 1;
