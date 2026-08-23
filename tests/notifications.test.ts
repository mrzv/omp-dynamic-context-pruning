import { describe, expect, test } from "bun:test";
import { wrapCompressedSummary } from "../src/compress/summaries.ts";
import { buildLogicalMessages } from "../src/messages/logical-messages.ts";
import {
  capturePruneNotificationItems,
  formatCompressionNotification,
  formatPruneNotification,
  truncateToastNotification,
  type PendingPruneNotification,
} from "../src/notifications.ts";
import { createRuntimeState } from "../src/state/runtime.ts";
import type { CompressionBlock, PrunedToolRecord, ToolCallRecord } from "../src/state/types.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

function toolRecord(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolCallRecord {
  return {
    toolCallId,
    toolName,
    input,
    turn: 1,
    order: 0,
    isError: false,
    nativePruned: false,
    tokenCount: 1,
  };
}

function pruneRecord(
  toolCallId: string,
  reason: PrunedToolRecord["reason"],
  tokenCount: number,
): PrunedToolRecord {
  return { toolCallId, reason, tokenCount, prunedAt: 1 };
}

describe("DCP notification formatting", () => {
  test("describes aggregate pruning by reason and affected tool", () => {
    const records = [
      pruneRecord("read-1", "deduplication", 1_000),
      pruneRecord("bash-1", "deduplication", 500),
      pruneRecord("bash-2", "purge-error", 800),
    ];
    const tools = new Map<string, ToolCallRecord>([
      ["read-1", toolRecord("read-1", "read", { path: "/workspace/src/extension.ts" })],
      ["bash-1", toolRecord("bash-1", "bash", { command: "npm run check" })],
      ["bash-2", toolRecord("bash-2", "bash", { command: "failing command" })],
    ]);
    const pending: PendingPruneNotification = {
      items: capturePruneNotificationItems(records, tools, "/workspace"),
      tokens: 2_300,
    };

    expect(formatPruneNotification(pending, 12_400, "minimal"))
      .toBe("▣ DCP | −12.4k removed total — −2.3k this run, 3 tools");
    expect(formatPruneNotification(pending, 12_400, "detailed")).toBe([
      "▣ DCP | −12.4k removed total",
      "",
      "▣ Duplicate Removal (−1.5k, 2 tools)",
      "→ read: src/extension.ts",
      "→ bash: npm run check",
      "",
      "▣ Error Cleanup (−800, 1 tool)",
      "→ bash: failing command",
    ].join("\n"));
  });

  test("reports compression totals, progress, topic, items, and summary cost", () => {
    const state = createRuntimeState();
    const groups = buildLogicalMessages([
      userMessage("request", 1),
      assistantMessage([toolCall("read-1", "read", { path: "src/a.ts" })], 2),
      toolResult("read-1", "result", 3),
      userMessage("follow-up", 4),
    ]);
    for (let index = 0; index < groups.length; index += 1) groups[index]!.key = `g${index + 1}`;
    const block: CompressionBlock = {
      blockId: 4,
      runId: 3,
      mode: "range",
      active: true,
      deactivatedByUser: false,
      topic: "Earlier notification implementation",
      startRef: "m1",
      endRef: "m3",
      anchorKey: "g3",
      memberKeys: ["g1", "g2"],
      directMemberKeys: ["g1", "g2"],
      toolCallIds: ["read-1", "already-compressed-tool"],
      includedBlockIds: [],
      consumedBlockIds: [],
      summary: wrapCompressedSummary(4, "The earlier implementation aggregated notices."),
      compressedTokens: 82_000,
      summaryTokens: 4_200,
      durationMs: 5,
      createdAt: 1,
    };
    state.blocks.set(block.blockId, block);
    state.activeBlockIds.add(block.blockId);
    state.stats.totalPruneTokens = 278_000;

    const message = formatCompressionNotification(state, [block], groups, "detailed", true);
    expect(message).toContain("▣ DCP | −278k removed, +4.2k summary");
    expect(message).toContain("│");
    expect(message).toContain("▣ Compression #3 −82k removed, +4.2k summary");
    expect(message).toContain("→ Topic: Earlier notification implementation");
    expect(message).toContain("→ Items: 2 messages and 1 tool compressed");
    expect(message).toContain("→ Compression (+4.2k): The earlier implementation aggregated notices.");
    expect(message).not.toContain("[Compressed conversation section]");
    expect(message).not.toContain("dcp-message-id");
    expect(formatCompressionNotification(state, [block], groups, "minimal", false))
      .toBe("▣ DCP | −278k removed, +4.2k summary — Compression #3");
  });

  test("bounds multiline and long toast bodies", () => {
    const message = Array.from({ length: 20 }, (_, index) => `${index}: ${"x".repeat(200)}`).join("\n");
    const truncated = truncateToastNotification(message);
    expect(truncated.split("\n").length).toBeLessThanOrEqual(12);
    expect(truncated.length).toBeLessThanOrEqual(1_200);
    expect(truncated.endsWith("...")).toBe(true);
  });
});
