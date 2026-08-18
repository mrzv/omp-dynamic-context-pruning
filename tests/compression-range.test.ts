import { describe, expect, test } from "bun:test";
import { buildCompressionBlocks } from "../src/compress/apply.ts";
import { planDecompress, planRecompress } from "../src/compress/operations.ts";
import { prepareRangeCompression } from "../src/compress/range.ts";
import { buildCompressionSearchContext } from "../src/compress/search.ts";
import { applyCompressedContext } from "../src/compress/transform.ts";
import type { CompressionProtectionOptions } from "../src/compress/types.ts";
import { assertValidToolPairing } from "../src/messages/pairing.ts";
import { applyMutation } from "../src/state/runtime.ts";
import { compressionContext } from "./fixtures/compression.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

const unprotected: CompressionProtectionOptions = {
  protectUserMessages: false,
  protectTags: false,
  protectedTools: [],
  protectedFilePatterns: [],
};

describe("range compression", () => {
  test("compresses complete logical groups and preserves configured content", () => {
    const messages = [
      userMessage("keep before", 1),
      assistantMessage([{ type: "text", text: "research" }], 2),
      userMessage("request <protect>must retain</protect>", 3),
      assistantMessage([toolCall("read-secret", "read", { path: "secrets.txt:1-" })], 4),
      toolResult("read-secret", "secret output", 5),
      assistantMessage([{ type: "text", text: "keep after" }], 6),
    ];
    const { groups, state, search } = compressionContext(messages);
    const prepared = prepareRangeCompression(
      {
        topic: "closed research",
        content: [{ startId: "m0002", endId: "m0004", summary: "Research completed." }],
      },
      search,
      state,
      {
        protectUserMessages: true,
        protectTags: true,
        protectedTools: [],
        protectedFilePatterns: ["**/secrets.txt"],
      },
    );
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.summary).toContain("request <protect>must retain</protect>");
    expect(prepared[0]?.summary).toContain("must retain");
    expect(prepared[0]?.summary).toContain("### Tool: read\nsecret output");

    const blocks = buildCompressionBlocks(state, prepared, 12, 100);
    applyMutation(state, { version: 1, at: 100, kind: "compression-created", blocks });
    const transformed = applyCompressedContext(groups, state, false);
    expect(transformed).toHaveLength(3);
    expect(transformed[0]).toEqual(messages[0]);
    expect(transformed[1]).toMatchObject({
      role: "user",
      synthetic: true,
      attribution: "agent",
    });
    const summaryMessage = transformed[1];
    if (!summaryMessage || summaryMessage.role !== "user" || typeof summaryMessage.content !== "string") {
      throw new Error("Expected a synthetic text user message.");
    }
    expect(summaryMessage.content).toContain("<dcp-message-id>b1</dcp-message-id>");
    expect(transformed[2]).toEqual(messages[5]);
    expect(() => assertValidToolPairing(transformed)).not.toThrow();
  });

  test("rejects overlapping batches before state mutation", () => {
    const { state, search } = compressionContext([
      userMessage("one", 1),
      assistantMessage([{ type: "text", text: "two" }], 2),
      userMessage("three", 3),
    ]);
    expect(() => prepareRangeCompression(
      {
        topic: "overlap",
        content: [
          { startId: "m0001", endId: "m0002", summary: "first" },
          { startId: "m0002", endId: "m0003", summary: "second" },
        ],
      },
      search,
      state,
      unprotected,
    )).toThrow("overlaps");
    expect(state.blocks.size).toBe(0);
  });

  test("nests summaries and restores child blocks on decompress", () => {
    const { groups, state, search } = compressionContext([
      userMessage("one", 1),
      assistantMessage([{ type: "text", text: "two" }], 2),
      userMessage("three", 3),
      assistantMessage([{ type: "text", text: "four" }], 4),
    ]);
    const firstPrepared = prepareRangeCompression(
      { topic: "first", content: [{ startId: "m0001", endId: "m0002", summary: "First summary." }] },
      search,
      state,
      unprotected,
    );
    const firstBlocks = buildCompressionBlocks(state, firstPrepared, 0, 10);
    applyMutation(state, { version: 1, at: 10, kind: "compression-created", blocks: firstBlocks });

    const nestedSearch = buildCompressionSearchContext(state, groups);
    const fallbackPrepared = prepareRangeCompression(
      { topic: "fallback", content: [{ startId: "m0001", endId: "m0003", summary: "No placeholder." }] },
      nestedSearch,
      state,
      unprotected,
    );
    expect(fallbackPrepared[0]?.summary).toContain(
      "The following previously compressed summaries were also part of this conversation section:",
    );
    expect(fallbackPrepared[0]?.summary).toContain("First summary.");
    expect(fallbackPrepared[0]?.consumedBlockIds).toEqual([1]);
    const nestedPrepared = prepareRangeCompression(
      { topic: "second", content: [{ startId: "b1", endId: "m0003", summary: "Earlier: (b1) Then three." }] },
      nestedSearch,
      state,
      unprotected,
    );
    expect(nestedPrepared[0]?.consumedBlockIds).toEqual([1]);
    expect(nestedPrepared[0]?.summary).toContain("First summary.");
    expect(nestedPrepared[0]?.summary).not.toContain("(b1)");
    const secondBlocks = buildCompressionBlocks(state, nestedPrepared, 0, 20);
    applyMutation(state, { version: 1, at: 20, kind: "compression-created", blocks: secondBlocks });
    expect(state.blocks.get(1)?.active).toBe(false);
    expect(state.blocks.get(2)?.active).toBe(true);
    expect(state.stats.totalMessagesCompressed).toBe(3);
    const compressedTokenTotal = state.stats.totalPruneTokens;
    const parentTokens = state.blocks.get(2)?.compressedTokens ?? 0;

    const decompressed = planDecompress(state, 2);
    applyMutation(state, { version: 1, at: 30, kind: "blocks-activation", changes: decompressed });
    expect(state.blocks.get(2)).toMatchObject({ active: false, deactivatedByUser: true });
    expect(state.blocks.get(1)).toMatchObject({ active: true, deactivatedByUser: false });
    expect(state.stats.totalPruneTokens).toBe(compressedTokenTotal - parentTokens);
    expect(applyCompressedContext(groups, state, false)).toHaveLength(3);

    const recompressed = planRecompress(state, 2);
    applyMutation(state, { version: 1, at: 40, kind: "blocks-activation", changes: recompressed });
    expect(state.blocks.get(1)?.active).toBe(false);
    expect(state.blocks.get(2)).toMatchObject({ active: true, deactivatedByUser: false });
    expect(state.stats.totalPruneTokens).toBe(compressedTokenTotal);
    expect(applyCompressedContext(groups, state, false)).toHaveLength(2);
  });
});
