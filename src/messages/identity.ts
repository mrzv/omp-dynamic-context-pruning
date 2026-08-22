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

export interface MessageAssociationStats {
  indexedEntries: number;
  fingerprintedMessages: number;
  reset: boolean;
}

export interface MessageAssociationResult {
  entryIds: (string | undefined)[];
  stats: MessageAssociationStats;
}

export class MessageEntryAssociationCache {
  private branchMessages: Array<{ id: string; message: AgentMessage }> = [];
  private fingerprintByMessage = new WeakMap<object, string>();
  private readonly fingerprintByEntryId = new Map<string, string>();

  reset(): void {
    this.branchMessages = [];
    this.fingerprintByMessage = new WeakMap<object, string>();
    this.fingerprintByEntryId.clear();
  }

  fingerprintForEntryId(entryId: string): string | undefined {
    return this.fingerprintByEntryId.get(entryId);
  }

  associate(
    messages: readonly AgentMessage[],
    branch: readonly BranchEntryLike[],
  ): MessageAssociationResult {
    const branchMessages = branch.flatMap((entry) => (
      entry.type === "message" && entry.message ? [{ id: entry.id, message: entry.message }] : []
    ));
    let reset = branchMessages.length < this.branchMessages.length;
    const branchObjects = new WeakSet<object>();
    let fingerprintedMessages = 0;
    const computeFingerprint = (message: AgentMessage): string => {
      fingerprintedMessages += 1;
      return messageFingerprint(message);
    };
    if (!reset) {
      for (let index = 0; index < this.branchMessages.length; index++) {
        const previous = this.branchMessages[index];
        const current = branchMessages[index];
        if (!previous || !current || previous.id !== current.id || previous.message !== current.message) {
          reset = true;
          break;
        }
        branchObjects.add(current.message);
        const currentFingerprint = computeFingerprint(current.message);
        if (this.fingerprintByEntryId.get(current.id) !== currentFingerprint) {
          this.fingerprintByEntryId.set(current.id, currentFingerprint);
          this.fingerprintByMessage.set(current.message, currentFingerprint);
        }
      }
    }
    if (reset) {
      this.reset();
      for (const entry of branchMessages) branchObjects.add(entry.message);
    }

    const fingerprint = (message: AgentMessage): string => {
      const cached = branchObjects.has(message) ? this.fingerprintByMessage.get(message) : undefined;
      if (cached) return cached;
      const computed = computeFingerprint(message);
      this.fingerprintByMessage.set(message, computed);
      return computed;
    };

    let indexedEntries = 0;
    for (let index = this.branchMessages.length; index < branchMessages.length; index++) {
      const entry = branchMessages[index];
      if (!entry) continue;
      branchObjects.add(entry.message);
      const entryFingerprint = computeFingerprint(entry.message);
      this.fingerprintByMessage.set(entry.message, entryFingerprint);
      this.branchMessages.push(entry);
      this.fingerprintByEntryId.set(entry.id, entryFingerprint);
      indexedEntries += 1;
    }

    const entriesByFingerprint = new Map<string, string[]>();
    for (const entry of this.branchMessages) {
      const entryFingerprint = this.fingerprintByEntryId.get(entry.id);
      if (!entryFingerprint) continue;
      const queue = entriesByFingerprint.get(entryFingerprint);
      if (queue) queue.push(entry.id);
      else entriesByFingerprint.set(entryFingerprint, [entry.id]);
    }

    return {
      entryIds: messages.map((message) => entriesByFingerprint.get(fingerprint(message))?.shift()),
      stats: { indexedEntries, fingerprintedMessages, reset },
    };
  }
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
  return new MessageEntryAssociationCache().associate(messages, branch).entryIds;
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
