import type { RuleId } from "../ir/types.js";
import { Composer, isMap, isScalar, isSeq, Parser } from "yaml";

export interface InlineSuppression {
  line: number;
  rules: RuleId[];
  reason: string;
}

export interface WorkflowSourceMetadata {
  suppressions: InlineSuppression[];
  jobStartLines: Map<string, number>;
  stepStartLines: Map<number, number>;
}

const ruleIds = new Set<RuleId>(["AF001", "AF002", "AF003", "AF004", "AF005", "AF006", "AF007"]);

export function parseWorkflowSourceMetadata(source: string): WorkflowSourceMetadata {
  const tokens = [...new Parser().parse(source)];
  const document = new Composer({ keepSourceTokens: true })
    .compose(tokens, true, source.length)
    .next().value;
  const root = document?.contents;
  if (!isMap(root))
    return { suppressions: [], jobStartLines: new Map(), stepStartLines: new Map() };

  const comments: SourceComment[] = [];
  collectComments(tokens, comments, new Set());
  const suppressions = comments.flatMap((comment) => {
    const content = comment.source.replace(/^#\s?/, "");
    const match = /^\s*agentfence-ignore\s*:\s*([A-Z0-9_,\s]+?)\s+--\s*(.*?)\s*$/.exec(content);
    if (!match || !match[2]?.trim()) return [];
    const ids = match[1]!
      .split(",")
      .map((rule) => rule.trim())
      .filter((rule): rule is RuleId => ruleIds.has(rule as RuleId));
    if (ids.length === 0) return [];
    return [
      { line: lineAt(source, comment.offset), rules: [...new Set(ids)], reason: match[2].trim() },
    ];
  });

  const jobsPair = root.items.find((pair) => isScalar(pair.key) && pair.key.value === "jobs");
  if (!jobsPair || !isMap(jobsPair.value)) {
    return { suppressions, jobStartLines: new Map(), stepStartLines: new Map() };
  }

  const jobStartLines = new Map<string, number>();
  const stepStartLines = new Map<number, number>();
  for (const jobPair of jobsPair.value.items) {
    if (!isScalar(jobPair.key) || jobPair.key.range?.[0] === undefined || !isMap(jobPair.value))
      continue;
    const jobId = String(jobPair.key.value);
    jobStartLines.set(jobId, lineAt(source, jobPair.key.range[0]));
    const stepsPair = jobPair.value.items.find(
      (pair) => isScalar(pair.key) && pair.key.value === "steps",
    );
    if (!stepsPair || !isSeq(stepsPair.value)) continue;
    const sequenceToken = (stepsPair.value as typeof stepsPair.value & { srcToken?: SourceToken })
      .srcToken;
    for (const [index, item] of stepsPair.value.items.entries()) {
      if (!item.range) continue;
      const itemStart = sequenceToken?.items?.[index]?.start?.find(
        (token) => token.type === "seq-item-ind",
      )?.offset;
      stepStartLines.set(item.range[0], lineAt(source, itemStart ?? item.range[0]));
    }
  }
  return { suppressions, jobStartLines, stepStartLines };
}

interface SourceComment {
  offset: number;
  source: string;
}

interface SourceToken {
  type?: string;
  offset?: number;
  source?: string;
  items?: SourceToken[];
  [key: string]: unknown;
}

function collectComments(value: unknown, comments: SourceComment[], seen: Set<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectComments(item, comments, seen);
    return;
  }
  const token = value as SourceToken;
  if (
    token.type === "comment" &&
    typeof token.offset === "number" &&
    typeof token.source === "string"
  ) {
    comments.push({ offset: token.offset, source: token.source });
  }
  for (const child of Object.values(token)) collectComments(child, comments, seen);
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r?\n/).length;
}
