import type { Diagnostic, SourceRange } from "../ir/types.js";
import { rangeFromOffsets } from "../parse/locations.js";

export interface McpConfigurationIssue {
  code: string;
  severity: "high" | "medium" | "low";
  range: SourceRange;
  message: string;
  remediation: string;
}

export interface McpConfigurationAnalysis {
  issues: McpConfigurationIssue[];
  diagnostics: Diagnostic[];
}

const MAX_SOURCE_LENGTH = 1_000_000;
const MAX_DEPTH = 64;
const MAX_NODES = 10_000;
const VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function analyzeMcpConfiguration(path: string, source: string): McpConfigurationAnalysis {
  const diagnostics: Diagnostic[] = [];
  const issues: McpConfigurationIssue[] = [];
  if (source.length > MAX_SOURCE_LENGTH || exceedsJsonLimits(source)) {
    diagnostics.push({
      code: "MCP_CONFIG_LIMIT",
      message: "MCP configuration exceeds analyzer size or complexity limits.",
      range: rangeFromOffsets(path, source),
    });
    return { issues, diagnostics };
  }

  let root: unknown;
  try {
    root = JSON.parse(source) as unknown;
  } catch {
    diagnostics.push({
      code: "MCP_INVALID_JSON",
      message: "MCP configuration is invalid JSON; analysis is partial.",
      range: rangeFromOffsets(path, source),
    });
    return { issues, diagnostics };
  }
  if (!isRecord(root)) {
    diagnostics.push({
      code: "MCP_INVALID_ROOT",
      message: "MCP configuration must be a JSON object; analysis is partial.",
      range: rangeFromOffsets(path, source),
    });
    return { issues, diagnostics };
  }

  if ("mcpServers" in root && !isRecord(root.mcpServers)) {
    diagnostics.push({
      code: "MCP_INVALID_SERVERS",
      message: "MCP server configuration must be an object; analysis is partial.",
      range: rangeFromOffsets(path, source, findPropertyOffset(source, "mcpServers")),
    });
    return { issues, diagnostics };
  }

  const servers = isRecord(root.mcpServers) ? root.mcpServers : {};
  const serversRange = findObjectPropertyRange(source, "mcpServers");
  let serverSearchOffset = serversRange?.start ?? 0;
  for (const [name, raw] of Object.entries(servers)) {
    const serverRange = serversRange
      ? findObjectPropertyRange(source, name, serverSearchOffset, serversRange.end)
      : undefined;
    if (serverRange) serverSearchOffset = serverRange.end;
    if (!isRecord(raw)) {
      diagnostics.push({
        code: "MCP_INVALID_SERVERS",
        message: "An MCP server entry must be an object; analysis is partial.",
        range: rangeFromOffsets(path, source, serverRange?.start ?? 0, serverRange?.end ?? 0),
      });
      continue;
    }
    const serverSource = serverRange ? source.slice(serverRange.start, serverRange.end) : source;
    if ("command" in raw && typeof raw.command !== "string") {
      const start = findPropertyOffset(serverSource, "command") + (serverRange?.start ?? 0);
      diagnostics.push({
        code: "MCP_INVALID_SERVER_COMMAND",
        message: "MCP server command must be a string; analysis of this launcher is partial.",
        range: rangeFromOffsets(path, source, start),
      });
    }
    if (
      ("args" in raw && !Array.isArray(raw.args)) ||
      (Array.isArray(raw.args) && raw.args.some((arg) => typeof arg !== "string"))
    ) {
      const start = findPropertyOffset(serverSource, "args") + (serverRange?.start ?? 0);
      diagnostics.push({
        code: "MCP_INVALID_SERVER_ARGS",
        message:
          "MCP server arguments must be an array of strings; analysis of these arguments is partial.",
        range: rangeFromOffsets(path, source, start),
      });
    }
    const command = typeof raw.command === "string" ? raw.command : "";
    const args = Array.isArray(raw.args)
      ? raw.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const packageSpecs = packageFromInvocation(command, args);
    for (const packageSpec of packageSpecs.filter((spec) => !isVersionPinned(spec))) {
      const serverSource = serverRange ? source.slice(serverRange.start, serverRange.end) : source;
      const localStart = findStringOffset(serverSource, packageSpec);
      const start = localStart + (serverRange?.start ?? 0);
      issues.push({
        code: "MCP_UNPINNED_PACKAGE",
        severity: "medium",
        range: rangeFromOffsets(
          path,
          source,
          start,
          start + Math.max(1, JSON.stringify(packageSpec).length),
        ),
        message:
          "MCP server is launched through a package runner without an exact package version.",
        remediation:
          "Pin the package to an exact version and review the server source and requested capabilities before use.",
      });
    }
    if (raw.trust === true) {
      const serverSource = serverRange ? source.slice(serverRange.start, serverRange.end) : source;
      const start = findKeyValueOffset(serverSource, "trust", "true") + (serverRange?.start ?? 0);
      issues.push({
        code: "MCP_UNRESTRICTED_TOOLS",
        severity: "high",
        range: rangeFromOffsets(path, source, start, start + 4),
        message:
          "MCP server is marked trusted, allowing its tools without normal per-tool confirmation.",
        remediation:
          "Remove blanket trust and approve only the specific tools needed for the project.",
      });
    }
  }

  const enabled = root.enabledMcpjsonServers;
  if (
    root.enableAllProjectMcpServers === true ||
    (Array.isArray(enabled) && enabled.some((value) => value === "*"))
  ) {
    const wildcardSetting = root.enableAllProjectMcpServers === true;
    const start = wildcardSetting
      ? findKeyValueOffset(source, "enableAllProjectMcpServers", "true")
      : findStringOffset(source, "*");
    issues.push({
      code: "MCP_WILDCARD_ENABLEMENT",
      severity: "medium",
      range: rangeFromOffsets(path, source, start, start + (wildcardSetting ? 4 : 3)),
      message:
        "Project configuration enables all project MCP servers without per-server selection.",
      remediation: "Enable only the project MCP servers that are required.",
    });
  }

  const permissions = isRecord(root.permissions) ? root.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const wildcardMcp = allow.some(
    (value) => typeof value === "string" && /^mcp__[^\s]*\*$/.test(value),
  );
  const bypass = permissions.defaultMode === "bypassPermissions";
  if (wildcardMcp || bypass) {
    const needle = wildcardMcp
      ? (allow.find(
          (value) => typeof value === "string" && /^mcp__[^\s]*\*$/.test(value),
        ) as string)
      : "bypassPermissions";
    const start = findStringOffset(source, needle);
    issues.push({
      code: "MCP_UNRESTRICTED_TOOLS",
      severity: bypass ? "high" : "medium",
      range: rangeFromOffsets(path, source, start, start + JSON.stringify(needle).length),
      message:
        "Configuration broadly pre-approves MCP tools or bypasses normal tool permission checks.",
      remediation:
        "Use explicit MCP tool allow rules and retain interactive approval for other tools.",
    });
  }
  return { issues, diagnostics };
}

function packageFromInvocation(command: string, args: string[]): string[] {
  const executable = command.split(/[\\/]/).at(-1)?.toLowerCase();
  if (executable === "npx" || executable === "npx.cmd") {
    const explicitPackages = readPackageFlags(args);
    if (explicitPackages.length > 0) return explicitPackages;
    const candidate = args.find((arg) => !arg.startsWith("-"));
    return candidate ? [candidate] : [];
  }
  if (executable === "npm" || executable === "npm.cmd") {
    const execIndex = args.findIndex((arg) => arg === "exec");
    if (execIndex < 0) return [];
    const remaining = args.slice(execIndex + 1);
    const separator = remaining.indexOf("--");
    const explicitPackages = readPackageFlags(
      separator >= 0 ? remaining.slice(0, separator) : remaining,
    );
    if (explicitPackages.length > 0) return explicitPackages;
    const candidates = separator >= 0 ? remaining.slice(separator + 1) : remaining;
    const candidate = candidates.find((arg) => !arg.startsWith("-"));
    return candidate ? [candidate] : [];
  }
  return [];
}

function readPackageFlags(args: string[]): string[] {
  const packages: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const equals = /^(?:--package|-p)=(.+)$/.exec(arg);
    if (equals?.[1]) packages.push(equals[1]);
    else if ((arg === "--package" || arg === "-p") && args[index + 1]) {
      packages.push(args[index + 1] as string);
      index++;
    }
  }
  return packages;
}

function isVersionPinned(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  return at > (spec.startsWith("@") ? spec.indexOf("/") : -1) && VERSION.test(spec.slice(at + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findStringOffset(source: string, value: string): number {
  const encoded = JSON.stringify(value);
  const offset = source.indexOf(encoded);
  return offset < 0 ? 0 : offset;
}

function findKeyValueOffset(source: string, key: string, value: string): number {
  const match = new RegExp(`"${key}"\\s*:\\s*${value}`).exec(source);
  return match ? match.index + match[0].lastIndexOf(value) : 0;
}

function findPropertyOffset(source: string, key: string): number {
  const match = new RegExp(`${escapeRegExp(JSON.stringify(key))}\\s*:`).exec(source);
  return match?.index ?? 0;
}

function findObjectPropertyRange(
  source: string,
  key: string,
  from = 0,
  to = source.length,
): { start: number; end: number } | undefined {
  const property = new RegExp(`${escapeRegExp(JSON.stringify(key))}\\s*:\\s*\\{`, "g");
  property.lastIndex = from;
  const match = property.exec(source);
  if (!match || match.index >= to) return undefined;
  const open = source.indexOf("{", match.index + match[0].indexOf(":"));
  const end = matchingBraceEnd(source, open);
  return end < 0 || end > to ? undefined : { start: open, end: end + 1 };
}

function matchingBraceEnd(source: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exceedsJsonLimits(source: string): boolean {
  let depth = 0;
  let nodes = 0;
  let inString = false;
  let escaped = false;
  let expectValue = true;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      if (expectValue) nodes++;
      expectValue = false;
    } else if (char === "{" || char === "[") {
      depth++;
      nodes++;
      expectValue = true;
      if (depth > MAX_DEPTH) return true;
    } else if (char === "}" || char === "]") {
      depth--;
      expectValue = false;
    } else if (char === ":" || char === ",") expectValue = true;
    else if (!/\s/.test(char) && expectValue && /[\-0-9tfn]/.test(char)) {
      nodes++;
      expectValue = false;
    }
    if (nodes > MAX_NODES) return true;
  }
  return false;
}
