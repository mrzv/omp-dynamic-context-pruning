import * as anthropicTokenizer from "@anthropic-ai/tokenizer";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

const tokenizer = anthropicTokenizer as typeof anthropicTokenizer & {
  default?: typeof anthropicTokenizer;
};
const anthropicCountTokens = tokenizer.countTokens ?? tokenizer.default?.countTokens;

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return anthropicCountTokens ? anthropicCountTokens(text) : Math.ceil(text.length / 4);
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      chunks.push(value.text);
    } else if (value.type === "thinking" && typeof value.thinking === "string") {
      chunks.push(value.thinking);
    } else if (value.type === "toolCall") {
      if (typeof value.name === "string") chunks.push(value.name);
      if (value.arguments !== undefined) {
        const serialized = JSON.stringify(value.arguments);
        if (serialized) chunks.push(serialized);
      }
    }
  }
  return chunks.join("\n");
}

export function messageText(message: AgentMessage): string {
  const value = message as AgentMessage & Record<string, unknown>;
  if (value.role === "bashExecution") {
    return [
      typeof value.command === "string" ? value.command : "",
      typeof value.output === "string" ? value.output : "",
    ].filter(Boolean).join("\n");
  }
  if (value.role === "pythonExecution") {
    return [
      typeof value.code === "string" ? value.code : "",
      typeof value.output === "string" ? value.output : "",
    ].filter(Boolean).join("\n");
  }
  if (value.role === "fileMention" && Array.isArray(value.files)) {
    const chunks: string[] = [];
    for (const file of value.files) {
      if (!file || typeof file !== "object") continue;
      const record = file as Record<string, unknown>;
      if (typeof record.path === "string") chunks.push(record.path);
      if (typeof record.content === "string") chunks.push(record.content);
    }
    return chunks.join("\n");
  }

  const direct = contentText(value.content);
  if (direct) return direct;
  if (typeof value.summary === "string") return value.summary;
  if (typeof value.output === "string") return value.output;
  return "";
}

export function countMessageTokens(message: AgentMessage): number {
  return countTokens(messageText(message));
}

export function countMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += countMessageTokens(message);
  return total;
}
