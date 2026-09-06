import { compressionCoveredKeys } from "./active-blocks.ts";
import { countTokens } from "../token-utils.ts";
import type { CompressionBlock, RuntimeState } from "../state/types.ts";
import { wrapCompressedSummary } from "./summaries.ts";
import type { PreparedCompression } from "./types.ts";

export function buildCompressionBlocks(
  state: RuntimeState,
  prepared: readonly PreparedCompression[],
  durationMs = 0,
  now = Date.now(),
): CompressionBlock[] {
  if (prepared.length === 0) return [];
  const runId = state.nextRunId;
  let nextBlockId = state.nextBlockId;
  const newlyCovered = new Set<string>();
  const blocks: CompressionBlock[] = [];

  for (const plan of prepared) {
    const blockId = nextBlockId;
    nextBlockId += 1;
    const initiallyCovered = compressionCoveredKeys(plan.selection.activeBlocks);
    const memberKeys = new Set(plan.selection.groupKeys);
    const directMemberKeys: string[] = [];
    const toolCallIds = new Set(plan.selection.toolCallIds);
    for (const consumedBlockId of plan.consumedBlockIds) {
      const consumed = plan.selection.activeBlocks.get(consumedBlockId);
      if (!consumed) throw new Error(`Compressed block is not applicable: b${consumedBlockId}`);
      for (const key of consumed.memberKeys) memberKeys.add(key);
      for (const toolCallId of consumed.toolCallIds) toolCallIds.add(toolCallId);
    }

    let compressedTokens = 0;
    for (const key of plan.selection.groupKeys) {
      if (!initiallyCovered.has(key) && !newlyCovered.has(key)) {
        compressedTokens += plan.selection.tokensByKey.get(key) ?? 0;
        directMemberKeys.push(key);
      }
      newlyCovered.add(key);
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
