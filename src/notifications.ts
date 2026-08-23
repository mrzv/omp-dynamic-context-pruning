import { unwrapCompressedSummary } from "./compress/summaries.ts";
import type { LogicalMessage } from "./messages/logical-messages.ts";
import type {
  CompressionBlock,
  PrunedToolRecord,
  PruneReason,
  RuntimeState,
  ToolCallRecord,
} from "./state/types.ts";

const TOAST_BODY_MAX_LINES = 12;
const TOAST_BODY_MAX_CHARS = 1_200;
const TOOL_DETAIL_MAX_CHARS = 60;

const PRUNE_REASON_LABELS: Record<PruneReason, string> = {
  deduplication: "Duplicate Removal",
  "purge-error": "Error Cleanup",
  sweep: "Manual Sweep",
};

export interface PruneNotificationItem {
  toolName: string;
  detail: string;
  reason: PruneReason;
  tokenCount: number;
}

export interface PendingPruneNotification {
  items: PruneNotificationItem[];
  tokens: number;
}

export function emptyPruneNotification(): PendingPruneNotification {
  return { items: [], tokens: 0 };
}

export function formatCompactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  const units = ["", "k", "M", "B", "T"] as const;
  let value = Math.round(tokens);
  let unitIndex = 0;
  while (value >= 1_000 && unitIndex < units.length - 1) {
    value /= 1_000;
    unitIndex += 1;
  }
  const precision = value < 100 ? 10 : 1;
  const rounded = Math.round(value * precision) / precision;
  if (rounded >= 1_000 && unitIndex < units.length - 1) {
    return `1${units[unitIndex + 1]}`;
  }
  return `${rounded}${units[unitIndex]}`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
}

function shortenPath(value: string, workingDirectory: string): string {
  if (value === workingDirectory) return ".";
  const prefix = `${workingDirectory}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function stringValue(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function serializedInput(input: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(input);
    return serialized === "{}" ? "" : serialized;
  } catch {
    return "";
  }
}

function toolDetail(record: ToolCallRecord, workingDirectory: string): string {
  const { input, toolName } = record;
  const path = stringValue(input, "path") ?? stringValue(input, "filePath") ?? stringValue(input, "file");
  let detail = "";

  if (toolName === "grep" || toolName === "glob") {
    const pattern = stringValue(input, "pattern");
    if (pattern) detail = `"${pattern}"${path ? ` in ${shortenPath(path, workingDirectory)}` : ""}`;
  } else if (toolName === "bash") {
    detail = stringValue(input, "command") ?? stringValue(input, "i") ?? "";
  } else if (toolName === "web_search" || toolName === "websearch" || toolName === "codesearch") {
    const query = stringValue(input, "query");
    if (query) detail = `"${query}"`;
  } else if (path) {
    detail = shortenPath(path, workingDirectory);
  } else {
    detail = stringValue(input, "query")
      ?? stringValue(input, "url")
      ?? stringValue(input, "name")
      ?? stringValue(input, "topic")
      ?? stringValue(input, "description")
      ?? stringValue(input, "i")
      ?? serializedInput(input);
  }

  return truncate(detail, TOOL_DETAIL_MAX_CHARS);
}

export function capturePruneNotificationItems(
  records: readonly PrunedToolRecord[],
  toolCalls: ReadonlyMap<string, ToolCallRecord>,
  workingDirectory: string,
): PruneNotificationItem[] {
  return records.map((record) => {
    const toolCall = toolCalls.get(record.toolCallId);
    return {
      toolName: toolCall?.toolName ?? "unknown tool",
      detail: toolCall ? toolDetail(toolCall, workingDirectory) : record.toolCallId,
      reason: record.reason,
      tokenCount: record.tokenCount,
    };
  });
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

export function formatPruneNotification(
  pending: PendingPruneNotification,
  totalRemovedTokens: number,
  detailLevel: "minimal" | "detailed",
): string {
  const totalHeader = `▣ DCP | −${formatCompactTokenCount(totalRemovedTokens)} removed total`;
  if (detailLevel === "minimal") {
    return `${totalHeader} — −${formatCompactTokenCount(pending.tokens)} this run, ${pending.items.length} ${plural(pending.items.length, "tool")}`;
  }

  const lines = [totalHeader];
  const reasons: PruneReason[] = [];
  for (const item of pending.items) {
    if (!reasons.includes(item.reason)) reasons.push(item.reason);
  }
  for (const reason of reasons) {
    const items = pending.items.filter((item) => item.reason === reason);
    const tokens = items.reduce((total, item) => total + item.tokenCount, 0);
    lines.push("", `▣ ${PRUNE_REASON_LABELS[reason]} (−${formatCompactTokenCount(tokens)}, ${items.length} ${plural(items.length, "tool")})`);
    for (const item of items) {
      lines.push(`→ ${item.toolName}${item.detail ? `: ${item.detail}` : ""}`);
    }
  }
  return lines.join("\n");
}

function formatMetrics(removedTokens: number, summaryTokens: number): string {
  const metrics = [`−${formatCompactTokenCount(removedTokens)} removed`];
  if (summaryTokens > 0) metrics.push(`+${formatCompactTokenCount(summaryTokens)} summary`);
  return metrics.join(", ");
}

function compressionLabel(blocks: readonly CompressionBlock[]): string {
  const runIds = [...new Set(blocks.map((block) => block.runId))];
  return runIds.length === 1 ? `Compression #${runIds[0]}` : "Compression";
}

function compressionTopic(blocks: readonly CompressionBlock[]): string {
  const batchTopic = blocks.find((block) => block.batchTopic)?.batchTopic;
  if (batchTopic) return batchTopic;
  const topics = [...new Set(blocks.map((block) => block.topic))];
  return topics.length === 1 ? (topics[0] ?? "(unknown topic)") : "Multiple topics";
}

function compressionSummary(blocks: readonly CompressionBlock[]): string {
  if (blocks.length === 1) return unwrapCompressedSummary(blocks[0]?.summary ?? "");
  return blocks
    .map((block) => `### ${block.topic}\n${unwrapCompressedSummary(block.summary)}`)
    .join("\n\n");
}

function compressionProgressBar(
  groups: readonly LogicalMessage[],
  state: RuntimeState,
  blocks: readonly CompressionBlock[],
  width = 50,
): string | undefined {
  const keys = groups.flatMap((group) => group.key ? [group.key] : []);
  if (keys.length === 0) return undefined;
  const compressed = new Set<string>();
  for (const blockId of state.activeBlockIds) {
    const block = state.blocks.get(blockId);
    if (block) for (const key of block.memberKeys) compressed.add(key);
  }
  const recent = new Set(blocks.flatMap((block) => block.directMemberKeys));
  const cells = new Array<string>(width).fill("█");
  for (let index = 0; index < keys.length; index += 1) {
    const start = Math.floor(index / keys.length * width);
    const end = Math.floor((index + 1) / keys.length * width);
    const cell = recent.has(keys[index] ?? "") ? "⣿" : compressed.has(keys[index] ?? "") ? "░" : "█";
    for (let cellIndex = start; cellIndex < end; cellIndex += 1) cells[cellIndex] = cell;
  }
  return `│${cells.join("")}│`;
}

export function formatCompressionNotification(
  state: RuntimeState,
  blocks: readonly CompressionBlock[],
  groups: readonly LogicalMessage[],
  detailLevel: "minimal" | "detailed",
  showCompression: boolean,
): string {
  const activeSummaryTokens = [...state.activeBlockIds].reduce(
    (total, blockId) => total + (state.blocks.get(blockId)?.summaryTokens ?? 0),
    0,
  );
  const header = `▣ DCP | ${formatMetrics(state.stats.totalPruneTokens, activeSummaryTokens)}`;
  const label = compressionLabel(blocks);
  if (detailLevel === "minimal") return `${header} — ${label}`;

  const removedTokens = blocks.reduce((total, block) => total + block.compressedTokens, 0);
  const summaryTokens = blocks.reduce((total, block) => total + block.summaryTokens, 0);
  const directMemberKeys = new Set(blocks.flatMap((block) => block.directMemberKeys));
  const messageCount = directMemberKeys.size;
  const toolCount = new Set(
    groups
      .filter((group) => group.key !== undefined && directMemberKeys.has(group.key))
      .flatMap((group) => group.toolCalls.map((call) => call.id)),
  ).size;
  const lines = [header];
  const progress = compressionProgressBar(groups, state, blocks);
  if (progress) lines.push("", progress);
  lines.push(`▣ ${label} ${formatMetrics(removedTokens, summaryTokens)}`);
  lines.push(`→ Topic: ${compressionTopic(blocks)}`);
  lines.push(`→ Items: ${messageCount} ${plural(messageCount, "message")}${toolCount > 0 ? ` and ${toolCount} ${plural(toolCount, "tool")}` : ""} compressed`);
  if (showCompression) {
    lines.push(`→ Compression (+${formatCompactTokenCount(summaryTokens)}): ${compressionSummary(blocks)}`);
  }
  return lines.join("\n");
}

export function truncateToastNotification(message: string): string {
  const lines = message.split("\n");
  let truncated = message;
  if (lines.length > TOAST_BODY_MAX_LINES) {
    const kept = lines.slice(0, TOAST_BODY_MAX_LINES - 1);
    const remaining = lines.length - kept.length;
    truncated = `${kept.join("\n")}\n... and ${remaining} more`;
  }
  return truncate(truncated, TOAST_BODY_MAX_CHARS);
}
