import { describe, expect, it } from "vitest";
import { parseExpressions } from "../src/expressions/index.js";

describe("expression parser lexical handling", () => {
  it("ignores braces and context-like text inside quoted string literals", () => {
    const result = parseExpressions(
      "${{ format('prefix {0} github.event.issue.body', inputs.text) }}",
    );

    expect(result.references.map((reference) => reference.path)).toEqual(["inputs.text"]);
    expect(result.unsupported).toEqual([]);
  });

  it("keeps bracket property references while skipping unrelated literals", () => {
    const result = parseExpressions(
      "${{ secrets['TOKEN'] }} ${{ needs['build'].outputs['artifact'] }}",
    );

    expect(result.references.map((reference) => reference.path)).toEqual([
      "secrets.TOKEN",
      "needs.build.outputs.artifact",
    ]);
  });

  it("marks wildcards outside literals unsupported but not inside them", () => {
    expect(parseExpressions("${{ format('* {x}', inputs.name) }}").unsupported).toEqual([]);
    expect(parseExpressions("${{ github.event.issue.* }}").unsupported).toEqual([
      "${{ github.event.issue.* }}",
    ]);
  });

  it("reports unterminated expressions and quoted literals", () => {
    expect(parseExpressions("${{ inputs.name").unsupported).toContain("malformed-expression");
    expect(parseExpressions("${{ format('unfinished, inputs.name) }}").unsupported).toContain(
      "malformed-expression",
    );
  });
});
