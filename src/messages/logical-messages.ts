import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";

export type LogicalMessageKind = "user" | "assistant" | "execution" | "protected" | "orphan-tool-result";

export interface LogicalMessage {
  key?: string;
  ref?: string;
  kind: LogicalMessageKind;
  protected: boolean;
  startIndex: number;
  endIndex: number;
  entryIds: string[];
  messages: AgentMessage[];
  toolCalls: ToolCall[];
  toolResults: ToolResultMessage[];
}

export function assistantToolCalls(message: AgentMessage): ToolCall[] {
  if (message.role !== "assistant") return [];
  return (message as AssistantMessage).content.filter(
    (part): part is ToolCall => part.type === "toolCall",
  );
}

function messageKind(message: AgentMessage): LogicalMessageKind {
  if (message.role === "user") return "user";
  if (message.role === "assistant") return "assistant";
  if (message.role === "bashExecution" || message.role === "pythonExecution" || message.role === "fileMention") {
    return "execution";
  }
  if (message.role === "toolResult") return "orphan-tool-result";
  return "protected";
}

export function buildLogicalMessages(
  messages: readonly AgentMessage[],
  entryIdsByIndex: readonly (string | undefined)[] = [],
): LogicalMessage[] {
  const groups: LogicalMessage[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    const entryId = entryIdsByIndex[index];
    const kind = messageKind(message);

    if (message.role !== "assistant") {
      groups.push({
        ...(entryId ? { key: entryId } : {}),
        kind,
        protected: kind === "protected" || kind === "orphan-tool-result" || !entryId,
        startIndex: index,
        endIndex: index,
        entryIds: entryId ? [entryId] : [],
        messages: [message],
        toolCalls: [],
        toolResults: message.role === "toolResult" ? [message as ToolResultMessage] : [],
      });
      continue;
    }

    const toolCalls = assistantToolCalls(message);
    const expectedResults = new Set(toolCalls.map((call) => call.id));
    const groupedMessages: AgentMessage[] = [message];
    const toolResults: ToolResultMessage[] = [];
    const entryIds = entryId ? [entryId] : [];
    let endIndex = index;

    while (expectedResults.size > 0 && endIndex + 1 < messages.length) {
      const candidateIndex = endIndex + 1;
      const candidate = messages[candidateIndex];
      if (!candidate || candidate.role !== "toolResult" || !expectedResults.has(candidate.toolCallId)) break;
      groupedMessages.push(candidate);
      toolResults.push(candidate as ToolResultMessage);
      expectedResults.delete(candidate.toolCallId);
      const resultEntryId = entryIdsByIndex[candidateIndex];
      if (resultEntryId) entryIds.push(resultEntryId);
      endIndex = candidateIndex;
    }

    groups.push({
      ...(entryId ? { key: entryId } : {}),
      kind,
      protected: !entryId || expectedResults.size > 0,
      startIndex: index,
      endIndex,
      entryIds,
      messages: groupedMessages,
      toolCalls,
      toolResults,
    });
    index = endIndex;
  }

  return groups;
}
