import { parseMessageReference } from "../messages/identity.ts";
import type { RuntimeState } from "../state/types.ts";
import { prepareSummary } from "./summaries.ts";
import { resolveBoundary, resolveSelection, selectionAnchor } from "./search.ts";
import type {
  CompressMessageArgs,
  CompressionProtectionOptions,
  CompressionSearchContext,
  MessageCompressionResult,
  PreparedCompression,
} from "./types.ts";

export function validateMessageArgs(args: CompressMessageArgs): void {
  if (typeof args.topic !== "string" || !args.topic.trim()) throw new Error("topic must be a non-empty string");
  if (!Array.isArray(args.content) || args.content.length === 0) {
    throw new Error("content must be a non-empty array");
  }
  for (let index = 0; index < args.content.length; index++) {
    const entry = args.content[index];
    if (!entry || typeof entry.messageId !== "string" || !entry.messageId.trim()) {
      throw new Error(`content[${index}].messageId must be a non-empty string`);
    }
    if (typeof entry.topic !== "string" || !entry.topic.trim()) {
      throw new Error(`content[${index}].topic must be a non-empty string`);
    }
    if (typeof entry.summary !== "string" || !entry.summary.trim()) {
      throw new Error(`content[${index}].summary must be a non-empty string`);
    }
  }
}

function isCovered(state: RuntimeState, key: string): boolean {
  for (const blockId of state.activeBlockIds) {
    if (state.blocks.get(blockId)?.memberKeys.includes(key)) return true;
  }
  return false;
}

export function prepareMessageCompression(
  args: CompressMessageArgs,
  searchContext: CompressionSearchContext,
  state: RuntimeState,
  protection: CompressionProtectionOptions,
): MessageCompressionResult {
  validateMessageArgs(args);
  const prepared: PreparedCompression[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const entry of args.content) {
    const messageId = entry.messageId.trim().toLowerCase();
    if (seen.has(messageId)) {
      issues.push(`messageId ${messageId} was selected more than once.`);
      continue;
    }
    seen.add(messageId);
    if (messageId === "blocked") {
      issues.push("messageId BLOCKED refers to a protected message.");
      continue;
    }
    if (parseMessageReference(messageId) === undefined) {
      const detail = /^b[1-9]\d*$/.test(messageId)
        ? "block IDs are not allowed in message mode"
        : "expected an injected mNNNN message ID";
      issues.push(`messageId ${messageId}: ${detail}.`);
      continue;
    }

    try {
      const boundary = resolveBoundary(searchContext, state, messageId);
      const selection = resolveSelection(searchContext, boundary, boundary);
      const group = selection.groups[0];
      if (!group?.key || group.ref !== messageId) throw new Error("message is not compressible");
      if (isCovered(state, group.key)) throw new Error("message is already part of an active compression");
      if (protection.protectUserMessages && group.kind === "user") {
        throw new Error("protected user messages cannot be compressed in message mode");
      }
      const summary = prepareSummary(entry.summary, selection, searchContext, state, protection);
      prepared.push({
        topic: entry.topic.trim(),
        batchTopic: args.topic.trim(),
        mode: "message",
        startRef: messageId,
        endRef: messageId,
        summary: summary.summary,
        consumedBlockIds: summary.consumedBlockIds,
        selection,
        anchorKey: selectionAnchor(boundary),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push(`messageId ${messageId}: ${detail}.`);
    }
  }
  return { prepared, issues };
}
