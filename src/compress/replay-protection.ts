import { hasOpaqueProviderReplay, type LogicalMessage } from "../messages/logical-messages.ts";
import type { RuntimeState } from "../state/types.ts";

/** Include all consumers of unsafe blocks, including inactive saved ancestors. */
export function collectReplayUnsafeBlockIds(
  state: RuntimeState,
  seeds: Iterable<number>,
): Set<number> {
  const unsafe = new Set(seeds);
  const parents = new Map<number, number[]>();
  for (const block of state.blocks.values()) {
    if (block.invalidatedByReplay) unsafe.add(block.blockId);
    for (const child of block.consumedBlockIds) {
      const consumers = parents.get(child);
      if (consumers) consumers.push(block.blockId);
      else parents.set(child, [block.blockId]);
    }
  }
  const pending = [...unsafe];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (id === undefined) continue;
    for (const parent of parents.get(id) ?? []) {
      if (unsafe.has(parent)) continue;
      unsafe.add(parent);
      pending.push(parent);
    }
  }
  return unsafe;
}

export function replayUnsafeBlockIds(
  state: RuntimeState,
  groups: readonly LogicalMessage[],
): Set<number> {
  const replayKeys = new Set(groups.flatMap((group) => (
    group.key && group.messages.some(hasOpaqueProviderReplay) ? [group.key] : []
  )));
  const seeds = [...state.blocks.values()]
    .filter((block) => block.memberKeys.some((key) => replayKeys.has(key)))
    .map((block) => block.blockId);
  return collectReplayUnsafeBlockIds(state, seeds);
}

/** Return only newly unsafe blocks, so request-time reconciliation is idempotent. */
export function planReplayBlockInvalidation(
  state: RuntimeState,
  groups: readonly LogicalMessage[],
): number[] {
  return [...replayUnsafeBlockIds(state, groups)]
    .filter((id) => !state.blocks.get(id)?.invalidatedByReplay)
    .sort((left, right) => left - right);
}
