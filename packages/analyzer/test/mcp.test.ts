import { describe, expect, it } from "vitest";
import { analyzeMcpConfiguration } from "../src/configuration/mcp.js";
import { scanWorkflow } from "../src/index.js";

describe("MCP configuration analyzer", () => {
  it("flags unpinned package launchers without exposing configured values", () => {
    const source = JSON.stringify(
      {
        mcpServers: {
          search: {
            command: "npx",
            args: ["-y", "@acme/search-mcp"],
            env: { TOKEN: "secret-value" },
          },
        },
      },
      null,
      2,
    );
    const result = analyzeMcpConfiguration(".mcp.json", source);

    expect(result.issues.map(({ code }) => code)).toContain("MCP_UNPINNED_PACKAGE");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(result.issues[0]?.range.start.line).toBeGreaterThan(1);
  });

  it("does not flag version-pinned packages as safe or unsafe", () => {
    const result = analyzeMcpConfiguration(
      ".mcp.json",
      JSON.stringify({
        mcpServers: { search: { command: "npx", args: ["-y", "@acme/search-mcp@1.2.3"] } },
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it("flags wildcard project MCP enablement and unrestricted tools", () => {
    const result = analyzeMcpConfiguration(
      ".claude/settings.json",
      JSON.stringify({
        enabledMcpjsonServers: ["*"],
        permissions: { allow: ["mcp__*"], defaultMode: "bypassPermissions" },
      }),
    );
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["MCP_WILDCARD_ENABLEMENT", "MCP_UNRESTRICTED_TOOLS"]),
    );
  });

  it("flags Claude's explicit project-wide MCP enablement setting", () => {
    const result = analyzeMcpConfiguration(
      ".claude/settings.json",
      '{"enableAllProjectMcpServers":true}',
    );
    expect(result.issues.map(({ code }) => code)).toContain("MCP_WILDCARD_ENABLEMENT");
  });

  it("does not treat Claude's dontAsk mode as broad MCP approval", () => {
    const result = analyzeMcpConfiguration(
      ".claude/settings.json",
      '{"permissions":{"defaultMode":"dontAsk"}}',
    );
    expect(result.issues).toEqual([]);
  });

  it("supports Gemini MCP server sections and npm exec package launchers", () => {
    const result = analyzeMcpConfiguration(
      ".gemini/settings.json",
      JSON.stringify({
        mcpServers: { db: { command: "npm", args: ["exec", "--yes", "--", "db-mcp"] } },
      }),
    );
    expect(result.issues.map(({ code }) => code)).toContain("MCP_UNPINNED_PACKAGE");
  });

  it("handles exact npm exec package flags before the executable", () => {
    const cases: Array<[string[], number]> = [
      [["exec", "--package", "db-mcp@1.2.3", "--", "db-mcp"], 0],
      [["exec", "--package=db-mcp", "--", "db-mcp"], 1],
      [["exec", "-p", "db-mcp", "-p", "other-mcp", "--", "run"], 2],
    ];
    for (const [args, expectedCount] of cases) {
      const result = analyzeMcpConfiguration(
        ".gemini/settings.json",
        JSON.stringify({ mcpServers: { db: { command: "npm", args } } }),
      );
      expect(result.issues.filter(({ code }) => code === "MCP_UNPINNED_PACKAGE")).toHaveLength(
        expectedCount,
      );
    }
  });

  it("handles npx package flags, including scoped packages", () => {
    for (const args of [
      ["-y", "-p", "@acme/server", "server"],
      ["-y", "--package=@acme/server", "server"],
    ]) {
      const result = analyzeMcpConfiguration(
        ".mcp.json",
        JSON.stringify({ mcpServers: { server: { command: "npx", args } } }),
      );
      expect(result.issues.map(({ code }) => code)).toContain("MCP_UNPINNED_PACKAGE");
    }
  });

  it("checks separate server ranges for repeated launcher commands", () => {
    const source = JSON.stringify(
      {
        mcpServers: {
          first: { command: "npx", args: ["first-mcp"] },
          second: { command: "npx", args: ["second-mcp"] },
        },
      },
      null,
      2,
    );
    const result = analyzeMcpConfiguration(".mcp.json", source);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]?.range.start.line).not.toBe(result.issues[1]?.range.start.line);
  });

  it("returns a safe partial diagnostic for invalid JSON", () => {
    const result = analyzeMcpConfiguration(".mcp.json", '{"mcpServers":{"x":{"command":"npx",');
    expect(result.diagnostics[0]?.code).toBe("MCP_INVALID_JSON");
    expect(result.issues).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("command");
  });

  it("diagnoses a malformed mcpServers section without echoing its value", () => {
    const result = analyzeMcpConfiguration(".mcp.json", '{"mcpServers":"secret-config-value"}');
    expect(result.diagnostics[0]?.code).toBe("MCP_INVALID_SERVERS");
    expect(JSON.stringify(result)).not.toContain("secret-config-value");
  });

  it.each(["[]", "null", '"config-value"'])("diagnoses a non-object config root (%s)", (source) => {
    const result = analyzeMcpConfiguration(".mcp.json", source);
    expect(result.diagnostics[0]?.code).toBe("MCP_INVALID_ROOT");
    expect(JSON.stringify(result)).not.toContain("config-value");
  });

  it("diagnoses invalid server command and args shapes without echoing values", () => {
    const source = JSON.stringify({
      mcpServers: {
        first: { command: { token: "secret-command" } },
        second: { command: "npx", args: "secret-args" },
      },
    });
    const result = analyzeMcpConfiguration(".mcp.json", source);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "MCP_INVALID_SERVER_COMMAND",
      "MCP_INVALID_SERVER_ARGS",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-");
  });

  it("rejects oversized and deeply nested documents without throwing", () => {
    expect(analyzeMcpConfiguration(".mcp.json", " ".repeat(1_000_001)).diagnostics[0]?.code).toBe(
      "MCP_CONFIG_LIMIT",
    );
    const deep = `${"{".repeat(70)}${"}".repeat(70)}`;
    expect(analyzeMcpConfiguration(".mcp.json", deep).diagnostics[0]?.code).toBe(
      "MCP_CONFIG_LIMIT",
    );
  });

  it("flags uvx/bunx/pnpm dlx/docker unpinned runners, insecure http URLs, hardcoded tokens, and Bash(*)", () => {
    const result = analyzeMcpConfiguration(
      ".vscode/mcp.json",
      JSON.stringify({
        servers: {
          py: { command: "uvx", args: ["mcp-server-sqlite"] },
          dlx: { command: "pnpm", args: ["dlx", "@acme/mcp"] },
          container: { command: "docker", args: ["run", "--rm", "-i", "ghcr.io/acme/mcp:latest"] },
          remote: {
            url: "http://mcp.internal.example.com/sse",
            headers: { Authorization: "Bearer ghp_1234567890abcdef1234567890" },
          },
        },
        permissions: { allow: ["Bash(*)"] },
      }),
    );
    const codes = result.issues.map(({ code }) => code);
    expect(codes.filter((c) => c === "MCP_UNPINNED_PACKAGE")).toHaveLength(3);
    expect(codes).toContain("MCP_INSECURE_TRANSPORT");
    expect(codes).toContain("MCP_HARDCODED_SECRET");
    expect(codes).toContain("MCP_UNRESTRICTED_TOOLS");
    expect(JSON.stringify(result)).not.toContain("ghp_1234567890abcdef1234567890");

    const pinned = analyzeMcpConfiguration(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          py: { command: "uvx", args: ["mcp-server-sqlite==1.2.3"] },
          container: { command: "docker", args: ["run", "--rm", "ghcr.io/acme/mcp:1.2.3"] },
          local: {
            url: "http://localhost:3333/sse",
            env: { TOKEN: "${MY_TOKEN}" },
          },
        },
      }),
    );
    expect(pinned.issues).toEqual([]);
  });

  it("keeps AF007 fingerprints stable across whitespace formatting shifts in .mcp.json", () => {
    const compact = JSON.stringify({ mcpServers: { s: { command: "npx", args: ["foo-mcp"] } } });
    const reformatted = JSON.stringify(
      { _note: "formatted", mcpServers: { s: { command: "npx", args: ["foo-mcp"] } } },
      null,
      2,
    );
    const first = scanWorkflow({ path: ".mcp.json", source: compact });
    const second = scanWorkflow({ path: ".mcp.json", source: reformatted });
    expect(first.findings[0]?.fingerprint).toBe(second.findings[0]?.fingerprint);
  });
});
