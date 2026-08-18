import { describe, expect, test } from "bun:test";
import { buildCompressionBlocks } from "../src/compress/apply.ts";
import { prepareMessageCompression } from "../src/compress/message.ts";
import { buildPriorityMap, classifyMessagePriority, priorityTags } from "../src/compress/priority.ts";
import { applyCompressedContext } from "../src/compress/transform.ts";
import type { CompressionProtectionOptions } from "../src/compress/types.ts";
import { applyMutation } from "../src/state/runtime.ts";
import { compressionContext } from "./fixtures/compression.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

const protection: CompressionProtectionOptions = {
  protectUserMessages: true,
  protectTags: true,
  protectedTools: [],
  protectedFilePatterns: [],
};

describe("message compression", () => {
  test("partially applies valid entries and reports invalid selections", () => {
    const { groups, state, search } = compressionContext([
      userMessage("protected user", 1),
      assistantMessage([{ type: "text", text: "assistant answer" }], 2),
    ]);
    const result = prepareMessageCompression(
      {
        topic: "batch",
        content: [
          { messageId: "m0001", topic: "user", summary: "user summary" },
          { messageId: "m0002", topic: "answer", summary: "answer summary" },
          { messageId: "m0002", topic: "duplicate", summary: "duplicate" },
          { messageId: "b1", topic: "block", summary: "block" },
          { messageId: "BLOCKED", topic: "blocked", summary: "blocked" },
        ],
      },
      search,
      state,
      protection,
    );
    expect(result.prepared).toHaveLength(1);
    expect(result.prepared[0]).toMatchObject({ topic: "answer", batchTopic: "batch", startRef: "m0002" });
    expect(result.issues).toHaveLength(4);
    expect(result.issues.join("\n")).toContain("protected user messages");
    expect(result.issues.join("\n")).toContain("selected more than once");
    expect(result.issues.join("\n")).toContain("block IDs are not allowed");
    expect(result.issues.join("\n")).toContain("BLOCKED");

    const priorities = buildPriorityMap(groups, state, true, true);
    expect(priorities.has("entry-1")).toBe(false);
    expect(priorities.get("entry-2")).toMatchObject({ ref: "m0002", priority: "low" });
    expect(priorityTags(priorities).get("entry-2")).toBe("low");

    const blocks = buildCompressionBlocks(state, result.prepared, 0, 10);
    applyMutation(state, { version: 1, at: 10, kind: "compression-created", blocks });
    expect(buildPriorityMap(groups, state, true, true).has("entry-2")).toBe(false);
    const transformed = applyCompressedContext(groups, state, true);
    expect(transformed).toHaveLength(2);
    const summary = transformed[1];
    if (!summary || summary.role !== "user" || typeof summary.content !== "string") {
      throw new Error("Expected a synthetic text summary.");
    }
    expect(summary.content).toContain("<dcp-message-id>BLOCKED</dcp-message-id>");
  });

  test("classifies token priorities at DCP thresholds", () => {
    expect(classifyMessagePriority(499)).toBe("low");
    expect(classifyMessagePriority(500)).toBe("medium");
    expect(classifyMessagePriority(4_999)).toBe("medium");
    expect(classifyMessagePriority(5_000)).toBe("high");
  });

  test("does not compress provider-native tool history", () => {
    const call = toolCall("computer", "computer", { action: "click" });
    call.providerMetadata = { type: "computer" } as never;
    const result = toolResult("computer", "screenshot", 3, false, "computer");
    result.providerMetadata = { type: "computer" } as never;
    const { state, search } = compressionContext([
      userMessage("use computer", 1),
      assistantMessage([call], 2),
      result,
    ]);
    const compressed = prepareMessageCompression(
      { topic: "native", content: [{ messageId: "m0002", topic: "native", summary: "summary" }] },
      search,
      state,
      { ...protection, protectUserMessages: false },
    );
    expect(compressed.prepared).toEqual([]);
    expect(compressed.issues[0]).toContain("no compressible messages");
  });
});
