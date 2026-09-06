import { formatMessageIdTag } from "../messages/metadata.ts";
import { getFilePathsFromParameters, isFilePathProtected, isToolNameProtected } from "../protected-patterns.ts";
import type { CompressionBlock, RuntimeState } from "../state/types.ts";
import { messageText } from "../token-utils.ts";
import type {
  BoundaryReference,
  CompressionProtectionOptions,
  CompressionSearchContext,
  CompressionSelection,
} from "./types.ts";

const BLOCK_PLACEHOLDER = /\(b(\d+)\)|\{block_(\d+)\}/gi;
export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]";

export function unwrapCompressedSummary(summary: string): string {
  const withoutHeader = summary.replace(/^\s*\[Compressed conversation section\](?:\r?\n)*/i, "");
  return withoutHeader
    .replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "")
    .replace(/(?:\r?\n)+$/, "");
}

function boundaryBlockId(reference: BoundaryReference): number | undefined {
  return reference.kind === "compressed-block" ? reference.blockId : undefined;
}

export function expandNestedSummaries(
  summary: string,
  selection: CompressionSelection,
  activeBlocks: ReadonlyMap<number, CompressionBlock>,
): { summary: string; consumedBlockIds: number[] } {
  const required = new Set(selection.requiredBlockIds);
  const consumed = new Set<number>();
  const startBoundaryId = boundaryBlockId(selection.startReference);
  const endBoundaryId = boundaryBlockId(selection.endReference);
  const placeholders = [...summary.matchAll(new RegExp(BLOCK_PLACEHOLDER))];

  let cursor = 0;
  let expanded = "";
  for (const placeholder of placeholders) {
    const rawId = placeholder[1] ?? placeholder[2];
    const blockId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
    const block = activeBlocks.get(blockId);
    if (!block || !required.has(blockId) || consumed.has(blockId)) continue;
    expanded += summary.slice(cursor, placeholder.index);
    expanded += unwrapCompressedSummary(block.summary);
    cursor = (placeholder.index ?? 0) + placeholder[0].length;
    consumed.add(blockId);
  }
  expanded += summary.slice(cursor);

  const prependBoundary = startBoundaryId !== undefined && !consumed.has(startBoundaryId)
    ? activeBlocks.get(startBoundaryId)
    : undefined;
  if (prependBoundary) {
    expanded = `${unwrapCompressedSummary(prependBoundary.summary).trim()}\n\n${expanded.trim()}`.trim();
    consumed.add(prependBoundary.blockId);
  }
  const appendBoundary = endBoundaryId !== undefined && !consumed.has(endBoundaryId)
    ? activeBlocks.get(endBoundaryId)
    : undefined;
  if (appendBoundary) {
    expanded = `${expanded.trim()}\n\n${unwrapCompressedSummary(appendBoundary.summary).trim()}`.trim();
    consumed.add(appendBoundary.blockId);
  }

  const strictBoundaryIds = new Set([startBoundaryId, endBoundaryId].filter((id): id is number => id !== undefined));
  const missing = selection.requiredBlockIds.filter((id) => !strictBoundaryIds.has(id) && !consumed.has(id));
  if (missing.length > 0) {
    const sections = missing.map((blockId) => {
      const block = activeBlocks.get(blockId);
      if (!block) throw new Error(`Compressed block not found: b${blockId}`);
      consumed.add(blockId);
      return `\n### (b${blockId})\n${unwrapCompressedSummary(block.summary)}`;
    });
    expanded += "\n\nThe following previously compressed summaries were also part of this conversation section:";
    expanded += sections.join("");
  }

  return { summary: expanded, consumedBlockIds: [...consumed] };
}

function isAlreadyCompressed(context: CompressionSearchContext, key: string): boolean {
  for (const block of context.activeBlocks.values()) {
    if (block.memberKeys.includes(key)) return true;
  }
  return false;
}

function appendProtectedUsers(
  summary: string,
  selection: CompressionSelection,
  context: CompressionSearchContext,
): string {
  const texts: string[] = [];
  for (const group of selection.groups) {
    if (!group.key || isAlreadyCompressed(context, group.key) || group.kind !== "user") continue;
    const message = group.messages[0];
    if (!message) continue;
    const text = messageText(message).trim();
    if (text) texts.push(text);
  }
  if (texts.length === 0) return summary;
  return `${summary}\n\nThe following user messages were sent in this conversation verbatim:${texts.map((text) => `\n${text}`).join("")}`;
}

export function extractProtectedPromptInfo(text: string): string[] {
  const protectedTexts: string[] = [];
  for (const match of text.matchAll(/<protect>([\s\S]*?)<\/protect>/gi)) {
    const protectedText = match[1]?.trim();
    if (protectedText) protectedTexts.push(protectedText);
  }
  return protectedTexts;
}

function appendProtectedTags(
  summary: string,
  selection: CompressionSelection,
  context: CompressionSearchContext,
): string {
  const texts: string[] = [];
  for (const group of selection.groups) {
    if (!group.key || isAlreadyCompressed(context, group.key) || group.kind !== "user") continue;
    for (const message of group.messages) texts.push(...extractProtectedPromptInfo(messageText(message)));
  }
  if (texts.length === 0) return summary;
  return `${summary}\n\nThe following protected prompt information was included in this conversation verbatim:${texts.map((text) => `\n${text}`).join("")}`;
}

function appendProtectedTools(
  summary: string,
  selection: CompressionSelection,
  context: CompressionSearchContext,
  options: CompressionProtectionOptions,
): string {
  const outputs: string[] = [];
  for (const group of selection.groups) {
    if (!group.key || isAlreadyCompressed(context, group.key)) continue;
    const resultByCallId = new Map(group.toolResults.map((result) => [result.toolCallId, result]));
    for (const call of group.toolCalls) {
      const protectedTool = isToolNameProtected(call.name, options.protectedTools)
        || isFilePathProtected(
          getFilePathsFromParameters(call.name, call.arguments),
          options.protectedFilePatterns,
        );
      if (!protectedTool) continue;
      const result = resultByCallId.get(call.id);
      const output = result ? messageText(result).trim() : "";
      if (output) outputs.push(`\n### Tool: ${call.name}\n${output}`);
    }
  }
  if (outputs.length === 0) return summary;
  return `${summary}\n\nThe following protected tools were used in this conversation as well:${outputs.join("")}`;
}

export function prepareSummary(
  rawSummary: string,
  selection: CompressionSelection,
  searchContext: CompressionSearchContext,
  state: RuntimeState,
  options: CompressionProtectionOptions,
): { summary: string; consumedBlockIds: number[] } {
  const nested = expandNestedSummaries(rawSummary, selection, searchContext.activeBlocks);
  let summary = nested.summary;
  if (options.protectUserMessages) summary = appendProtectedUsers(summary, selection, searchContext);
  if (options.protectTags) summary = appendProtectedTags(summary, selection, searchContext);
  summary = appendProtectedTools(summary, selection, searchContext, options);
  return { summary, consumedBlockIds: nested.consumedBlockIds };
}

export function wrapCompressedSummary(blockId: number, summary: string): string {
  const body = summary.trim();
  return `${COMPRESSED_BLOCK_HEADER}${body ? `\n${body}` : ""}\n${formatMessageIdTag(`b${blockId}`).trimStart()}`;
}
