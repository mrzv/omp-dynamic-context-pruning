import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { messageFingerprint } from "../messages/identity.ts";
import type { LogicalMessage } from "../messages/logical-messages.ts";
import { countMessageTokens, countTokens } from "../token-utils.ts";
import type { RuntimeState, ToolCallRecord } from "./types.ts";

const NATIVE_PRUNE_PLACEHOLDER = /^\[(?:Output truncated - \d+ tokens|Uneventful result elided|Old tool result content cleared)\]$/;

interface CachedToolRecord {
  sourceKey: string;
  toolName: string;
  input: Record<string, unknown>;
  tokenCount: number;
}

export interface ToolCacheBuildStats {
  hits: number;
  misses: number;
}

export class ToolRecordCache {
  private readonly records = new Map<string, CachedToolRecord>();

  get(toolCallId: string, sourceKey: string): CachedToolRecord | undefined {
    const record = this.records.get(toolCallId);
    return record?.sourceKey === sourceKey ? record : undefined;
  }

  set(toolCallId: string, record: CachedToolRecord): void {
    this.records.set(toolCallId, record);
  }

  retain(toolCallIds: ReadonlySet<string>): void {
    for (const toolCallId of this.records.keys()) {
      if (!toolCallIds.has(toolCallId)) this.records.delete(toolCallId);
    }
  }

  clear(): void {
    this.records.clear();
  }
}

function isNativePruned(call: ToolCall, result: ToolResultMessage | undefined): boolean {
  if (call.providerMetadata !== undefined || call.thoughtSignature !== undefined) return true;
  if (!result) return false;
  if (result.providerMetadata !== undefined || result.prunedAt !== undefined || result.useless === true) {
    return true;
  }
  if (result.content.length !== 1 || result.content[0]?.type !== "text") return false;
  return NATIVE_PRUNE_PLACEHOLDER.test(result.content[0].text.trim());
}

export function rebuildToolCache(
  state: RuntimeState,
  groups: readonly LogicalMessage[],
  cache = new ToolRecordCache(),
  fingerprintForEntryId?: (entryId: string) => string | undefined,
): ToolCacheBuildStats {
  const records = new Map<string, ToolCallRecord>();
  const activeToolCallIds = new Set<string>();
  let turn = 0;
  let order = 0;
  let hits = 0;
  let misses = 0;

  for (const group of groups) {
    if (group.kind === "assistant") turn += 1;
    const resultByCallId = new Map(group.toolResults.map((result) => [result.toolCallId, result]));
    const resultEntryIdByCallId = new Map<string, string>();
    for (let index = 0; index < group.messages.length; index++) {
      const message = group.messages[index];
      const entryId = group.entryIds[index];
      if (message?.role === "toolResult" && entryId) resultEntryIdByCallId.set(message.toolCallId, entryId);
    }
    const assistant = group.messages[0];
    const assistantEntryId = group.entryIds[0];
    const assistantFingerprint = (
      assistantEntryId ? fingerprintForEntryId?.(assistantEntryId) : undefined
    ) ?? (assistant ? messageFingerprint(assistant) : "");

    for (const call of group.toolCalls) {
      activeToolCallIds.add(call.id);
      const result = resultByCallId.get(call.id);
      const resultEntryId = resultEntryIdByCallId.get(call.id);
      const resultFingerprint = resultEntryId
        ? fingerprintForEntryId?.(resultEntryId)
        : undefined;
      const sourceKey = [
        assistantFingerprint,
        resultFingerprint ?? (result ? messageFingerprint(result) : ""),
      ].join("|");
      let cached = cache.get(call.id, sourceKey);
      if (cached) {
        hits += 1;
      } else {
        const serializedInput = JSON.stringify(call.arguments);
        cached = {
          sourceKey,
          toolName: call.name,
          input: structuredClone(call.arguments),
          tokenCount: countTokens(serializedInput) + (result ? countMessageTokens(result) : 0),
        };
        cache.set(call.id, cached);
        misses += 1;
      }
      records.set(call.id, {
        toolCallId: call.id,
        toolName: cached.toolName,
        input: cached.input,
        ...(group.key ? { groupKey: group.key } : {}),
        ...(group.ref ? { groupRef: group.ref } : {}),
        turn,
        order,
        isError: result?.isError === true,
        nativePruned: isNativePruned(call, result),
        tokenCount: cached.tokenCount,
      });
      order += 1;
    }
  }

  cache.retain(activeToolCallIds);
  state.currentTurn = turn;
  state.toolCalls = records;
  return { hits, misses };
}
