import { build } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";

mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/src/", import.meta.url), { recursive: true });

const outfile = new URL("../dist/cli-entry.js", import.meta.url);
const compatOutfile = new URL("../dist/src/cli-entry.js", import.meta.url);

await build({
  entryPoints: [new URL("../src/cli-entry.ts", import.meta.url).pathname],
  outfile: outfile.pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  external: ["node:*"],
});

chmodSync(outfile, 0o755);
copyFileSync(outfile, compatOutfile);
chmodSync(compatOutfile, 0o755);
