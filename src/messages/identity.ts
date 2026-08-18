import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { messageText } from "../token-utils.ts";
import type { LogicalMessage } from "./logical-messages.ts";

const MESSAGE_REF_PATTERN = /^m(\d{4})$/;
export const MAX_MESSAGE_REFERENCE = 9999;

export interface BranchEntryLike {
  type: string;
  id: string;
  message?: AgentMessage;
}

export interface MessageReferenceState {
  byKey: Map<string, string>;
  byRef: Map<string, string>;
  nextRef: number;
}

export function createMessageReferenceState(): MessageReferenceState {
  return {
    byKey: new Map(),
    byRef: new Map(),
    nextRef: 1,
  };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function messageFingerprint(message: AgentMessage): string {
  const value = message as AgentMessage & Record<string, unknown>;
  const timestamp = typeof value.timestamp === "number" ? value.timestamp : 0;
  let identity = "";
  if (message.role === "toolResult") {
    identity = `${message.toolCallId}:${message.toolName}`;
  } else if (message.role === "assistant") {
    const responseId = typeof value.responseId === "string" ? value.responseId : "";
    const toolIds = message.content
      .filter((part) => part.type === "toolCall")
      .map((part) => part.id)
      .join(",");
    identity = `${responseId}:${toolIds}`;
  } else if (typeof value.customType === "string") {
    identity = value.customType;
  }
  return `${message.role}|${timestamp}|${identity}|${hashText(messageText(message))}`;
}

export function associateEntryIds(
  messages: readonly AgentMessage[],
  branch: readonly BranchEntryLike[],
): (string | undefined)[] {
  const entriesByFingerprint = new Map<string, string[]>();
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message) continue;
    const fingerprint = messageFingerprint(entry.message);
    const queue = entriesByFingerprint.get(fingerprint);
    if (queue) queue.push(entry.id);
    else entriesByFingerprint.set(fingerprint, [entry.id]);
  }

  return messages.map((message) => {
    const queue = entriesByFingerprint.get(messageFingerprint(message));
    return queue?.shift();
  });
}

export function formatMessageReference(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_MESSAGE_REFERENCE) {
    throw new Error(`Message reference index must be between 1 and ${MAX_MESSAGE_REFERENCE}.`);
  }
  return `m${index.toString().padStart(4, "0")}`;
}

export function parseMessageReference(reference: string): number | undefined {
  const match = MESSAGE_REF_PATTERN.exec(reference.trim().toLowerCase());
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return value >= 1 && value <= MAX_MESSAGE_REFERENCE ? value : undefined;
}

export function assignStableReferences(
  groups: readonly LogicalMessage[],
  state: MessageReferenceState,
): number {
  let assigned = 0;
  for (const group of groups) {
    if (group.protected || !group.key) continue;
    const existing = state.byKey.get(group.key);
    if (existing) {
      group.ref = existing;
      state.byRef.set(existing, group.key);
      continue;
    }

    while (state.nextRef <= MAX_MESSAGE_REFERENCE && state.byRef.has(formatMessageReference(state.nextRef))) {
      state.nextRef += 1;
    }
    if (state.nextRef > MAX_MESSAGE_REFERENCE) {
      throw new Error(`DCP cannot assign more than ${MAX_MESSAGE_REFERENCE} message references.`);
    }

    const reference = formatMessageReference(state.nextRef);
    state.nextRef += 1;
    state.byKey.set(group.key, reference);
    state.byRef.set(reference, group.key);
    group.ref = reference;
    assigned += 1;
  }
  return assigned;
}
