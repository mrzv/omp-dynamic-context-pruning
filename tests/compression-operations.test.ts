import { describe, expect, test } from "bun:test";
import { planDecompress, selectSweepTools } from "../src/compress/operations.ts";
import { applyMutation } from "../src/state/runtime.ts";
import { rebuildToolCache } from "../src/state/tool-cache.ts";
import { compressionContext } from "./fixtures/compression.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";
import type { CompressionBlock } from "../src/state/types.ts";

describe("compression operations", () => {
  test("sweeps since the latest user turn or the last N tools", () => {
    const { groups, state } = compressionContext([
      userMessage("first", 1),
      assistantMessage([toolCall("old", "read", { path: "old.ts" })], 2),
      toolResult("old", "old", 3),
      userMessage("latest", 4),
      assistantMessage([toolCall("recent", "read", { path: "recent.ts" })], 5),
      toolResult("recent", "recent", 6),
      assistantMessage([toolCall("protected", "read", { path: "secrets.txt:1-" })], 7),
      toolResult("protected", "secret", 8),
    ]);
    rebuildToolCache(state, groups);
    const options = { protectedTools: [], protectedFilePatterns: ["**/secrets.txt"] };
    expect(selectSweepTools(state, groups, options, 10).map((record) => record.toolCallId))
      .toEqual(["recent"]);
    expect(selectSweepTools(state, groups, { ...options, lastN: 3 }, 10).map((record) => record.toolCallId))
      .toEqual(["old", "recent"]);

    const recent = selectSweepTools(state, groups, options, 10);
    applyMutation(state, { version: 1, at: 10, kind: "tools-pruned", records: recent });
    expect(selectSweepTools(state, groups, { ...options, lastN: 3 }, 11).map((record) => record.toolCallId))
      .toEqual(["old"]);
  });

  test("returns no since-user sweep without a user message", () => {
    const { groups, state } = compressionContext([
      assistantMessage([{ type: "text", text: "orphan assistant" }], 1),
    ]);
    rebuildToolCache(state, groups);
    expect(selectSweepTools(state, groups, { protectedTools: [], protectedFilePatterns: [] })).toEqual([]);
  });

  test("group decompression marks nested siblings as user-decompressed", () => {
    const { state } = compressionContext([]);
    const block = (
      blockId: number,
      mode: CompressionBlock["mode"],
      runId: number,
      memberKeys: string[],
      consumedBlockIds: number[] = [],
    ): CompressionBlock => ({
      blockId,
      runId,
      mode,
      active: true,
      deactivatedByUser: false,
      topic: `block ${blockId}`,
      startRef: `m${blockId.toString().padStart(4, "0")}`,
      endRef: `m${blockId.toString().padStart(4, "0")}`,
      anchorKey: memberKeys[0] ?? `key-${blockId}`,
      memberKeys,
      directMemberKeys: memberKeys,
      toolCallIds: [],
      includedBlockIds: consumedBlockIds,
      consumedBlockIds,
      summary: `summary ${blockId}`,
      compressedTokens: 10,
      summaryTokens: 2,
      durationMs: 1,
      createdAt: blockId,
    });
    const first = block(1, "message", 1, ["first"]);
    const second = block(2, "message", 1, ["second"]);
    const parent = block(3, "range", 2, ["first"], [1]);
    applyMutation(state, { version: 1, at: 1, kind: "compression-created", blocks: [first, second] });
    applyMutation(state, { version: 1, at: 2, kind: "compression-created", blocks: [parent] });

    applyMutation(state, { version: 1, at: 3, kind: "blocks-activation", changes: planDecompress(state, 2) });
    expect(state.blocks.get(1)).toMatchObject({ active: false, deactivatedByUser: true });
    expect(state.blocks.get(2)).toMatchObject({ active: false, deactivatedByUser: true });

    applyMutation(state, { version: 1, at: 4, kind: "blocks-activation", changes: planDecompress(state, 3) });
    expect(state.blocks.get(1)).toMatchObject({ active: false, deactivatedByUser: true });
  });
});
