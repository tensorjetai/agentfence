import type { ParsedExpressions } from "../ir/types.js";

const referenceRootPattern = /^(github|inputs|env|steps|jobs|needs|secrets|matrix)\b/;

export function parseExpressions(value: string): ParsedExpressions {
  const references: ParsedExpressions["references"] = [];
  const unsupported: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const expressionStart = value.indexOf("${{", cursor);
    if (expressionStart < 0) break;
    const scanned = scanExpression(value, expressionStart + 3);
    if (scanned.end === undefined || scanned.quote !== undefined) {
      unsupported.push("malformed-expression");
      break;
    }
    const whole = value.slice(expressionStart, scanned.end + 2);
    const body = value.slice(expressionStart + 3, scanned.end);
    if (body.trim() === "" || hasUnsupportedSyntax(body)) unsupported.push(whole);
    references.push(...extractReferences(body, expressionStart + 3));
    cursor = scanned.end + 2;
  }
  return { references, unsupported };
}

function scanExpression(value: string, start: number): { end?: number; quote?: string } {
  let quote: string | undefined;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "}" && value[index + 1] === "}") return { end: index };
  }
  return quote === undefined ? {} : { quote };
}

function hasUnsupportedSyntax(body: string): boolean {
  let quote: string | undefined;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if ("*?{};".includes(char) || (char === "=" && body[index + 1] === ">")) return true;
  }
  return false;
}

function extractReferences(body: string, offset: number): ParsedExpressions["references"] {
  const found: ParsedExpressions["references"] = [];
  let quote: string | undefined;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const match = referenceRootPattern.exec(body.slice(index));
    if (!match || (index > 0 && /[\w.-]/.test(body[index - 1]!))) continue;

    const start = index;
    let end = index + match[0].length;
    const segments: string[] = [match[1]!];
    while (end < body.length) {
      const rest = body.slice(end);
      const property = /^\.([A-Za-z_][\w-]*)/.exec(rest);
      if (property) {
        segments.push(property[1]!);
        end += property[0].length;
        continue;
      }
      const bracket = /^\[['"]([^'"\]]+)['"]\]/.exec(rest);
      if (bracket) {
        segments.push(bracket[1]!);
        end += bracket[0].length;
        continue;
      }
      break;
    }
    const raw = body.slice(start, end);
    found.push({
      path: segments.join("."),
      raw,
      range: { start: offset + start, end: offset + end },
    });
    index = end - 1;
  }
  return found;
}

export function taintForReference(path: string) {
  if (
    /^github\.event\.(?:issue|pull_request|discussion)\.(?:body|title)$/.test(path) ||
    /^github\.event\.(?:comment|review|review_comment)\.body$/.test(path)
  ) {
    return "UNTRUSTED_EVENT_TEXT" as const;
  }
  if (/^github\.(head_ref|ref)|\.head\.(ref|sha)/.test(path)) return "UNTRUSTED_REF" as const;
  if (/^(?:inputs|github\.event\.inputs)\./.test(path)) return "WORKFLOW_DISPATCH_INPUT" as const;
  if (/^secrets\./.test(path)) return "SECRET_REFERENCE" as const;
  if (/^(steps|jobs|needs)\..*\.outputs\./.test(path)) return "AGENT_OUTPUT" as const;
  return undefined;
}
