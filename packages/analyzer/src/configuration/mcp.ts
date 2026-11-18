import type { Diagnostic, SourceRange } from "../ir/types.js";
import { rangeFromOffsets } from "../parse/locations.js";

export interface McpConfigurationIssue {
  code: string;
  severity: "high" | "medium" | "low";
  range: SourceRange;
  message: string;
  remediation: string;
  target?: string;
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

  const serverKey = "mcpServers" in root ? "mcpServers" : "servers";
  if (serverKey in root && !isRecord(root[serverKey])) {
    diagnostics.push({
      code: "MCP_INVALID_SERVERS",
      message: "MCP server configuration must be an object; analysis is partial.",
      range: rangeFromOffsets(path, source, findPropertyOffset(source, serverKey)),
    });
    return { issues, diagnostics };
  }

  const servers = isRecord(root[serverKey]) ? (root[serverKey] as Record<string, unknown>) : {};
  const serversRange = findObjectPropertyRange(source, serverKey);
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
      const displaySpec = packageSpec.startsWith("docker:")
        ? packageSpec.slice("docker:".length)
        : packageSpec;
      const localStart = findStringOffset(serverSource, displaySpec);
      const start = localStart + (serverRange?.start ?? 0);
      issues.push({
        code: "MCP_UNPINNED_PACKAGE",
        severity: "medium",
        target: `server:${name}:pkg:${packageSpec}`,
        range: rangeFromOffsets(
          path,
          source,
          start,
          start + Math.max(1, JSON.stringify(displaySpec).length),
        ),
        message:
          "MCP server is launched through a package runner without an exact package version.",
        remediation:
          "Pin the package to an exact version and review the server source and requested capabilities before use.",
      });
    }
    const remoteUrl =
      typeof raw.url === "string"
        ? raw.url
        : typeof raw.serverUrl === "string"
          ? raw.serverUrl
          : "";
    if (isInsecureRemoteMcpUrl(remoteUrl)) {
      const start = findStringOffset(serverSource, remoteUrl) + (serverRange?.start ?? 0);
      issues.push({
        code: "MCP_INSECURE_TRANSPORT",
        severity: "high",
        target: `server:${name}:insecure-url`,
        range: rangeFromOffsets(path, source, start, start + remoteUrl.length),
        message: "Remote MCP server uses unencrypted HTTP transport outside loopback addresses.",
        remediation: "Switch the remote MCP endpoint to HTTPS with explicit authentication.",
      });
    }
    for (const credField of findHardcodedCredentialFields(raw)) {
      const start = findPropertyOffset(serverSource, credField) + (serverRange?.start ?? 0);
      issues.push({
        code: "MCP_HARDCODED_SECRET",
        severity: "high",
        target: `server:${name}:secret:${credField}`,
        range: rangeFromOffsets(path, source, start, start + JSON.stringify(credField).length),
        message:
          "MCP server configuration embeds what appears to be a static credential or bearer token.",
        remediation:
          "Replace literal credentials with environment variable placeholders (e.g. ${ENV_VAR}).",
      });
    }
    if (raw.trust === true) {
      const start = findKeyValueOffset(serverSource, "trust", "true") + (serverRange?.start ?? 0);
      issues.push({
        code: "MCP_UNRESTRICTED_TOOLS",
        severity: "high",
        target: `server:${name}:trust`,
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
      target: wildcardSetting
        ? "setting:enableAllProjectMcpServers"
        : "setting:enabledMcpjsonServers:*",
      range: rangeFromOffsets(path, source, start, start + (wildcardSetting ? 4 : 3)),
      message:
        "Project configuration enables all project MCP servers without per-server selection.",
      remediation: "Enable only the project MCP servers that are required.",
    });
  }

  const permissions = isRecord(root.permissions) ? root.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const wildcardToolRule = allow.find(
    (value): value is string =>
      typeof value === "string" &&
      (/^(?:mcp__[^\s]*|\*)$/.test(value) || /^(?:Bash|Shell)(?:\(\*\))?$/.test(value)),
  );
  const bypass = permissions.defaultMode === "bypassPermissions";
  if (wildcardToolRule || bypass) {
    const needle = wildcardToolRule ?? "bypassPermissions";
    const start = findStringOffset(source, needle);
    issues.push({
      code: "MCP_UNRESTRICTED_TOOLS",
      severity: bypass || !wildcardToolRule?.startsWith("mcp__") ? "high" : "medium",
      target: bypass ? "permissions:defaultMode:bypassPermissions" : `permissions:allow:${needle}`,
      range: rangeFromOffsets(path, source, start, start + JSON.stringify(needle).length),
      message:
        "Configuration broadly pre-approves MCP or shell tools or bypasses normal tool permission checks.",
      remediation: "Use explicit tool allow rules and retain interactive approval for other tools.",
    });
  }
  return { issues, diagnostics };
}

function packageFromInvocation(command: string, args: string[], depth = 0): string[] {
  if (depth > 8) return [];
  const executable = command.split(/[\\/]/).at(-1)?.toLowerCase();
  if (executable === "env") {
    const unwrapped = unwrapEnvInvocation(args);
    return unwrapped ? packageFromInvocation(unwrapped.command, unwrapped.args, depth + 1) : [];
  }
  if (
    executable === "sh" ||
    executable === "bash" ||
    executable === "zsh" ||
    executable === "dash" ||
    executable === "ash" ||
    executable === "ksh"
  ) {
    const script = extractShellCommandScript(args);
    if (!script) return [];
    const packages: string[] = [];
    for (const segment of splitShellCommands(script)) {
      const tokens = stripShellCommandPrefixes(segment);
      if (tokens.length > 0) {
        packages.push(...packageFromInvocation(tokens[0]!, tokens.slice(1), depth + 1));
      }
    }
    return packages;
  }
  if (executable === "npx" || executable === "npx.cmd" || executable === "bunx") {
    const separator = args.indexOf("--");
    const explicitPackages = readPackageFlags(separator >= 0 ? args.slice(0, separator) : args);
    if (explicitPackages.length > 0) return explicitPackages;
    const valueFlags =
      executable === "bunx"
        ? ["-p", "--package", "--cwd", "-c", "--config", "--env-file"]
        : [
            "-p",
            "--package",
            "-c",
            "--call",
            "--shell",
            "--userconfig",
            "--cache",
            "--registry",
            "--node-arg",
            "--node-options",
            "-w",
            "--workspace",
            "--prefix",
          ];
    const candidate =
      separator >= 0
        ? args.slice(separator + 1)[0]
        : findPositionalWithValueFlags(args, valueFlags);
    return candidate ? [candidate] : [];
  }
  if (executable === "npm" || executable === "npm.cmd") {
    const execIndex = findFirstPositionalIndex(args, [
      "-C",
      "--prefix",
      "--userconfig",
      "--cache",
      "--registry",
      "-w",
      "--workspace",
    ]);
    if (execIndex < 0 || args[execIndex] !== "exec") return [];
    const remaining = args.slice(execIndex + 1);
    const separator = remaining.indexOf("--");
    const explicitPackages = readPackageFlags(
      separator >= 0 ? remaining.slice(0, separator) : remaining,
    );
    if (explicitPackages.length > 0) return explicitPackages;
    const candidate =
      separator >= 0
        ? remaining.slice(separator + 1)[0]
        : findPositionalWithValueFlags(remaining, [
            "-p",
            "--package",
            "-c",
            "--call",
            "--shell",
            "--userconfig",
            "--cache",
            "--registry",
            "--node-options",
            "-w",
            "--workspace",
            "--prefix",
          ]);
    return candidate ? [candidate] : [];
  }
  if (executable === "pnpm" || executable === "yarn" || executable === "bun") {
    const leadingValueFlags =
      executable === "pnpm"
        ? ["-C", "--dir", "--filter", "-F", "--config", "-c"]
        : executable === "yarn"
          ? ["--cwd", "--config", "-c"]
          : ["--cwd", "--config", "-c", "--env-file"];
    const subcommandIndex = findFirstPositionalIndex(args, leadingValueFlags);
    const subcommand = subcommandIndex >= 0 ? args[subcommandIndex] : undefined;
    if (subcommand === "dlx" || subcommand === "x") {
      const remaining = args.slice(subcommandIndex + 1);
      const separator = remaining.indexOf("--");
      const explicitPackages = readPackageFlags(
        separator >= 0 ? remaining.slice(0, separator) : remaining,
      );
      if (explicitPackages.length > 0) return explicitPackages;
      const candidate =
        separator >= 0
          ? remaining.slice(separator + 1)[0]
          : findPositionalWithValueFlags(remaining, ["-p", "--package", "-c", "--call"]);
      return candidate ? [candidate] : [];
    }
    return [];
  }
  if (executable === "uvx" || (executable === "uv" && args[0] === "tool" && args[1] === "run")) {
    const remaining = executable === "uvx" ? args : args.slice(2);
    const candidate = findPositionalWithValueFlags(remaining, [
      "--from",
      "--with",
      "--python",
      "-p",
    ]);
    return candidate ? [candidate] : [];
  }
  if (executable === "pipx" && args[0] === "run") {
    const candidate = findPositionalWithValueFlags(args.slice(1), ["--spec", "--python"]);
    return candidate ? [candidate] : [];
  }
  if (executable === "docker" && args[0] === "run") {
    const image = findPositionalWithValueFlags(args.slice(1), [
      "-e",
      "--env",
      "--env-file",
      "-v",
      "--volume",
      "-p",
      "--publish",
      "--name",
      "-w",
      "--workdir",
      "--network",
      "-u",
      "--user",
      "--mount",
      "--platform",
      "--entrypoint",
      "--label",
      "-l",
      "-h",
      "--hostname",
      "--add-host",
      "--cap-add",
      "--cap-drop",
      "--security-opt",
      "--restart",
    ]);
    return image ? [`docker:${image}`] : [];
  }
  return [];
}

function findFirstPositionalIndex(args: string[], valueFlags: string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return i + 1 < args.length ? i + 1 : -1;
    if (valueFlags.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}

function findPositionalWithValueFlags(args: string[], valueFlags: string[]): string | undefined {
  const index = findFirstPositionalIndex(args, valueFlags);
  return index >= 0 ? args[index] : undefined;
}

function unwrapEnvInvocation(args: string[]): { command: string; args: string[] } | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      return args[i + 1] ? { command: args[i + 1]!, args: args.slice(i + 2) } : undefined;
    }
    if ((arg === "-S" || arg === "--split-string") && args[i + 1] !== undefined) {
      return unwrapEnvInvocation([...tokenizeShellWords(args[i + 1]!), ...args.slice(i + 2)]);
    }
    if (arg.startsWith("--split-string=")) {
      return unwrapEnvInvocation([
        ...tokenizeShellWords(arg.slice("--split-string=".length)),
        ...args.slice(i + 1),
      ]);
    }
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    return { command: arg, args: args.slice(i + 1) };
  }
  return undefined;
}

function extractShellCommandScript(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-o" || arg === "+o") {
      i += 1;
      continue;
    }
    if (/^-[A-Za-z]*c$/.test(arg)) return args[i + 1];
    if (arg === "--" || !arg.startsWith("-")) break;
  }
  return undefined;
}

function tokenizeShellWords(input: string): string[] {
  return splitShellCommands(input).flat();
}

function splitShellCommands(input: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | undefined;

  const flushToken = () => {
    if (inToken) {
      tokens.push(current);
      current = "";
      inToken = false;
    }
  };
  const flushCommand = () => {
    flushToken();
    if (tokens.length > 0) {
      commands.push(tokens);
      tokens = [];
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      inToken = true;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 < input.length) current += input[++i]!;
      } else if (ch === '"') {
        quote = undefined;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < input.length) {
        current += input[++i]!;
        inToken = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|") {
      if (ch === "|" && input[i + 1] === "|") i += 1;
      flushCommand();
      continue;
    }
    if (ch === "&" && input[i + 1] === "&") {
      i += 1;
      flushCommand();
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    current += ch;
    inToken = true;
  }
  flushCommand();
  return commands;
}

function stripShellCommandPrefixes(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "exec" || token === "command" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function isInsecureRemoteMcpUrl(url: string): boolean {
  if (!/^http:\/\//i.test(url)) return false;
  return !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(url);
}

const TOKEN_VALUE_PATTERN =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/;
const SECRET_KEY_PATTERN = /(?:TOKEN|SECRET|API[-_]?KEY|PASSWORD|AUTHORIZATION)/i;

function isPlaceholder(value: string): boolean {
  return /^(?:Bearer\s+)?\$\{[^}]+\}$/i.test(value.trim());
}

function findHardcodedCredentialFields(raw: Record<string, unknown>): string[] {
  const flagged: string[] = [];
  const checkSection = (section: unknown) => {
    if (!isRecord(section)) return;
    for (const [key, value] of Object.entries(section)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || isPlaceholder(trimmed)) continue;
      if (
        TOKEN_VALUE_PATTERN.test(trimmed) ||
        (SECRET_KEY_PATTERN.test(key) && trimmed.length >= 20)
      ) {
        flagged.push(key);
      }
    }
  };
  checkSection(raw.env);
  checkSection(raw.headers);
  if (typeof raw.url === "string" && hasCredentialInUrl(raw.url)) flagged.push("url");
  if (typeof raw.serverUrl === "string" && hasCredentialInUrl(raw.serverUrl)) {
    flagged.push("serverUrl");
  }
  if (hasCredentialInArgs(raw.args)) flagged.push("args");
  return flagged;
}

function hasCredentialInUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || isPlaceholder(trimmed)) return false;
  if (TOKEN_VALUE_PATTERN.test(trimmed)) return true;
  const schemeMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/@?#]+)@/.exec(trimmed);
  if (schemeMatch?.[1]) {
    const userinfo = schemeMatch[1];
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      const password = userinfo.slice(colon + 1);
      if (password && !isPlaceholder(password)) return true;
    } else if (!isPlaceholder(userinfo) && TOKEN_VALUE_PATTERN.test(userinfo)) {
      return true;
    }
  }
  try {
    const parsed = new URL(trimmed);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!value || isPlaceholder(value)) continue;
      if (TOKEN_VALUE_PATTERN.test(value) || (SECRET_KEY_PATTERN.test(key) && value.length >= 20)) {
        return true;
      }
    }
  } catch {
    // Unparseable URLs (such as templated hosts) still undergo userinfo and token checks above.
  }
  return false;
}

function hasCredentialInArgs(rawArgs: unknown): boolean {
  if (!Array.isArray(rawArgs)) return false;
  const args = rawArgs.filter((arg): arg is string => typeof arg === "string");
  for (let i = 0; i < args.length; i += 1) {
    const trimmed = args[i]!.trim();
    if (!trimmed || isPlaceholder(trimmed)) continue;
    if (hasCredentialInUrl(trimmed)) return true;
    if (TOKEN_VALUE_PATTERN.test(trimmed)) return true;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1).trim();
      if (
        value &&
        !isPlaceholder(value) &&
        (TOKEN_VALUE_PATTERN.test(value) || (SECRET_KEY_PATTERN.test(key) && value.length >= 20))
      ) {
        return true;
      }
    }
    const colon = trimmed.indexOf(":");
    if (colon > 0) {
      const key = trimmed.slice(0, colon);
      const value = trimmed.slice(colon + 1).trim();
      if (
        value &&
        !isPlaceholder(value) &&
        (TOKEN_VALUE_PATTERN.test(value) || (SECRET_KEY_PATTERN.test(key) && value.length >= 20))
      ) {
        return true;
      }
    }
    if (trimmed.startsWith("-") && SECRET_KEY_PATTERN.test(trimmed) && i + 1 < args.length) {
      const next = args[i + 1]!.trim();
      if (next && !next.startsWith("-") && !isPlaceholder(next) && next.length >= 20) {
        return true;
      }
    }
  }
  return false;
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
  if (spec.startsWith("docker:")) {
    const image = spec.slice("docker:".length);
    if (/@sha256:[a-f0-9]{64}$/i.test(image)) return true;
    const lastColon = image.lastIndexOf(":");
    const lastSlash = image.lastIndexOf("/");
    if (lastColon <= lastSlash) return false;
    const tag = image.slice(lastColon + 1);
    return tag !== "latest" && VERSION.test(tag);
  }
  const eq = spec.indexOf("==");
  if (eq > 0) return VERSION.test(spec.slice(eq + 2));
  const at = spec.lastIndexOf("@");
  return at > (spec.startsWith("@") ? spec.indexOf("/") : -1) && VERSION.test(spec.slice(at + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findStringOffset(source: string, value: string): number {
  const encoded = JSON.stringify(value);
  const offset = source.indexOf(encoded);
  if (offset >= 0) return offset;
  const rawOffset = source.indexOf(value);
  return rawOffset < 0 ? 0 : rawOffset;
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
