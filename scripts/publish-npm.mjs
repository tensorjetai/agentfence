import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = [
  { name: "agentfence-cli", access: null },
  { name: "@tensorjetai/agentfence", access: "public" },
];

function parseArgs(argv) {
  const npmFlags = [];
  let only = null;
  let skipBuild = false;
  let packOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--pack-only") {
      packOnly = true;
      continue;
    }
    if (arg === "--only" || arg === "--package") {
      only = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith("--only=") || arg.startsWith("--package=")) {
      only = arg.slice(arg.indexOf("=") + 1);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: pnpm publish:npm [--dry-run] [--pack-only] [--tag <dist-tag>] [--otp <code>] [--only <pkg>] [--skip-build]",
          "",
          "Builds @agentfence/analyzer once and publishes clean staged tarballs for:",
          "  - agentfence-cli",
          "  - @tensorjetai/agentfence",
        ].join("\n"),
      );
      process.exit(0);
    }
    npmFlags.push(arg);
  }

  const selected = only ? TARGETS.filter((target) => target.name === only) : TARGETS;
  if (selected.length === 0) {
    throw new Error(
      `Unknown package "${only}". Expected one of: ${TARGETS.map((t) => t.name).join(", ")}`,
    );
  }

  return { selected, npmFlags, skipBuild, packOnly };
}

function buildPublishManifest(sourcePkg, targetName) {
  return {
    name: targetName,
    version: sourcePkg.version,
    description: sourcePkg.description,
    license: sourcePkg.license,
    type: sourcePkg.type,
    engines: sourcePkg.engines,
    bin: sourcePkg.bin,
    files: sourcePkg.files,
    exports: {
      ".": {
        types: "./dist/src/index.d.ts",
        default: "./dist/src/index.js",
      },
    },
    dependencies: sourcePkg.dependencies ?? {},
    ...(targetName.startsWith("@") ? { publishConfig: { access: "public" } } : {}),
  };
}

async function stagePackage(analyzerDir, stageDir, sourcePkg, target) {
  await mkdir(join(stageDir, "dist"), { recursive: true });

  const cliEntry = join(stageDir, "dist", "cli-entry.js");
  await cp(join(analyzerDir, "dist", "cli-entry.js"), cliEntry);
  await chmod(cliEntry, 0o755);

  await cp(join(analyzerDir, "dist", "src"), join(stageDir, "dist", "src"), {
    recursive: true,
    filter: (src) => basename(src) !== ".DS_Store",
  });

  await cp(join(analyzerDir, "README.md"), join(stageDir, "README.md"));
  await cp(join(analyzerDir, "LICENSE"), join(stageDir, "LICENSE"));

  const manifest = buildPublishManifest(sourcePkg, target.name);
  await writeFile(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function main() {
  const { selected, npmFlags, skipBuild, packOnly } = parseArgs(process.argv.slice(2));
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const analyzerDir = join(rootDir, "packages", "analyzer");

  if (!skipBuild) {
    execFileSync("pnpm", ["--filter", "@agentfence/analyzer...", "build"], {
      cwd: rootDir,
      stdio: "inherit",
    });
  }

  const sourcePkg = JSON.parse(await readFile(join(analyzerDir, "package.json"), "utf8"));
  const stagingRoot = await mkdtemp(join(tmpdir(), "agentfence-npm-publish-"));

  try {
    for (const target of selected) {
      const folderName = target.name.replace(/^@/, "").replace(/\//g, "__");
      const stageDir = join(stagingRoot, folderName);
      await stagePackage(analyzerDir, stageDir, sourcePkg, target);

      const args = packOnly ? ["pack", "--dry-run"] : ["publish", ...npmFlags];
      if (!packOnly && target.access && !args.includes("--access")) {
        args.push("--access", target.access);
      }

      console.log(`\n=== npm ${args.join(" ")} (${target.name}@${sourcePkg.version}) ===`);
      execFileSync("npm", args, {
        cwd: stageDir,
        stdio: "inherit",
      });
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

await main();
