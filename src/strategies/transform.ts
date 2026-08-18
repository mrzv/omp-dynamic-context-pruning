import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { LogicalMessage } from "../messages/logical-messages.ts";
import type { RuntimeState } from "../state/types.ts";

export const PRUNED_TOOL_OUTPUT = "[Output removed to save context - information superseded or no longer needed]";
export const PRUNED_ERROR_INPUT = "[input removed due to failed tool call]";
export const PRUNED_QUESTION_INPUT = "[questions removed - see output for user's answers]";

function pruneFailedInput(call: ToolCall): void {
  for (const [key, value] of Object.entries(call.arguments)) {
    if (typeof value === "string") call.arguments[key] = PRUNED_ERROR_INPUT;
  }
}

function pruneToolOutput(result: ToolResultMessage): boolean {
  if (result.providerMetadata !== undefined) return false;
  result.content = [{ type: "text", text: PRUNED_TOOL_OUTPUT }];
  return true;
}

function pruneQuestionInput(call: ToolCall): boolean {
  if (!("questions" in call.arguments)) return false;
  call.arguments.questions = PRUNED_QUESTION_INPUT;
  return true;
}

export function applySelectedToolPruning(groups: readonly LogicalMessage[], state: RuntimeState): number {
  let changed = 0;
  for (const group of groups) {
    if (group.toolCalls.length === 0) continue;
    const resultByCallId = new Map(group.toolResults.map((result) => [result.toolCallId, result]));
    let assistantChanged = false;

    for (const call of group.toolCalls) {
      const prune = state.prunedTools.get(call.id);
      if (!prune) continue;
      const result = resultByCallId.get(call.id);
      if (prune.reason === "purge-error" || result?.isError === true) {
        if (
          call.providerMetadata !== undefined
          || call.thoughtSignature !== undefined
          || result?.providerMetadata !== undefined
        ) continue;
        pruneFailedInput(call);
        assistantChanged = true;
        changed += 1;
        continue;
      }
      if (call.name === "ask" || call.name === "question") {
        if (call.providerMetadata !== undefined || call.thoughtSignature !== undefined) continue;
        if (!pruneQuestionInput(call)) continue;
        assistantChanged = true;
        changed += 1;
        continue;
      }
      if (call.name === "edit" || call.name === "write") continue;
      if (!result || !pruneToolOutput(result)) continue;
      changed += 1;
    }

    if (assistantChanged) {
      const assistant = group.messages[0] as unknown as Record<string, unknown> | undefined;
      if (assistant) delete assistant.providerPayload;
    }
  }
  return changed;
}
