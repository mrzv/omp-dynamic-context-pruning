import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { applyMutation, createRuntimeState } from "./runtime.ts";
import type { PersistedMutation, RuntimeState } from "./types.ts";
import { isUnknownRecord } from "../type-guards.ts";

export const DCP_STATE_ENTRY = "dev.ohmypi.dcp.state.v1";

export interface CustomStateEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isPositiveIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isPositiveInteger);
}

function isReferenceAssignments(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const keys = new Set<string>();
  const references = new Set<string>();
  for (const item of value) {
    if (
      !isUnknownRecord(item)
      || typeof item.key !== "string"
      || typeof item.ref !== "string"
      || !/^m(?!0000)\d{4}$/.test(item.ref)
      || keys.has(item.key)
      || references.has(item.ref)
    ) return false;
    keys.add(item.key);
    references.add(item.ref);
  }
  return true;
}

function isPrunedRecords(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => (
    isUnknownRecord(item)
    && typeof item.toolCallId === "string"
    && (item.reason === "deduplication" || item.reason === "purge-error" || item.reason === "sweep")
    && isNonNegativeFinite(item.tokenCount)
    && isNonNegativeFinite(item.prunedAt)
  ));
}

function isCompressionBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => (
    isUnknownRecord(item)
    && isPositiveInteger(item.blockId)
    && isPositiveInteger(item.runId)
    && (item.mode === "range" || item.mode === "message")
    && typeof item.active === "boolean"
    && typeof item.deactivatedByUser === "boolean"
    && typeof item.topic === "string"
    && (item.batchTopic === undefined || typeof item.batchTopic === "string")
    && typeof item.startRef === "string"
    && typeof item.endRef === "string"
    && typeof item.anchorKey === "string"
    && isStringArray(item.memberKeys)
    && isStringArray(item.toolCallIds)
    && isPositiveIntegerArray(item.includedBlockIds)
    && isPositiveIntegerArray(item.consumedBlockIds)
    && typeof item.summary === "string"
    && isNonNegativeFinite(item.compressedTokens)
    && isNonNegativeFinite(item.summaryTokens)
    && isNonNegativeFinite(item.durationMs)
    && isNonNegativeFinite(item.createdAt)
  ));
}

export function isPersistedMutation(value: unknown): value is PersistedMutation {
  if (!isUnknownRecord(value) || value.version !== 1 || !isNonNegativeFinite(value.at)) return false;
  switch (value.kind) {
    case "references-assigned":
      return isReferenceAssignments(value.assignments)
        && isPositiveInteger(value.nextRef)
        && value.nextRef <= 10_000;
    case "tools-pruned":
      return isPrunedRecords(value.records);
    case "compression-created":
      return isCompressionBlocks(value.blocks);
    case "blocks-activation":
      return isPositiveIntegerArray(value.blockIds)
        && typeof value.active === "boolean"
        && typeof value.byUser === "boolean";
    case "manual-mode":
      return typeof value.enabled === "boolean";
    case "nudge-anchors":
      return isStringArray(value.contextLimit)
        && isStringArray(value.turn)
        && isStringArray(value.iteration);
    case "native-compaction-reset":
      return isPositiveIntegerArray(value.blockIds);
    default:
      return false;
  }
}

export function restoreStateFromBranch(
  branch: readonly CustomStateEntryLike[],
  manualModeDefault = false,
  sessionId: string | null = null,
): RuntimeState {
  const state = createRuntimeState(manualModeDefault);
  state.sessionId = sessionId;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== DCP_STATE_ENTRY) continue;
    if (isPersistedMutation(entry.data)) applyMutation(state, entry.data);
  }
  return state;
}

export function appendMutation(pi: ExtensionAPI, mutation: PersistedMutation): void {
  pi.appendEntry(DCP_STATE_ENTRY, mutation);
}
