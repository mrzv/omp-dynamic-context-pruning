import { parseMessageReference } from "../messages/identity.ts";
import type { LogicalMessage } from "../messages/logical-messages.ts";
import type { CompressionBlock, RuntimeState } from "../state/types.ts";
import { countMessagesTokens } from "../token-utils.ts";
import type {
  BoundaryReference,
  CompressionSearchContext,
  CompressionSelection,
} from "./types.ts";

function parseBlockReference(reference: string): number | undefined {
  const match = /^b([1-9]\d*)$/.exec(reference.trim().toLowerCase());
  if (!match) return undefined;
  const blockId = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(blockId) ? blockId : undefined;
}

function hasProviderNativeToolHistory(group: LogicalMessage): boolean {
  return group.toolCalls.some((call) => (
    call.providerMetadata !== undefined || call.thoughtSignature !== undefined
  )) || group.toolResults.some((result) => result.providerMetadata !== undefined);
}

export function buildCompressionSearchContext(
  state: RuntimeState,
  groups: readonly LogicalMessage[],
): CompressionSearchContext {
  const groupByKey = new Map<string, LogicalMessage>();
  const indexByKey = new Map<string, number>();
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (!group?.key) continue;
    groupByKey.set(group.key, group);
    indexByKey.set(group.key, index);
  }
  const activeBlocks = new Map<number, CompressionBlock>();
  for (const [blockId, block] of state.blocks) {
    if (block.active) activeBlocks.set(blockId, block);
  }
  return { groups, groupByKey, indexByKey, activeBlocks };
}

export function resolveBoundary(
  context: CompressionSearchContext,
  state: RuntimeState,
  rawReference: string,
): BoundaryReference {
  const reference = rawReference.trim().toLowerCase();
  if (parseMessageReference(reference) !== undefined) {
    const groupKey = state.references.byRef.get(reference);
    const groupIndex = groupKey ? context.indexByKey.get(groupKey) : undefined;
    if (!groupKey || groupIndex === undefined) {
      throw new Error(`${reference} is not available in the current conversation context.`);
    }
    return { kind: "message", groupIndex, groupKey };
  }

  const blockId = parseBlockReference(reference);
  if (blockId === undefined) {
    throw new Error(`${rawReference} is invalid. Use an injected message ID (mNNNN) or block ID (bN).`);
  }
  const block = context.activeBlocks.get(blockId);
  const groupIndex = block ? context.indexByKey.get(block.anchorKey) : undefined;
  if (!block || groupIndex === undefined) {
    throw new Error(`b${blockId} is not available in the current conversation context.`);
  }
  return { kind: "compressed-block", groupIndex, blockId, anchorKey: block.anchorKey };
}

export function resolveBoundaries(
  context: CompressionSearchContext,
  state: RuntimeState,
  startId: string,
  endId: string,
): { startReference: BoundaryReference; endReference: BoundaryReference } {
  const startReference = resolveBoundary(context, state, startId);
  const endReference = resolveBoundary(context, state, endId);
  if (startReference.groupIndex > endReference.groupIndex) {
    throw new Error(`${startId} appears after ${endId}; the start boundary must come first.`);
  }
  return { startReference, endReference };
}

export function resolveSelection(
  context: CompressionSearchContext,
  startReference: BoundaryReference,
  endReference: BoundaryReference,
): CompressionSelection {
  const groups: LogicalMessage[] = [];
  const groupKeys: string[] = [];
  const tokensByKey = new Map<string, number>();
  const toolCallIds: string[] = [];

  for (let index = startReference.groupIndex; index <= endReference.groupIndex; index++) {
    const group = context.groups[index];
    if (!group?.key || group.protected || hasProviderNativeToolHistory(group)) continue;
    groups.push(group);
    groupKeys.push(group.key);
    tokensByKey.set(group.key, countMessagesTokens(group.messages));
    for (const call of group.toolCalls) toolCallIds.push(call.id);
  }
  if (groups.length === 0) throw new Error("The selected boundaries contain no compressible messages.");

  const selectedKeys = new Set(groupKeys);
  const requiredBlockIds = [...context.activeBlocks.values()]
    .filter((block) => selectedKeys.has(block.anchorKey))
    .sort((left, right) => {
      const leftIndex = context.indexByKey.get(left.anchorKey) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = context.indexByKey.get(right.anchorKey) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || left.blockId - right.blockId;
    })
    .map((block) => block.blockId);

  return {
    startReference,
    endReference,
    groups,
    groupKeys,
    tokensByKey,
    toolCallIds,
    requiredBlockIds,
  };
}

export function selectionAnchor(reference: BoundaryReference): string {
  const anchor = reference.kind === "compressed-block" ? reference.anchorKey : reference.groupKey;
  if (!anchor) throw new Error("Unable to resolve a compression anchor.");
  return anchor;
}
