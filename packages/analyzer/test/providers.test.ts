import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePolicy } from "@agentfence/policy";
import { parseMarkdownWorkflow, parseYamlWorkflow, ProviderRegistry } from "../src/index.js";
import { scanWorkflow } from "../src/scan.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers");

describe("pinned provider fixtures", () => {
  it.each([
    ["github-agentic-workflows", "github-agentic-safe.md", "github-agentic-vulnerable.md"],
    ["anthropics/claude-code-action", "claude-safe.yml", "claude-vulnerable.yml"],
    ["openai/codex-action", "codex-safe.yml", "codex-vulnerable.yml"],
    ["google-github-actions/run-gemini-cli", "gemini-safe.yml", "gemini-vulnerable.yml"],
  ])("parses safe and vulnerable %s fixtures offline", (provider, safe, vulnerable) => {
    for (const name of [safe, vulnerable]) {
      const source = readFileSync(join(fixtures, name), "utf8");
      const workflow = name.endsWith(".md")
        ? parseMarkdownWorkflow(name, source)
        : parseYamlWorkflow(name, source);
      const agent = workflow.jobs
        .flatMap((job) => job.steps)
        .find((step) => step.uses?.includes(provider) || step.providerId === provider);
      if (provider === "github-agentic-workflows") expect(agent?.providerId).toBe(provider);
      else expect(new ProviderRegistry().match(agent?.uses ?? "")?.profile.id).toBe(provider);
    }
  });

  it("models official GitHub AI Inference prompt inputs and outputs", () => {
    const workflow = parseYamlWorkflow(
      "test.yml",
      `on: issues
jobs:
  x:
    steps:
      - id: ai
        uses: actions/ai-inference@v1
        with:
          prompt: \${{ github.event.issue.body }}
          input: \${{ github.event.issue.title }}
          file_input: \${{ github.event.issue.body }}
          system-prompt: \${{ github.event.issue.body }}
`,
    );
    const parsed = workflow.jobs[0]?.steps[0];
    const agent = parsed ? new ProviderRegistry().decorate(parsed) : undefined;
    expect(agent?.providerId).toBe("actions/ai-inference");
    expect(agent?.promptExpressions.map((item) => item.path)).toEqual([
      "github.event.issue.body",
      "github.event.issue.title",
      "github.event.issue.body",
      "github.event.issue.body",
    ]);
    expect(agent?.outputs).toEqual({ response: "agent output", "response-file": "agent output" });
  });

  it("models Claude Code Base Action prompt, output, permission, and secret inputs", () => {
    const workflow = parseYamlWorkflow(
      "test.yml",
      `on: issues
jobs:
  x:
    steps:
      - id: agent
        uses: anthropics/claude-code-base-action@v1
        with:
          prompt: \${{ github.event.issue.body }}
          prompt_file: prompt.md
          github_token: \${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
`,
    );
    const parsed = workflow.jobs[0]?.steps[0];
    const agent = parsed ? new ProviderRegistry().decorate(parsed) : undefined;
    expect(agent?.providerId).toBe("anthropics/claude-code-base-action");
    expect(agent?.outputs).toEqual({ execution_file: "agent output" });
    expect(agent?.promptExpressions.map((item) => item.path)).toEqual(["github.event.issue.body"]);
  });

  it("decorates AI Inference only when explicitly enabled by policy", () => {
    const source = `on: workflow_dispatch
jobs:
  x:
    steps:
      - id: ai
        uses: actions/ai-inference@v1
        with:
          prompt: summarize
`;
    const policy = (enabled: string) =>
      parsePolicy(`version: 1\nproviders:\n  enabled: [${enabled}]\n`).policy;

    const enabled = scanWorkflow({
      path: "test.yml",
      source,
      policy: policy("actions-ai-inference"),
    });
    expect(enabled.workflow.jobs[0]?.steps[0]?.kind).toBe("agent");
    expect(enabled.workflow.jobs[0]?.steps[0]?.providerId).toBe("actions/ai-inference");

    const disabled = scanWorkflow({ path: "test.yml", source, policy: policy("gemini") });
    expect(disabled.workflow.jobs[0]?.steps[0]?.kind).toBe("action");
    expect(disabled.workflow.jobs[0]?.steps[0]?.outputs).toEqual({});
  });
});
