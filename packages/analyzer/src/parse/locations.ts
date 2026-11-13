import type { SourceRange } from "../ir/types.js";

export function rangeFromOffsets(
  path: string,
  source: string,
  start = 0,
  end = start,
): SourceRange {
  return {
    path,
    start: positionAt(source, Math.max(0, start)),
    end: positionAt(source, Math.max(start, end)),
  };
}

function positionAt(source: string, offset: number) {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1, offset };
}
