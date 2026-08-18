import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { LogicalMessage } from "../messages/logical-messages.ts";
import { countMessageTokens, countTokens } from "../token-utils.ts";
import type { RuntimeState, ToolCallRecord } from "./types.ts";

const NATIVE_PRUNE_PLACEHOLDER = /^\[(?:Output truncated - \d+ tokens|Uneventful result elided|Old tool result content cleared)\]$/;

function isNativePruned(call: ToolCall, result: ToolResultMessage | undefined): boolean {
  if (call.providerMetadata !== undefined || call.thoughtSignature !== undefined) return true;
  if (!result) return false;
  if (result.providerMetadata !== undefined || result.prunedAt !== undefined || result.useless === true) {
    return true;
  }
  if (result.content.length !== 1 || result.content[0]?.type !== "text") return false;
  return NATIVE_PRUNE_PLACEHOLDER.test(result.content[0].text.trim());
}

function recordForCall(
  call: ToolCall,
  result: ToolResultMessage | undefined,
  group: LogicalMessage,
  turn: number,
  order: number,
): ToolCallRecord {
  const serializedInput = JSON.stringify(call.arguments);
  const tokenCount = countTokens(serializedInput) + (result ? countMessageTokens(result) : 0);
  return {
    toolCallId: call.id,
    toolName: call.name,
    input: structuredClone(call.arguments),
    ...(group.key ? { groupKey: group.key } : {}),
    ...(group.ref ? { groupRef: group.ref } : {}),
    turn,
    order,
    isError: result?.isError === true,
    nativePruned: isNativePruned(call, result),
    tokenCount,
  };
}

export function rebuildToolCache(state: RuntimeState, groups: readonly LogicalMessage[]): void {
  const records = new Map<string, ToolCallRecord>();
  let turn = 0;
  let order = 0;

  for (const group of groups) {
    if (group.kind === "assistant") turn += 1;
    const resultByCallId = new Map(group.toolResults.map((result) => [result.toolCallId, result]));
    for (const call of group.toolCalls) {
      records.set(call.id, recordForCall(call, resultByCallId.get(call.id), group, turn, order));
      order += 1;
    }
  }

  state.currentTurn = turn;
  state.toolCalls = records;
}
