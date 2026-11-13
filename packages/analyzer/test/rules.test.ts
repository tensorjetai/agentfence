import { parsePolicy } from "@agentfence/policy";
import { describe, expect, it } from "vitest";
import { scanWorkflow } from "../src/index.js";

const scan = (source: string, policy?: ReturnType<typeof parsePolicy>["policy"]) =>
  scanWorkflow({ path: ".github/workflows/test.yml", source, ...(policy ? { policy } : {}) });

describe("AF001 through AF006", () => {
  it("AF001 reports untrusted input reaching a write-capable agent", () => {
    expectRules(
      `on: issues
permissions:
  issues: write
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.issue.body }}
`,
      ["AF001"],
    );
  });

  it("limits prompt taint to provider-declared prompt inputs", () => {
    const staticPrompt = scan(`on: workflow_dispatch
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          openai-api-key: \${{ secrets.OPENAI_API_KEY }}
          prompt: inspect
`);
    expect(staticPrompt.findings.some((item) => item.ruleId === "AF001")).toBe(false);
    expect(staticPrompt.findings.some((item) => item.ruleId === "AF006")).toBe(false);

    const unrelatedInput = scan(`on: issues
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          openai-api-key: \${{ github.event.issue.body }}
          prompt: inspect
`);
    expect(unrelatedInput.findings.some((item) => item.ruleId === "AF001")).toBe(false);
  });

  it("AF002 reports only outputs from a recognized agent reaching shell", () => {
    expectRules(
      `on: workflow_dispatch
jobs:
  x:
    steps:
      - id: ai
        uses: openai/codex-action@v1
        with:
          prompt: inspect
      - run: \${{ steps.ai.outputs.final-message }}
`,
      ["AF002"],
    );
    expect(
      scan(`on: workflow_dispatch
jobs:
  x:
    steps:
      - id: data
        uses: actions/cache@v4
      - run: \${{ steps.data.outputs.cache-hit }}
`).findings.some((item) => item.ruleId === "AF002"),
    ).toBe(false);
    expectRules(
      `on: workflow_dispatch
jobs:
  x:
    steps:
      - id: ai
        uses: openai/codex-action@v1
        with:
          prompt: inspect
      - env:
          COMMAND: \${{ steps.ai.outputs.final-message }}
        run: \${{ env.COMMAND }}
`,
      ["AF002"],
    );
    expectRules(
      `on: workflow_dispatch
jobs:
  generate:
    outputs:
      command: \${{ steps.ai.outputs.final-message }}
    steps:
      - id: ai
        uses: openai/codex-action@v1
        with:
          prompt: inspect
  execute:
    needs: generate
    steps:
      - run: \${{ needs.generate.outputs.command }}
`,
      ["AF002"],
    );
    expect(
      scan(`on: workflow_dispatch
jobs:
  x:
    steps:
      - id: ai
        uses: openai/codex-action@v1
        with:
          prompt: inspect
      - env:
          UNUSED: \${{ steps.ai.outputs.final-message }}
        run: echo safe
`).findings.some((item) => item.ruleId === "AF002"),
    ).toBe(false);
  });

  it("detects Claude Code Base Action risks across prompt, output, trigger, permissions, and secrets", () => {
    expectRules(
      `on: issues
permissions:
  contents: write
  issues: write
jobs:
  x:
    steps:
      - id: agent
        uses: anthropics/claude-code-base-action@v1
        with:
          prompt: \${{ github.event.issue.body }}
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
      - run: gh issue edit --body "\${{ steps.agent.outputs.execution_file }}"
`,
      ["AF001", "AF002", "AF004", "AF005", "AF006"],
    );
  });

  it("AF003 reports contributor checkout in privileged job", () => {
    expectRules(
      `on: pull_request
permissions:
  contents: write
jobs:
  x:
    steps:
      - uses: actions/checkout@v5
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`,
      ["AF003"],
    );
    expectRules(
      `on: pull_request
jobs:
  x:
    steps:
      - uses: actions/checkout@v5
      - env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        run: ./deploy.sh
`,
      ["AF003"],
    );

    expectRules(
      `on: pull_request
permissions:
  contents: write
jobs:
  x:
    steps:
      - uses: actions/checkout@v5
`,
      ["AF003"],
    );
  });

  it("AF004 accepts a static actor-association gate", () => {
    const open = `on: issue_comment
jobs:
  x:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.comment.body }}
`;
    expectRules(open, ["AF004"]);
    expect(
      scan(
        open.replace(
          "steps:",
          "if: github.event.comment.author_association == 'MEMBER'\n    steps:",
        ),
      ).findings.some((item) => item.ruleId === "AF004"),
    ).toBe(false);
  });

  it("recognizes Codex's default human write-actor guard without trusting PR content", () => {
    const claude = scan(`on: issue_comment
jobs:
  x:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          prompt: \${{ github.event.comment.body }}
`);
    expect(claude.findings.some((item) => item.ruleId === "AF004")).toBe(true);
    const codex = scan(`on: issue_comment
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.comment.body }}
`);
    expect(codex.findings.some((item) => item.ruleId === "AF004")).toBe(false);

    const pr = scan(`on: pull_request_target
permissions:
  contents: write
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.pull_request.body }}
`);
    expect(pr.findings.some((item) => item.ruleId === "AF001")).toBe(true);
    expect(pr.findings.some((item) => item.ruleId === "AF004")).toBe(false);
  });

  it("does not infer a default actor guard when provider configuration permits non-writers", () => {
    expect(
      scan(`on: issue_comment
jobs:
  x:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          allowed_non_write_users: '*'
          prompt: \${{ github.event.comment.body }}
`).findings.some((item) => item.ruleId === "AF004"),
    ).toBe(true);
    expect(
      scan(`on: issues
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          allow-users: '*'
          prompt: \${{ github.event.issue.body }}
`).findings.some((item) => item.ruleId === "AF004"),
    ).toBe(true);
    expect(
      scan(`on: issue_comment
jobs:
  x:
    steps:
      - uses: openai/codex-action@v2
        with:
          prompt: \${{ github.event.comment.body }}
`).findings.some((item) => item.ruleId === "AF004"),
    ).toBe(true);
    expect(
      scan(`on: issue_comment
jobs:
  x:
    steps:
      - uses: openai/codex-action@0123456789abcdef0123456789abcdef01234567
        with:
          prompt: \${{ github.event.comment.body }}
`).findings.some((item) => item.ruleId === "AF004"),
    ).toBe(true);
    expect(
      scan(`on: issue_comment
jobs:
  x:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          allowed_non_write_users: \${{ vars.ALLOWED_USERS }}
          prompt: \${{ github.event.comment.body }}
`).findings.some((item) => item.ruleId === "AF004"),
    ).toBe(true);
    expect(
      scan(`on: issue_comment
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          allow-bots: \${{ vars.ALLOW_BOTS }}
          prompt: \${{ github.event.comment.body }}
`).findings.some((item) => item.ruleId === "AF004"),
    ).toBe(true);
  });

  it("tracks untrusted text and outputs from GitHub AI Inference", () => {
    const result = scan(`on: issues
permissions:
  issues: write
jobs:
  x:
    steps:
      - id: inference
        uses: actions/ai-inference@v1
        with:
          prompt: \${{ github.event.issue.body }}
      - run: echo \${{ steps.inference.outputs.response }}
`);
    expect(result.findings.some((item) => item.ruleId === "AF001")).toBe(true);
    expect(result.findings.some((item) => item.ruleId === "AF002")).toBe(true);

    const plainInference = scan(`on: issues
jobs:
  x:
    steps:
      - uses: actions/ai-inference@v1
        with:
          prompt: \${{ github.event.issue.body }}
`);
    expect(plainInference.findings.some((item) => item.ruleId === "AF001")).toBe(false);

    const shellEnabled = scan(`on: issues
jobs:
  x:
    steps:
      - uses: actions/ai-inference@v1
        with:
          copilot-allow-tools: shell(git:*)
          prompt: \${{ github.event.issue.body }}
`);
    expect(shellEnabled.findings.some((item) => item.ruleId === "AF001")).toBe(true);
  });

  it("AF005 reports broad write permissions", () => {
    expectRules(
      `on: workflow_dispatch
permissions: write-all
jobs:
  x:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: inspect
`,
      ["AF005"],
    );
    expectRules(
      `on: workflow_dispatch
jobs:
  x:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: inspect
`,
      ["AF005"],
    );
    expect(
      scan(`on: workflow_dispatch
permissions: {}
jobs:
  x:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: inspect
`).findings.some((item) => item.ruleId === "AF005"),
    ).toBe(false);
  });

  it("AF006 reports secret availability with attacker-controlled prompt", () => {
    expectRules(
      `on: pull_request
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          openai-api-key: \${{ secrets.OPENAI_API_KEY }}
          prompt: \${{ github.event.pull_request.body }}
`,
      ["AF006"],
    );
    expectRules(
      `on: pull_request
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        env:
          OPENAI_API_KEY: \${{ secrets['OPENAI_API_KEY'] }}
        with:
          prompt: \${{ github.event.pull_request.body }}
`,
      ["AF006"],
    );

    const unrelatedSecret = scan(`on: pull_request
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.pull_request.body }}
      - env:
          DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        run: echo deploy
`);
    expect(unrelatedSecret.findings.some((item) => item.ruleId === "AF006")).toBe(false);
  });

  it("tracks untrusted input through workflow and job environment variables", () => {
    expectRules(
      `on: issues
env:
  REQUEST: \${{ github.event.issue.body }}
permissions:
  issues: write
jobs:
  x:
    env:
      PROMPT: \${{ env.REQUEST }}
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ env.PROMPT }}
`,
      ["AF001"],
    );
  });

  it("does not accept a mere actor reference as a trust gate", () => {
    expectRules(
      `on: issue_comment
jobs:
  x:
    if: github.actor != ''
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.comment.body }}
`,
      ["AF004"],
    );
    expectRules(
      `on: issue_comment
jobs:
  x:
    steps:
      - if: github.event.comment.author_association == 'MEMBER'
        run: echo trusted
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.comment.body }}
`,
      ["AF004"],
    );
  });

  it("infers Gemini event context only when prompt is empty or omitted", () => {
    const implicit = scan(`on: pull_request_target
permissions:
  contents: write
jobs:
  x:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
`);
    expect(implicit.findings.some((item) => item.ruleId === "AF001")).toBe(true);
    const explicit = scan(`on: pull_request_target
permissions:
  contents: write
jobs:
  x:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: summarize the repository
`);
    expect(explicit.findings.some((item) => item.ruleId === "AF001")).toBe(false);
    expect(explicit.findings.some((item) => item.ruleId === "AF004")).toBe(true);
  });

  it("does not taint non-text issue metadata as prompt injection", () => {
    const result = scan(`on: issues
permissions:
  issues: write
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.issue.number }}
`);
    expect(result.findings.some((item) => item.ruleId === "AF001")).toBe(false);
  });

  it("applies reasoned suppressions but never hides incomplete analysis", () => {
    const policy = parsePolicy(`version: 1
suppressions:
  - rule: AF004
    path: .github/workflows/test.yml
    reason: private repository actor policy
`).policy;
    const result = scan(
      `on: issues
jobs:
  x:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.issue.body.* }}
`,
      policy,
    );
    expect(result.findings.find((item) => item.ruleId === "AF004")?.suppressed?.reason).toContain(
      "private",
    );
    expect(result.completeness).toBe("partial");
  });

  it("applies line-scoped inline suppressions only when they include a reason", () => {
    const source = `on: issues
permissions:
  contents: write
jobs:
  x:
    steps:
          # Security review
      # agentfence-ignore: AF001 -- reviewed prompt is constrained by repository policy
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.issue.body }}
`;
    const result = scan(source);
    expect(result.findings.find((item) => item.ruleId === "AF001")?.suppressed?.reason).toBe(
      "reviewed prompt is constrained by repository policy",
    );
    expect(result.findings.find((item) => item.ruleId === "AF004")?.suppressed).toBeUndefined();

    const missingReason = scan(
      source.replace("AF001 -- reviewed prompt is constrained by repository policy", "AF001"),
    );
    expect(
      missingReason.findings.find((item) => item.ruleId === "AF001")?.suppressed,
    ).toBeUndefined();

    const partial = scan(
      source
        .replace(
          "AF001 -- reviewed prompt is constrained by repository policy",
          "AF001 -- documented risk acceptance",
        )
        .replace("github.event.issue.body }}", "github.event.issue.body.* }}"),
    );
    expect(partial.completeness).toBe("partial");
    expect(partial.findings.find((item) => item.ruleId === "AF001")?.suppressed).toBeUndefined();
  });

  it("allows an inline suppression immediately before a job and keeps comments local", () => {
    const scoped = scan(`on: issues
permissions:
  contents: write
jobs:
  # agentfence-ignore: AF004 -- this job is restricted to maintainers
  triage:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.issue.body }}
`);
    expect(scoped.findings.find((item) => item.ruleId === "AF004")?.suppressed?.reason).toBe(
      "this job is restricted to maintainers",
    );
    const outOfScope = scan(`on: issues
# agentfence-ignore: AF004 -- unrelated comment
permissions:
  contents: write
jobs:
  triage:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
`);
    expect(outOfScope.findings.find((item) => item.ruleId === "AF004")?.suppressed).toBeUndefined();
  });

  it("does not let a step suppression bleed into another job", () => {
    const result = scan(`on: issues
permissions:
  contents: write
jobs:
  first:
    steps:
      # agentfence-ignore: AF001 -- this only covers the first action
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.issue.body }}
  second:
    steps:
      - uses: anthropics/claude-code-base-action@v1
        with:
          prompt: \${{ github.event.issue.body }}
`);
    const promptFindings = result.findings.filter((item) => item.ruleId === "AF001");
    expect(promptFindings).toHaveLength(2);
    expect(promptFindings.filter((item) => item.suppressed)).toHaveLength(1);
  });

  it("ignores suppression-looking text inside a block scalar", () => {
    const result = scan(`on: issues
permissions:
  contents: write
jobs:
  agent:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
        with:
          prompt: \${{ github.event.issue.body }}
  script:
    steps:
      - run: |
          # agentfence-ignore: AF004 -- this is script text
          - fake-step
`);
    expect(result.findings.find((item) => item.ruleId === "AF004")?.suppressed).toBeUndefined();
  });

  it("accepts a real inline YAML comment on a scalar header", () => {
    const result = scan(`on: workflow_dispatch
jobs:
  x:
    steps:
      - id: agent
        uses: anthropics/claude-code-base-action@v1
        with:
          prompt: summarize the repository
      - run: echo \${{ steps.agent.outputs.execution_file }} # agentfence-ignore: AF002 -- output is validated before use
`);
    expect(result.findings.find((item) => item.ruleId === "AF002")?.suppressed?.reason).toBe(
      "output is validated before use",
    );
  });

  it("does not treat an environment key as the start of a job", () => {
    const result = scan(`on: issues
jobs:
  one:
    env:
      # agentfence-ignore: AF004 -- this is only an environment entry
      one: unrelated
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
`);
    expect(result.findings.find((item) => item.ruleId === "AF004")?.suppressed).toBeUndefined();
  });

  it("uses parsed sequence positions for step scoping, including split list items", () => {
    const matrixComment = scan(`on: issues
jobs:
  first:
    strategy:
      matrix:
        option:
          # agentfence-ignore: AF004 -- this belongs to the matrix
          - one
    steps:
      - run: echo matrix
  second:
    steps:
      -
        uses: google-github-actions/run-gemini-cli@v0
`);
    expect(
      matrixComment.findings.find((item) => item.ruleId === "AF004")?.suppressed,
    ).toBeUndefined();

    const stepComment = scan(`on: issues
jobs:
  x:
    steps:
      # agentfence-ignore: AF004 -- reviewed step exception
      -
        uses: google-github-actions/run-gemini-cli@v0
`);
    expect(stepComment.findings.find((item) => item.ruleId === "AF004")?.suppressed?.reason).toBe(
      "reviewed step exception",
    );
  });

  it("parses YAML comments after apostrophes in plain scalar text", () => {
    const result = scan(`on: issues
jobs:
  x:
    steps:
      - name: Don't expose context # agentfence-ignore: AF004 -- reviewed prompt gating
        uses: google-github-actions/run-gemini-cli@v0
`);
    expect(result.findings.find((item) => item.ruleId === "AF004")?.suppressed?.reason).toBe(
      "reviewed prompt gating",
    );
  });

  it("recognizes a suppression comment before the first YAML document token", () => {
    const result = scan(`# agentfence-ignore: AF004 -- first-line review
{on: issues, permissions: write-all, jobs: {one: {steps: [{uses: google-github-actions/run-gemini-cli@v0}]}}}`);
    expect(result.findings.find((item) => item.ruleId === "AF004")?.suppressed?.reason).toBe(
      "first-line review",
    );

    const explicitDocument = scan(`# agentfence-ignore: AF004 -- explicit document review
--- {on: issues, permissions: write-all, jobs: {one: {steps: [{uses: google-github-actions/run-gemini-cli@v0}]}}}`);
    expect(
      explicitDocument.findings.find((item) => item.ruleId === "AF004")?.suppressed?.reason,
    ).toBe("explicit document review");

    const firstBlockKey = scan(`# agentfence-ignore: AF004 -- first block key review
jobs: {one: {steps: [{uses: google-github-actions/run-gemini-cli@v0}]}}
on: issues
`);
    expect(firstBlockKey.findings.find((item) => item.ruleId === "AF004")?.suppressed?.reason).toBe(
      "first block key review",
    );
  });

  it("keeps an active duplicate finding when another occurrence is suppressed", () => {
    const source = `on: issues
jobs:
  first:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
  second:
    steps:
      - uses: google-github-actions/run-gemini-cli@v0
`;
    const unsuppressed = scan(source).findings.find((item) => item.ruleId === "AF004");
    expect(unsuppressed?.range.start.line).toBe(8);

    const result = scan(
      source.replace(
        "  second:\n    steps:",
        "    # agentfence-ignore: AF004 -- only this job has an accepted exception\n  second:\n    steps:",
      ),
    );
    const finding = result.findings.find((item) => item.ruleId === "AF004");
    expect(finding?.suppressed).toBeUndefined();
    expect(finding?.range.start.line).toBe(5);
  });
});

function expectRules(source: string, expected: string[]): void {
  const rules = scan(source).findings.map((item) => item.ruleId);
  for (const rule of expected)
    expect(rules, `Expected ${rule}, received ${rules.join(", ")}`).toContain(rule);
}
