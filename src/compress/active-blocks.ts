import type { LogicalMessage } from "../messages/logical-messages.ts";
import { replayUnsafeBlockIds } from "./replay-protection.ts";
import type { CompressionBlock, RuntimeState } from "../state/types.ts";

/**
 * The blocks actually usable in this request. A persisted block is not evidence
 * that its members are still compressible. Keep this check shared by selection,
 * nesting, projection, priorities, and the nudge's summary-token budget.
 * This view never mutates persisted blocks or reactivates consumed children.
 */
export function effectiveActiveBlocks(
  state: RuntimeState,
  groups: readonly LogicalMessage[],
): Map<number, CompressionBlock> {
  const availableKeys = new Set(groups.flatMap((group) => group.key ? [group.key] : []));
  const unsafeBlocks = replayUnsafeBlockIds(state, groups);
  const blocks = new Map<number, CompressionBlock>();
  for (const blockId of [...state.activeBlockIds].sort((left, right) => left - right)) {
    const block = state.blocks.get(blockId);
    if (!block?.active || !availableKeys.has(block.anchorKey)) continue;
    if (unsafeBlocks.has(blockId)) continue;
    blocks.set(blockId, block);
  }
  return blocks;
}

export function compressionCoveredKeys(blocks: ReadonlyMap<number, CompressionBlock>): Set<string> {
  const keys = new Set<string>();
  for (const block of blocks.values()) {
    for (const key of block.memberKeys) keys.add(key);
  }
  return keys;
}
