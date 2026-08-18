import type { LogicalMessage } from "../messages/logical-messages.ts";
import { isToolRecordProtected } from "../strategies/pruning.ts";
import type {
  BlockActivationChange,
  CompressionBlock,
  PrunedToolRecord,
  RuntimeState,
} from "../state/types.ts";

export interface CompressionTarget {
  displayId: number;
  runId: number;
  topic: string;
  grouped: boolean;
  blocks: CompressionBlock[];
}

function targetFromBlocks(blocks: CompressionBlock[]): CompressionTarget {
  const ordered = [...blocks].sort((left, right) => left.blockId - right.blockId);
  const first = ordered[0];
  if (!first) throw new Error("Cannot build an empty compression target.");
  return {
    displayId: first.blockId,
    runId: first.runId,
    topic: first.mode === "message" ? first.batchTopic ?? first.topic : first.topic,
    grouped: first.mode === "message",
    blocks: ordered,
  };
}

export function resolveCompressionTarget(state: RuntimeState, blockId: number): CompressionTarget | undefined {
  const block = state.blocks.get(blockId);
  if (!block) return undefined;
  if (block.mode !== "message") return targetFromBlocks([block]);
  return targetFromBlocks([...state.blocks.values()].filter((candidate) => (
    candidate.mode === "message" && candidate.runId === block.runId
  )));
}

export function listCompressionTargets(state: RuntimeState, active: boolean): CompressionTarget[] {
  const blocks = [...state.blocks.values()];
  const eligible = blocks.filter((block) => (
    active ? block.active : !block.active && block.deactivatedByUser
  ));
  const targets = eligible
    .filter((block) => block.mode !== "message")
    .map((block) => targetFromBlocks([block]));
  const eligibleRuns = new Set(
    eligible.filter((block) => block.mode === "message").map((block) => block.runId),
  );
  for (const runId of eligibleRuns) {
    const runBlocks = active
      ? eligible.filter((block) => block.mode === "message" && block.runId === runId)
      : blocks.filter((block) => block.mode === "message" && block.runId === runId);
    targets.push(targetFromBlocks(runBlocks));
  }
  return targets.sort((left, right) => left.displayId - right.displayId);
}

function blockContains(state: RuntimeState, parent: CompressionBlock, targetId: number): boolean {
  const queue = [...parent.consumedBlockIds];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const blockId = queue.shift();
    if (blockId === undefined || seen.has(blockId)) continue;
    if (blockId === targetId) return true;
    seen.add(blockId);
    const child = state.blocks.get(blockId);
    if (child) queue.push(...child.consumedBlockIds);
  }
  return false;
}

function activeAncestor(state: RuntimeState, blockId: number, excluded: ReadonlySet<number>): number | undefined {
  for (const activeId of state.activeBlockIds) {
    if (excluded.has(activeId)) continue;
    const active = state.blocks.get(activeId);
    if (active?.active && blockContains(state, active, blockId)) return activeId;
  }
  return undefined;
}

export function planDecompress(state: RuntimeState, blockId: number): BlockActivationChange[] {
  const target = resolveCompressionTarget(state, blockId);
  if (!target) throw new Error(`Compression ${blockId} does not exist.`);
  const targetIds = new Set(target.blocks.map((block) => block.blockId));
  const activeBlocks = target.blocks.filter((block) => block.active);
  if (activeBlocks.length === 0) {
    const ancestor = activeAncestor(state, blockId, targetIds);
    if (ancestor !== undefined) {
      throw new Error(`Compression ${blockId} is inside compression ${ancestor}; restore its parent first.`);
    }
    throw new Error(`Compression ${blockId} is not active.`);
  }

  const changes: BlockActivationChange[] = target.blocks.map((block) => ({
    blockId: block.blockId,
    active: false,
    deactivatedByUser: true,
  }));
  const remainingActive = new Set([...state.activeBlockIds].filter((id) => !targetIds.has(id)));
  const childIds = new Set(activeBlocks.flatMap((block) => block.consumedBlockIds));
  for (const childId of childIds) {
    const child = state.blocks.get(childId);
    if (!child || child.deactivatedByUser) continue;
    const stillConsumed = [...remainingActive].some((activeId) => {
      const activeBlock = state.blocks.get(activeId);
      return activeBlock ? blockContains(state, activeBlock, childId) : false;
    });
    if (!stillConsumed) changes.push({ blockId: childId, active: true, deactivatedByUser: false });
  }
  return changes;
}

export function planRecompress(state: RuntimeState, blockId: number): BlockActivationChange[] {
  const target = resolveCompressionTarget(state, blockId);
  if (!target) throw new Error(`Compression ${blockId} does not exist.`);
  if (!target.blocks.some((block) => block.deactivatedByUser && !block.active)) {
    throw new Error(`Compression ${blockId} is not user-decompressed.`);
  }
  const targetIds = new Set(target.blocks.map((block) => block.blockId));
  for (const block of target.blocks) {
    const ancestor = activeAncestor(state, block.blockId, targetIds);
    if (ancestor !== undefined) {
      throw new Error(`Compression ${blockId} is inside compression ${ancestor}; restore its parent first.`);
    }
  }

  const changes: BlockActivationChange[] = [];
  const childIds = new Set(target.blocks.flatMap((block) => block.consumedBlockIds));
  for (const childId of childIds) {
    const child = state.blocks.get(childId);
    if (child?.active) changes.push({ blockId: childId, active: false, deactivatedByUser: false });
  }
  for (const block of target.blocks) {
    changes.push({ blockId: block.blockId, active: true, deactivatedByUser: false });
  }
  return changes;
}

export interface SweepOptions {
  lastN?: number;
  protectedTools: string[];
  protectedFilePatterns: string[];
}

export function selectSweepTools(
  state: RuntimeState,
  groups: readonly LogicalMessage[],
  options: SweepOptions,
  now = Date.now(),
): PrunedToolRecord[] {
  const ordered = [...state.toolCalls.values()].sort((left, right) => left.order - right.order);
  let candidates = ordered;
  if (options.lastN !== undefined) {
    const count = Math.max(0, Math.floor(options.lastN));
    candidates = count === 0 ? [] : ordered.slice(-count);
  } else {
    let lastUserIndex = -1;
    for (let index = groups.length - 1; index >= 0; index--) {
      if (groups[index]?.kind === "user") {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex < 0) return [];
    const eligibleKeys = new Set(groups.slice(lastUserIndex + 1).flatMap((group) => group.key ? [group.key] : []));
    candidates = ordered.filter((record) => record.groupKey && eligibleKeys.has(record.groupKey));
  }

  return candidates.flatMap((record): PrunedToolRecord[] => {
    if (record.nativePruned || state.prunedTools.has(record.toolCallId)) return [];
    if (record.toolName === "edit" || record.toolName === "write") return [];
    if (isToolRecordProtected(record, options.protectedTools, options.protectedFilePatterns)) return [];
    return [{
      toolCallId: record.toolCallId,
      reason: "sweep",
      tokenCount: record.tokenCount,
      prunedAt: now,
    }];
  });
}
