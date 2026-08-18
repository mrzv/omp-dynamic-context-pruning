import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";

export function userMessage(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: text, timestamp };
}

export function assistantMessage(
  content: AssistantMessage["content"],
  timestamp = 2,
  responseId = `response-${timestamp}`,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    responseId,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp,
  };
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export function toolResult(
  toolCallId: string,
  text: string,
  timestamp: number,
  isError = false,
  toolName = "read",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp,
  };
}

export function messageEntry(id: string, message: AgentMessage) {
  return { type: "message", id, message } as const;
}
