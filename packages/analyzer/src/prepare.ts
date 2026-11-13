import type { WorkflowIR } from "./ir/types.js";
import { expandCompositeActions } from "./composites/index.js";

/** Resolve local execution boundaries without executing target repository code. */
export async function prepareWorkflowDependencies(
  workflow: WorkflowIR,
  fetchFile: (path: string) => Promise<string | undefined>,
): Promise<WorkflowIR> {
  const prepared = structuredClone(workflow);
  const replacedBoundary = prepared.diagnostics.some(
    (item) => item.code === "reusable-local-action-unsupported",
  );
  prepared.diagnostics = prepared.diagnostics.filter(
    (item) => item.code !== "reusable-local-action-unsupported",
  );
  // The expander supplies its own diagnostics for missing/unsupported local actions.
  prepared.completeness =
    prepared.diagnostics.length || (!replacedBoundary && workflow.completeness === "partial")
      ? "partial"
      : "complete";
  const expanded = await expandCompositeActions(prepared, fetchFile);
  return {
    ...expanded.workflow,
    diagnostics: [...prepared.diagnostics, ...expanded.diagnostics],
    completeness:
      prepared.completeness === "partial" || expanded.completeness === "partial"
        ? "partial"
        : "complete",
  };
}
