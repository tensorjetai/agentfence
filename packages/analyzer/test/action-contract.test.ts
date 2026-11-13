import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("local Action contract", () => {
  it("passes target input as an environment value, never as shell code", () => {
    const action = parse(readFileSync("action.yml", "utf8"));
    const scan = action.runs.steps.find((step: { id?: string }) => step.id === "scan");
    expect(scan.env.AGENTFENCE_INPUT_PATH).toBe("${{ inputs.path }}");
    expect(scan.run).not.toContain("${{ inputs.");
    expect(scan.run).toContain('"$AGENTFENCE_INPUT_PATH"');
    expect(scan.run).toContain('exit "$status"');
    expect(action.runs.steps.some((step: { uses?: string }) => step.uses?.includes("upload"))).toBe(
      false,
    );
  });

  it("builds scanner dependencies at the action checkout with install scripts disabled", () => {
    const action = parse(readFileSync("action.yml", "utf8"));
    const build = action.runs.steps.find(
      (step: { name?: string }) => step.name === "Build scanner",
    );
    expect(build.run).toContain('--dir "$AGENTFENCE_ACTION_PATH"');
    expect(build.run).toContain("--frozen-lockfile --ignore-scripts");
  });
});
