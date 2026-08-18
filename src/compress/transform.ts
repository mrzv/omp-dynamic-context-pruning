import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import type { LogicalMessage } from "../messages/logical-messages.ts";
import { replaceBlockIdsWithBlocked } from "../messages/metadata.ts";
import type { CompressionBlock, RuntimeState } from "../state/types.ts";

function syntheticSummary(summary: string, timestamp: number, messageMode: boolean): UserMessage {
  return {
    role: "user",
    content: messageMode ? replaceBlockIdsWithBlocked(summary) : summary,
    synthetic: true,
    attribution: "agent",
    timestamp,
  };
}

export function applyCompressedContext(
  groups: readonly LogicalMessage[],
  state: RuntimeState,
  messageMode: boolean,
): AgentMessage[] {
  const availableKeys = new Set(groups.flatMap((group) => group.key ? [group.key] : []));
  const blocksByAnchor = new Map<string, CompressionBlock[]>();
  const coveredKeys = new Set<string>();

  for (const blockId of [...state.activeBlockIds].sort((left, right) => left - right)) {
    const block = state.blocks.get(blockId);
    if (!block?.active || !availableKeys.has(block.anchorKey)) continue;
    const anchored = blocksByAnchor.get(block.anchorKey);
    if (anchored) anchored.push(block);
    else blocksByAnchor.set(block.anchorKey, [block]);
    for (const key of block.memberKeys) coveredKeys.add(key);
  }

  const transformed: AgentMessage[] = [];
  for (const group of groups) {
    if (group.key) {
      const anchored = blocksByAnchor.get(group.key);
      if (anchored) {
        const timestamp = (group.messages[0] as { timestamp?: number } | undefined)?.timestamp ?? Date.now();
        for (const block of anchored) {
          transformed.push(syntheticSummary(block.summary, timestamp, messageMode));
        }
      }
      if (coveredKeys.has(group.key)) continue;
    }
    transformed.push(...group.messages);
  }
  return transformed;
}
