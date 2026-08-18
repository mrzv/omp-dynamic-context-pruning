import type { RuntimeState } from "../state/types.ts";
import { prepareSummary } from "./summaries.ts";
import {
  resolveBoundaries,
  resolveSelection,
  selectionAnchor,
} from "./search.ts";
import type {
  CompressRangeArgs,
  CompressionProtectionOptions,
  CompressionSearchContext,
  PreparedCompression,
  ResolvedRangePlan,
} from "./types.ts";

export function validateRangeArgs(args: CompressRangeArgs): void {
  if (typeof args.topic !== "string" || !args.topic.trim()) throw new Error("topic must be a non-empty string");
  if (!Array.isArray(args.content) || args.content.length === 0) {
    throw new Error("content must be a non-empty array");
  }
  for (let index = 0; index < args.content.length; index++) {
    const entry = args.content[index];
    if (!entry || typeof entry.startId !== "string" || !entry.startId.trim()) {
      throw new Error(`content[${index}].startId must be a non-empty string`);
    }
    if (typeof entry.endId !== "string" || !entry.endId.trim()) {
      throw new Error(`content[${index}].endId must be a non-empty string`);
    }
    if (typeof entry.summary !== "string" || !entry.summary.trim()) {
      throw new Error(`content[${index}].summary must be a non-empty string`);
    }
  }
}

export function resolveRangePlans(
  args: CompressRangeArgs,
  searchContext: CompressionSearchContext,
  state: RuntimeState,
): ResolvedRangePlan[] {
  validateRangeArgs(args);
  return args.content.map((entry, index) => {
    const normalized = {
      startId: entry.startId.trim().toLowerCase(),
      endId: entry.endId.trim().toLowerCase(),
      summary: entry.summary,
    };
    const boundaries = resolveBoundaries(
      searchContext,
      state,
      normalized.startId,
      normalized.endId,
    );
    return {
      index,
      entry: normalized,
      selection: resolveSelection(searchContext, boundaries.startReference, boundaries.endReference),
      anchorKey: selectionAnchor(boundaries.startReference),
    };
  });
}

export function validateNonOverlappingRanges(plans: readonly ResolvedRangePlan[]): void {
  const sorted = [...plans].sort((left, right) => (
    left.selection.startReference.groupIndex - right.selection.startReference.groupIndex
    || left.selection.endReference.groupIndex - right.selection.endReference.groupIndex
    || left.index - right.index
  ));
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) continue;
    if (current.selection.startReference.groupIndex > previous.selection.endReference.groupIndex) continue;
    throw new Error(
      `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps `
      + `content[${current.index}] (${current.entry.startId}..${current.entry.endId}).`,
    );
  }
}

export function prepareRangeCompression(
  args: CompressRangeArgs,
  searchContext: CompressionSearchContext,
  state: RuntimeState,
  protection: CompressionProtectionOptions,
): PreparedCompression[] {
  const plans = resolveRangePlans(args, searchContext, state);
  validateNonOverlappingRanges(plans);
  return plans.map((plan) => {
    const preparedSummary = prepareSummary(
      plan.entry.summary,
      plan.selection,
      searchContext,
      state,
      protection,
    );
    return {
      topic: args.topic.trim(),
      batchTopic: args.topic.trim(),
      mode: "range",
      startRef: plan.entry.startId,
      endRef: plan.entry.endId,
      summary: preparedSummary.summary,
      consumedBlockIds: preparedSummary.consumedBlockIds,
      selection: plan.selection,
      anchorKey: plan.anchorKey,
    };
  });
}
