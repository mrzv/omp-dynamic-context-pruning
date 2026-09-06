import { compressionCoveredKeys, effectiveActiveBlocks } from "./active-blocks.ts";
import type { LogicalMessage } from "../messages/logical-messages.ts";
import type { MessagePriority } from "../messages/metadata.ts";
import type { RuntimeState } from "../state/types.ts";
import { countMessagesTokens } from "../token-utils.ts";

export interface CompressionPriorityEntry {
  ref: string;
  tokenCount: number;
  priority: MessagePriority;
}

export type CompressionPriorityMap = Map<string, CompressionPriorityEntry>;

export function classifyMessagePriority(tokenCount: number): MessagePriority {
  if (tokenCount >= 5_000) return "high";
  if (tokenCount >= 500) return "medium";
  return "low";
}

export function buildPriorityMap(
  groups: readonly LogicalMessage[],
  state: RuntimeState,
  messageMode: boolean,
  protectUserMessages: boolean,
): CompressionPriorityMap {
  if (!messageMode) return new Map();
  const covered = compressionCoveredKeys(effectiveActiveBlocks(state, groups));
  const priorities: CompressionPriorityMap = new Map();
  for (const group of groups) {
    if (!group.key || !group.ref || group.protected || covered.has(group.key)) continue;
    if (protectUserMessages && group.kind === "user") continue;
    const tokenCount = countMessagesTokens(group.messages);
    const hasCompressCall = group.toolCalls.some((call) => call.name === "compress");
    priorities.set(group.key, {
      ref: group.ref,
      tokenCount,
      priority: hasCompressCall ? "high" : classifyMessagePriority(tokenCount),
    });
  }
  return priorities;
}

export function priorityTags(priorities: CompressionPriorityMap): Map<string, MessagePriority> {
  return new Map([...priorities].map(([key, entry]) => [key, entry.priority]));
}
