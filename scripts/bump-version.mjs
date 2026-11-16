import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const version = process.argv[2];

if (!version || !SEMVER_RE.test(version)) {
  console.error("Usage: pnpm version:bump <semver>  (e.g. pnpm version:bump 0.1.4)");
  process.exit(1);
}

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function updateJsonVersion(relPath) {
  const fullPath = join(rootDir, relPath);
  const pkg = JSON.parse(await readFile(fullPath, "utf8"));
  pkg.version = version;
  await writeFile(fullPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

async function replaceExact(relPath, pattern, replacement) {
  const fullPath = join(rootDir, relPath);
  const current = await readFile(fullPath, "utf8");
  if (!pattern.test(current)) {
    throw new Error(`Expected pattern ${pattern} not found in ${relPath}`);
  }
  const updated = current.replace(pattern, replacement);
  await writeFile(fullPath, updated, "utf8");
}

await updateJsonVersion("package.json");
await updateJsonVersion("packages/analyzer/package.json");
await updateJsonVersion("packages/policy/package.json");

await replaceExact(
  "packages/analyzer/src/cli.ts",
  /const SCANNER_VERSION = "[^"]+";/,
  `const SCANNER_VERSION = "${version}";`,
);
await replaceExact(
  "packages/analyzer/test/cli.test.ts",
  /output: "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\\n"/,
  `output: "${version}\\n"`,
);
await replaceExact(
  "docs/local-scanner.md",
  /`@tensorjetai\/agentfence` v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/,
  `\`@tensorjetai/agentfence\` v${version}`,
);

console.log(`Bumped AgentFence OSS packages and CLI version to ${version}`);
