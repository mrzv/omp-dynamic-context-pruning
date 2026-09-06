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
  entryIds: (string | undefined)[];
  messages: AgentMessage[];
  toolCalls: ToolCall[];
  toolResults: ToolResultMessage[];
}

interface ProjectionSource {
  readonly message: AgentMessage;
  readonly index: number;
}

// Keep occurrence identity outside message objects so it never reaches the provider.
// The index distinguishes even repeated references to the same source object.
const projectionSources = new WeakMap<AgentMessage, ProjectionSource>();

export function getProjectionSource(message: AgentMessage): ProjectionSource | undefined {
  return projectionSources.get(message);
}

export function assistantToolCalls(message: AgentMessage): ToolCall[] {
  if (message.role !== "assistant") return [];
  return (message as AssistantMessage).content.filter(
    (part): part is ToolCall => part.type === "toolCall",
  );
}

/** Native replay payloads are opaque and must not be rewritten or compressed. */
export function hasOpaqueProviderReplay(message: AgentMessage): boolean {
  const value = message as AgentMessage & Record<string, unknown>;
  return value.role === "user" && value.providerPayload !== undefined;
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
function cloneMutableData(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const cloned: unknown[] = [];
    seen.set(value, cloned);
    for (const item of value) cloned.push(cloneMutableData(item, seen));
    return cloned;
  }

  const cloned: Record<string, unknown> = {};
  seen.set(value, cloned);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(cloned, key, {
      value: cloneMutableData(item, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cloned;
}


function cloneMessageForProjection(message: AgentMessage): AgentMessage {
  const source = message as AgentMessage & Record<string, unknown>;
  const cloned = { ...source };
  if (Array.isArray(source.content)) {
    cloned.content = cloneMutableData(source.content);
  }
  if (Array.isArray(source.files)) {
    cloned.files = cloneMutableData(source.files);
  }
  return cloned as unknown as AgentMessage;
}

export function cloneLogicalMessagesForProjection(
  groups: readonly LogicalMessage[],
): LogicalMessage[] {
  return groups.map((group) => {
    const messages = group.messages.map((message, offset) => {
      const cloned = cloneMessageForProjection(message);
      projectionSources.set(cloned, { message, index: group.startIndex + offset });
      return cloned;
    });
    return {
      ...group,
      entryIds: [...group.entryIds],
      messages,
      toolCalls: messages.flatMap(assistantToolCalls),
      toolResults: messages.filter((message): message is ToolResultMessage => message.role === "toolResult"),
    };
  });
}
export interface OmittedIncompleteToolGroup {
  startIndex: number;
  missingToolCallIds: string[];
}

export interface ToolGroupProjectionRepair {
  groups: LogicalMessage[];
  omitted: OmittedIncompleteToolGroup[];
}

export function omitIncompleteToolGroupsForProjection(
  groups: readonly LogicalMessage[],
): ToolGroupProjectionRepair {
  const retained: LogicalMessage[] = [];
  const omitted: OmittedIncompleteToolGroup[] = [];
  const callIdCounts = new Map<string, number>();
  const omittedCallStartIndices = new Map<string, number>();
  for (const group of groups) {
    for (const call of group.toolCalls) {
      callIdCounts.set(call.id, (callIdCounts.get(call.id) ?? 0) + 1);
    }
  }

  for (const group of groups) {
    if (group.kind === "orphan-tool-result") {
      const result = group.toolResults[0];
      const omittedStartIndex = result
        ? omittedCallStartIndices.get(result.toolCallId)
        : undefined;
      if (result && omittedStartIndex !== undefined && omittedStartIndex < group.startIndex) {
        omittedCallStartIndices.delete(result.toolCallId);
        continue;
      }
    }
    if (group.kind !== "assistant" || group.toolCalls.length === 0) {
      retained.push(group);
      continue;
    }

    const callIds = group.toolCalls.map((call) => call.id);
    if (callIds.some((id) => callIdCounts.get(id) !== 1)) {
      retained.push(group);
      continue;
    }

    const resultIds = new Set(group.toolResults.map((result) => result.toolCallId));
    const missingToolCallIds = callIds.filter((id) => !resultIds.has(id));
    if (missingToolCallIds.length === 0) {
      retained.push(group);
      continue;
    }

    omitted.push({ startIndex: group.startIndex, missingToolCallIds });
    for (const id of missingToolCallIds) omittedCallStartIndices.set(id, group.startIndex);
  }

  return { groups: retained, omitted };
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
        protected: kind === "protected"
          || kind === "orphan-tool-result"
          || hasOpaqueProviderReplay(message)
          || !entryId,
        startIndex: index,
        endIndex: index,
        entryIds: [entryId],
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
    const entryIds: (string | undefined)[] = [entryId];
    let endIndex = index;

    while (expectedResults.size > 0 && endIndex + 1 < messages.length) {
      const candidateIndex = endIndex + 1;
      const candidate = messages[candidateIndex];
      if (!candidate || candidate.role !== "toolResult" || !expectedResults.has(candidate.toolCallId)) break;
      groupedMessages.push(candidate);
      toolResults.push(candidate as ToolResultMessage);
      expectedResults.delete(candidate.toolCallId);
      entryIds.push(entryIdsByIndex[candidateIndex]);
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
