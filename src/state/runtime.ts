import { createMessageReferenceState } from "../messages/identity.ts";
import type { CompressionBlock, PersistedMutation, RuntimeState } from "./types.ts";
import { collectReplayUnsafeBlockIds } from "../compress/replay-protection.ts";

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
  state.stats.totalPruneTokens += block.compressedTokens;
  state.stats.totalMessagesCompressed += block.directMemberKeys.length;
}

function coveredKeys(state: RuntimeState, activeBlockIds: ReadonlySet<number>): Set<string> {
  const keys = new Set<string>();
  for (const blockId of activeBlockIds) {
    const block = state.blocks.get(blockId);
    if (!block) continue;
    for (const key of block.memberKeys) keys.add(key);
  }
  return keys;
}

// A parent stores only its newly compressed tokens; consumed children account
// for the rest. Quarantining a parent restores the entire represented subtree,
// unlike ordinary decompression, which can reactivate the children.
function representedCompressionTokens(state: RuntimeState): number {
  const seen = new Set<number>();
  const pending = [...state.activeBlockIds];
  let tokens = 0;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const block = state.blocks.get(id);
    if (!block || block.invalidatedByReplay) continue;
    // A consumed child marked user-decompressed is still represented by its
    // active parent until that parent is restored. Include its contribution.
    tokens += block.compressedTokens;
    pending.push(...block.consumedBlockIds);
  }
  return tokens;
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
    case "compression-created": {
      const incomingIds = new Set<number>();
      for (const block of mutation.blocks) {
        if (
          !block.active
          || block.deactivatedByUser
          || block.invalidatedByReplay
          || incomingIds.has(block.blockId)
          || state.blocks.has(block.blockId)
          || block.consumedBlockIds.some((blockId) => (
            !state.blocks.has(blockId) || state.blocks.get(blockId)?.invalidatedByReplay
          ))
        ) return;
        incomingIds.add(block.blockId);
      }
      for (const block of mutation.blocks) addCompressionBlock(state, block);
      for (const block of mutation.blocks) {
        for (const consumedBlockId of block.consumedBlockIds) {
          const consumed = state.blocks.get(consumedBlockId);
          if (!consumed) return;
          consumed.active = false;
          state.activeBlockIds.delete(consumedBlockId);
        }
      }
      break;
    }
    case "blocks-activation": {
      const changedIds = new Set<number>();
      for (const change of mutation.changes) {
        const block = state.blocks.get(change.blockId);
        if (changedIds.has(change.blockId) || !block) return;
        if (block.invalidatedByReplay && (change.active || change.deactivatedByUser)) return;
        changedIds.add(change.blockId);
      }
      const beforeActive = new Set(state.activeBlockIds);
      const afterActive = new Set(beforeActive);
      for (const change of mutation.changes) {
        if (change.active) afterActive.add(change.blockId);
        else afterActive.delete(change.blockId);
      }
      const beforeCovered = coveredKeys(state, beforeActive);
      const afterCovered = coveredKeys(state, afterActive);
      let tokenDelta = 0;
      for (const change of mutation.changes) {
        const block = state.blocks.get(change.blockId);
        if (!block || block.active === change.active) continue;
        if (change.active && block.directMemberKeys.some((key) => !beforeCovered.has(key))) {
          tokenDelta += block.compressedTokens;
        } else if (!change.active && block.directMemberKeys.some((key) => !afterCovered.has(key))) {
          tokenDelta -= block.compressedTokens;
        }
      }
      for (const change of mutation.changes) {
        const block = state.blocks.get(change.blockId);
        if (!block) return;
        block.active = change.active;
        block.deactivatedByUser = change.deactivatedByUser;
      }
      state.activeBlockIds = afterActive;
      state.stats.totalPruneTokens = Math.max(0, state.stats.totalPruneTokens + tokenDelta);
      break;
    }
    case "replay-blocks-invalidated": {
      if (mutation.blockIds.some((id) => !state.blocks.has(id))) return;
      // Include consuming ancestors, even in an older or partially repaired
      // journal. Otherwise recompressing a parent could restore unsafe coverage.
      const invalidIds = collectReplayUnsafeBlockIds(state, mutation.blockIds);
      const beforeTokens = representedCompressionTokens(state);
      for (const id of invalidIds) {
        const block = state.blocks.get(id);
        if (!block) continue;
        block.active = false;
        block.deactivatedByUser = false;
        block.invalidatedByReplay = true;
        state.activeBlockIds.delete(id);
      }
      const restoredTokens = beforeTokens - representedCompressionTokens(state);
      state.stats.totalPruneTokens = Math.max(0, state.stats.totalPruneTokens - restoredTokens);
      break;
    }
    case "manual-mode":
      state.manualMode = mutation.enabled;
      break;
    case "nudge-anchors":
      state.nudges.contextLimitAnchors = new Set(mutation.contextLimit);
      state.nudges.turnAnchors = new Set(mutation.turn);
      state.nudges.iterationAnchors = new Set(mutation.iteration);
      break;
    case "native-compaction-reset":
      state.references = createMessageReferenceState();
      state.toolCalls.clear();
      state.prunedTools.clear();
      state.blocks.clear();
      state.activeBlockIds.clear();
      state.nudges.contextLimitAnchors.clear();
      state.nudges.turnAnchors.clear();
      state.nudges.iterationAnchors.clear();
      state.currentTurn = 0;
      state.nextBlockId = 1;
      state.nextRunId = 1;
      break;
  }
}

export function createMutation<T extends Omit<PersistedMutation, "version" | "at">>(
  mutation: T,
  at = Date.now(),
): T & { version: 1; at: number } {
  return { ...mutation, version: 1, at };
}
