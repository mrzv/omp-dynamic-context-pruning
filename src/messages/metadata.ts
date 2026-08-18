import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { LogicalMessage } from "./logical-messages.ts";

const DCP_TAG_NAME = String.raw`dcp(?:[-_:][A-Za-z0-9_.:-]+)?`;
const DCP_PAIRED_TAG = new RegExp(
  `<(${DCP_TAG_NAME})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`,
  "gi",
);
const DCP_UNPAIRED_TAG = new RegExp(`<\\/?${DCP_TAG_NAME}(?:\\s[^>]*)?\\s*\\/?>`, "gi");
const HALLUCINATED_PARAMETER_SUFFIX = /(?<=\n)m\d+<\/parameter>\s*$/i;
const DCP_BLOCK_ID_TAG = /(<dcp-message-id(?=[\s>])[^>]*>)b\d+(<\/dcp-message-id>)/gi;

export type MessagePriority = "low" | "medium" | "high";

export function stripDcpMetadataFromText(text: string): string {
  return text
    .replace(HALLUCINATED_PARAMETER_SUFFIX, "")
    .replace(DCP_PAIRED_TAG, "")
    .replace(DCP_UNPAIRED_TAG, "");
}

function stripContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      const stripped = stripDcpMetadataFromText(value.text);
      if (stripped !== value.text) {
        value.text = stripped;
        changed = true;
      }
    }
  }
  return changed;
}

function invalidateNativeReplay(value: Record<string, unknown>): void {
  delete value.providerPayload;
}

export function stripDcpMetadata(messages: readonly AgentMessage[]): void {
  for (const message of messages) {
    const value = message as AgentMessage & Record<string, unknown>;
    let changed = false;
    if (typeof value.content === "string") {
      const stripped = stripDcpMetadataFromText(value.content);
      if (stripped !== value.content) {
        value.content = stripped;
        changed = true;
      }
    } else {
      changed = stripContent(value.content);
    }
    if ((value.role === "bashExecution" || value.role === "pythonExecution") && typeof value.output === "string") {
      const stripped = stripDcpMetadataFromText(value.output);
      if (stripped !== value.output) {
        value.output = stripped;
        changed = true;
      }
    }
    if (value.role === "fileMention" && Array.isArray(value.files)) {
      for (const file of value.files) {
        if (!file || typeof file !== "object") continue;
        const record = file as Record<string, unknown>;
        if (typeof record.content !== "string") continue;
        const stripped = stripDcpMetadataFromText(record.content);
        if (stripped !== record.content) {
          record.content = stripped;
          changed = true;
        }
      }
    }
    if (changed) invalidateNativeReplay(value);
  }
}

export function formatMessageIdTag(reference: string, priority?: MessagePriority): string {
  const attribute = priority ? ` priority="${priority}"` : "";
  return `\n<dcp-message-id${attribute}>${reference}</dcp-message-id>`;
}

function appendToContent(message: AgentMessage, suffix: string): boolean {
  const value = message as AgentMessage & Record<string, unknown>;
  if (typeof value.content === "string") {
    value.content = `${value.content}${suffix}`;
    invalidateNativeReplay(value);
    return true;
  }
  if (!Array.isArray(value.content)) return false;

  for (let index = value.content.length - 1; index >= 0; index--) {
    const part = value.content[index];
    if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
      const record = part as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text : "";
      record.text = `${text}${suffix}`;
      invalidateNativeReplay(value);
      return true;
    }
  }

  (value.content as TextContent[]).push({ type: "text", text: suffix.trimStart() });
  invalidateNativeReplay(value);
  return true;
}

function appendToExecution(message: AgentMessage, suffix: string): boolean {
  const value = message as AgentMessage & Record<string, unknown>;
  if (value.role === "bashExecution" || value.role === "pythonExecution") {
    const output = typeof value.output === "string" ? value.output : "";
    value.output = `${output}${suffix}`;
    return true;
  }
  if (value.role === "fileMention" && Array.isArray(value.files)) {
    const lastFile = value.files[value.files.length - 1];
    if (lastFile && typeof lastFile === "object") {
      const record = lastFile as Record<string, unknown>;
      const content = typeof record.content === "string" ? record.content : "";
      record.content = `${content}${suffix}`;
      return true;
    }
  }
  return false;
}

function appendToToolResult(message: ToolResultMessage, suffix: string): void {
  if (!appendToContent(message, suffix)) {
    message.content.push({ type: "text", text: suffix.trimStart() });
  }
}

export function injectMessageMetadata(
  groups: readonly LogicalMessage[],
  priorities?: ReadonlyMap<string, MessagePriority>,
  blockedKeys?: ReadonlySet<string>,
): void {
  for (const group of groups) {
    const blocked = !group.ref || (group.key ? blockedKeys?.has(group.key) === true : true);
    if (blocked && group.kind === "protected") continue;
    if (group.kind === "assistant" && group.protected && group.toolCalls.length > group.toolResults.length) {
      continue;
    }
    const reference = blocked ? "BLOCKED" : group.ref;
    if (!reference) continue;
    const priority = !blocked && group.key ? priorities?.get(group.key) : undefined;
    const tag = formatMessageIdTag(reference, priority);

    if (group.toolResults.length > 0) {
      for (const result of group.toolResults) appendToToolResult(result, tag);
      continue;
    }

    const message = group.messages[0];
    if (!message) continue;
    if (!appendToContent(message, tag)) appendToExecution(message, tag);
  }
}

export function replaceBlockIdsWithBlocked(text: string): string {
  return text.replace(DCP_BLOCK_ID_TAG, "$1BLOCKED$2");
}
