import { countTokens } from "../token-utils.ts";
import type { CompressionBlock, RuntimeState } from "../state/types.ts";
import { wrapCompressedSummary } from "./summaries.ts";
import type { PreparedCompression } from "./types.ts";

function coveredKeys(state: RuntimeState): Set<string> {
  const covered = new Set<string>();
  for (const blockId of state.activeBlockIds) {
    const block = state.blocks.get(blockId);
    if (!block?.active) continue;
    for (const key of block.memberKeys) covered.add(key);
  }
  return covered;
}

export function buildCompressionBlocks(
  state: RuntimeState,
  prepared: readonly PreparedCompression[],
  durationMs = 0,
  now = Date.now(),
): CompressionBlock[] {
  if (prepared.length === 0) return [];
  const runId = state.nextRunId;
  let nextBlockId = state.nextBlockId;
  const initiallyCovered = coveredKeys(state);
  const blocks: CompressionBlock[] = [];

  for (const plan of prepared) {
    const blockId = nextBlockId;
    nextBlockId += 1;
    const memberKeys = new Set(plan.selection.groupKeys);
    const directMemberKeys: string[] = [];
    const toolCallIds = new Set(plan.selection.toolCallIds);
    for (const consumedBlockId of plan.consumedBlockIds) {
      const consumed = state.blocks.get(consumedBlockId);
      if (!consumed) throw new Error(`Compressed block not found: b${consumedBlockId}`);
      for (const key of consumed.memberKeys) memberKeys.add(key);
      for (const toolCallId of consumed.toolCallIds) toolCallIds.add(toolCallId);
    }

    let compressedTokens = 0;
    for (const key of plan.selection.groupKeys) {
      if (!initiallyCovered.has(key)) {
        compressedTokens += plan.selection.tokensByKey.get(key) ?? 0;
        directMemberKeys.push(key);
      }
      initiallyCovered.add(key);
    }
    const storedSummary = wrapCompressedSummary(blockId, plan.summary);
    blocks.push({
      blockId,
      runId,
      mode: plan.mode,
      active: true,
      deactivatedByUser: false,
      topic: plan.topic,
      batchTopic: plan.batchTopic,
      startRef: plan.startRef,
      endRef: plan.endRef,
      anchorKey: plan.anchorKey,
      memberKeys: [...memberKeys],
      directMemberKeys,
      toolCallIds: [...toolCallIds],
      includedBlockIds: [...plan.consumedBlockIds],
      consumedBlockIds: [...plan.consumedBlockIds],
      summary: storedSummary,
      compressedTokens,
      summaryTokens: countTokens(storedSummary),
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
      createdAt: now,
    });
  }
  return blocks;
}
