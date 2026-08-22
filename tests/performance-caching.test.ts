import { describe, expect, test } from "bun:test";
import { assignStableReferences, createMessageReferenceState, MessageEntryAssociationCache } from "../src/messages/identity.ts";
import { buildLogicalMessages, cloneLogicalMessagesForProjection } from "../src/messages/logical-messages.ts";
import { injectMessageMetadata } from "../src/messages/metadata.ts";
import { createRuntimeState } from "../src/state/runtime.ts";
import { rebuildToolCache, ToolRecordCache } from "../src/state/tool-cache.ts";
import { assistantMessage, messageEntry, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

describe("context projection performance caches", () => {
  test("indexes appended entries and detects in-place branch rewrites", () => {
    const messages = [
      userMessage("request", 1),
      assistantMessage([toolCall("read-1", "read", { path: "a.ts" })], 2),
      toolResult("read-1", "result", 3),
    ];
    const branch = messages.map((message, index) => messageEntry(`entry-${index + 1}`, message));
    const cache = new MessageEntryAssociationCache();

    const first = cache.associate(messages, branch);
    expect(first.entryIds).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(first.stats).toEqual({ indexedEntries: 3, fingerprintedMessages: 3, reset: false });

    const second = cache.associate(messages, branch);
    expect(second.entryIds).toEqual(first.entryIds);
    expect(second.stats).toEqual({ indexedEntries: 0, fingerprintedMessages: 3, reset: false });

    const appended = userMessage("next", 4);
    messages.push(appended);
    branch.push(messageEntry("entry-4", appended));
    const third = cache.associate(messages, branch);
    expect(third.entryIds).toEqual(["entry-1", "entry-2", "entry-3", "entry-4"]);
    expect(third.stats).toEqual({ indexedEntries: 1, fingerprintedMessages: 4, reset: false });

    const previousFingerprint = cache.fingerprintForEntryId("entry-1");
    messages[0]!.content = "rewritten request";
    const rewritten = cache.associate(messages, branch);
    expect(rewritten.entryIds).toEqual(["entry-1", "entry-2", "entry-3", "entry-4"]);
    expect(rewritten.stats).toEqual({ indexedEntries: 0, fingerprintedMessages: 4, reset: false });
    expect(cache.fingerprintForEntryId("entry-1")).not.toBe(previousFingerprint);
  });

  test("reuses tokenized tool records until an entry fingerprint changes", () => {
    const messages = [
      assistantMessage([toolCall("read-1", "read", { path: "a.ts" })], 1),
      toolResult("read-1", "large result", 2),
    ];
    const groups = buildLogicalMessages(messages, ["assistant-entry", "result-entry"]);
    const state = createRuntimeState();
    const cache = new ToolRecordCache();
    const fingerprints = new Map([
      ["assistant-entry", "assistant-v1"],
      ["result-entry", "result-v1"],
    ]);

    expect(rebuildToolCache(state, groups, cache, (entryId) => fingerprints.get(entryId)))
      .toEqual({ hits: 0, misses: 1 });
    const cachedInput = state.toolCalls.get("read-1")?.input;
    expect(rebuildToolCache(state, groups, cache, (entryId) => fingerprints.get(entryId)))
      .toEqual({ hits: 1, misses: 0 });
    expect(state.toolCalls.get("read-1")?.input).toBe(cachedInput);

    fingerprints.set("result-entry", "result-v2");
    expect(rebuildToolCache(state, groups, cache, (entryId) => fingerprints.get(entryId)))
      .toEqual({ hits: 0, misses: 1 });
  });

  test("keeps entry IDs aligned when only a tool result is associated", () => {
    const call = toolCall("read-1", "read", { path: "a.ts" });
    const messages = [
      assistantMessage([call], 1),
      toolResult("read-1", "result", 2),
    ];
    const groups = buildLogicalMessages(messages, [undefined, "result-entry"]);
    const state = createRuntimeState();
    const cache = new ToolRecordCache();

    expect(groups[0]?.entryIds).toEqual([undefined, "result-entry"]);
    expect(rebuildToolCache(state, groups, cache, () => "result-v1"))
      .toEqual({ hits: 0, misses: 1 });

    call.arguments.path = "b.ts";
    expect(rebuildToolCache(state, groups, cache, () => "result-v1"))
      .toEqual({ hits: 0, misses: 1 });
    expect(state.toolCalls.get("read-1")?.input).toEqual({ path: "b.ts" });
  });

  test("refreshes mutable tool flags on token-cache hits", () => {
    const result = toolResult("read-1", "result", 2);
    const messages = [
      assistantMessage([toolCall("read-1", "read", { path: "a.ts" })], 1),
      result,
    ];
    const groups = buildLogicalMessages(messages, ["assistant-entry", "result-entry"]);
    const state = createRuntimeState();
    const cache = new ToolRecordCache();
    const fingerprint = (entryId: string) => `${entryId}-v1`;

    expect(rebuildToolCache(state, groups, cache, fingerprint))
      .toEqual({ hits: 0, misses: 1 });
    expect(state.toolCalls.get("read-1")).toMatchObject({ isError: false, nativePruned: false });

    result.isError = true;
    (result as typeof result & { useless?: boolean }).useless = true;
    expect(rebuildToolCache(state, groups, cache, fingerprint))
      .toEqual({ hits: 1, misses: 0 });
    expect(state.toolCalls.get("read-1")).toMatchObject({ isError: true, nativePruned: true });
  });

  test("adds projection metadata without mutating cached logical messages", () => {
    const original = userMessage("keep this raw", 1);
    const groups = buildLogicalMessages([original], ["entry-1"]);
    assignStableReferences(groups, createMessageReferenceState());
    const projection = cloneLogicalMessagesForProjection(groups);

    injectMessageMetadata(projection);

    expect(JSON.stringify(projection)).toContain("dcp-message-id");
    expect(JSON.stringify(groups)).not.toContain("dcp-message-id");
    expect(original.content).toBe("keep this raw");
  });

  test("isolates nested projection content from cached logical messages", () => {
    const call = toolCall("read-1", "read", { path: "a.ts", options: { encoding: "utf8" } });
    const groups = buildLogicalMessages([
      assistantMessage([call], 1),
      toolResult("read-1", "result", 2),
    ]);
    const projection = cloneLogicalMessagesForProjection(groups);
    const projectedCall = projection[0]?.toolCalls[0];
    if (!projectedCall) throw new Error("Expected projected tool call");
    const projectedOptions = projectedCall.arguments.options;
    if (!projectedOptions || typeof projectedOptions !== "object" || !("encoding" in projectedOptions)) {
      throw new Error("Expected projected tool options");
    }
    projectedCall.arguments.path = "b.ts";
    projectedOptions.encoding = "ascii";

    expect(call.arguments).toEqual({ path: "a.ts", options: { encoding: "utf8" } });
    expect(groups[0]?.toolCalls[0]?.arguments).toEqual(call.arguments);
  });

  test("preserves own __proto__ keys in projected tool arguments", () => {
    const argumentsWithPrototypeKey = JSON.parse(
      '{"__proto__":{"polluted":true},"path":"a.ts"}',
    ) as Record<string, unknown>;
    const call = toolCall("read-1", "read", argumentsWithPrototypeKey);
    const groups = buildLogicalMessages([assistantMessage([call], 1)]);
    const projection = cloneLogicalMessagesForProjection(groups);
    const projectedArguments = projection[0]?.toolCalls[0]?.arguments;
    if (!projectedArguments) throw new Error("Expected projected tool arguments");

    expect(Object.hasOwn(projectedArguments, "__proto__")).toBe(true);
    expect(projectedArguments.__proto__).toEqual({ polluted: true });
    expect(JSON.stringify(projectedArguments)).toContain('"__proto__"');
    expect(Object.getPrototypeOf(projectedArguments)).toBe(Object.prototype);
  });
});
