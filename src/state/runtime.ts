import { createMessageReferenceState } from "../messages/identity.ts";
import type { CompressionBlock, PersistedMutation, RuntimeState } from "./types.ts";

export function createRuntimeState(manualMode = false): RuntimeState {
  return {
    sessionId: null,
    manualMode,
    references: createMessageReferenceState(),
    toolCalls: new Map(),
    prunedTools: new Map(),
    blocks: new Map(),
    activeBlockIds: new Set(),
    nudges: {
      contextLimitAnchors: new Set(),
      turnAnchors: new Set(),
      iterationAnchors: new Set(),
    },
    stats: {
      totalPruneTokens: 0,
      totalToolsPruned: 0,
      totalMessagesCompressed: 0,
    },
    currentTurn: 0,
    nextBlockId: 1,
    nextRunId: 1,
  };
}

function addCompressionBlock(state: RuntimeState, block: CompressionBlock): void {
  state.blocks.set(block.blockId, structuredClone(block));
  if (block.active) state.activeBlockIds.add(block.blockId);
  state.nextBlockId = Math.max(state.nextBlockId, block.blockId + 1);
  state.nextRunId = Math.max(state.nextRunId, block.runId + 1);
  state.stats.totalPruneTokens += Math.max(0, block.compressedTokens - block.summaryTokens);
  state.stats.totalMessagesCompressed += block.memberKeys.length;
}

export function applyMutation(state: RuntimeState, mutation: PersistedMutation): void {
  switch (mutation.kind) {
    case "references-assigned": {
      const pendingByKey = new Map<string, string>();
      const pendingByRef = new Map<string, string>();
      for (const assignment of mutation.assignments) {
        const existingRef = state.references.byKey.get(assignment.key) ?? pendingByKey.get(assignment.key);
        const existingKey = state.references.byRef.get(assignment.ref) ?? pendingByRef.get(assignment.ref);
        if (existingRef !== undefined && existingRef !== assignment.ref) return;
        if (existingKey !== undefined && existingKey !== assignment.key) return;
        pendingByKey.set(assignment.key, assignment.ref);
        pendingByRef.set(assignment.ref, assignment.key);
      }
      for (const [key, reference] of pendingByKey) state.references.byKey.set(key, reference);
      for (const [reference, key] of pendingByRef) state.references.byRef.set(reference, key);
      state.references.nextRef = Math.max(state.references.nextRef, mutation.nextRef);
      break;
    }
    case "tools-pruned":
      for (const record of mutation.records) {
        if (state.prunedTools.has(record.toolCallId)) continue;
        state.prunedTools.set(record.toolCallId, structuredClone(record));
        state.stats.totalPruneTokens += record.tokenCount;
        state.stats.totalToolsPruned += 1;
      }
      break;
    case "compression-created":
      for (const block of mutation.blocks) {
        if (!state.blocks.has(block.blockId)) addCompressionBlock(state, block);
      }
      break;
    case "blocks-activation":
      for (const blockId of mutation.blockIds) {
        const block = state.blocks.get(blockId);
        if (!block) continue;
        block.active = mutation.active;
        block.deactivatedByUser = mutation.byUser && !mutation.active;
        if (mutation.active) state.activeBlockIds.add(blockId);
        else state.activeBlockIds.delete(blockId);
      }
      break;
    case "manual-mode":
      state.manualMode = mutation.enabled;
      break;
    case "nudge-anchors":
      state.nudges.contextLimitAnchors = new Set(mutation.contextLimit);
      state.nudges.turnAnchors = new Set(mutation.turn);
      state.nudges.iterationAnchors = new Set(mutation.iteration);
      break;
    case "native-compaction-reset":
      for (const blockId of mutation.blockIds) {
        const block = state.blocks.get(blockId);
        if (!block) continue;
        block.active = false;
        state.activeBlockIds.delete(blockId);
      }
      break;
  }
}

export function createMutation<T extends Omit<PersistedMutation, "version" | "at">>(
  mutation: T,
  at = Date.now(),
): T & { version: 1; at: number } {
  return { ...mutation, version: 1, at };
}
