import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { assignStableReferences } from "../src/messages/identity.ts";
import { buildLogicalMessages, cloneLogicalMessagesForProjection } from "../src/messages/logical-messages.ts";
import { assertValidToolPairingProjection } from "../src/messages/pairing.ts";
import { buildCompressionBlocks } from "../src/compress/apply.ts";
import { prepareMessageCompression } from "../src/compress/message.ts";
import { listCompressionTargets, planDecompress, planRecompress } from "../src/compress/operations.ts";
import { prepareRangeCompression } from "../src/compress/range.ts";
import { planReplayBlockInvalidation, replayUnsafeBlockIds } from "../src/compress/replay-protection.ts";
import { buildCompressionSearchContext, resolveBoundary } from "../src/compress/search.ts";
import { applyCompressedContext } from "../src/compress/transform.ts";
import { DCP_STATE_ENTRY, isPersistedMutation, restoreStateFromBranch } from "../src/state/persistence.ts";
import { applyMutation, createRuntimeState } from "../src/state/runtime.ts";
import type { CompressionBlock, PersistedMutation, RuntimeState } from "../src/state/types.ts";
import { toolResult, userMessage } from "./fixtures/messages.ts";

const protection = { protectUserMessages: false, protectTags: false, protectedTools: [], protectedFilePatterns: [] };

function block(id: number, keys: string[], overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId: id, runId: id, mode: "range", active: true, deactivatedByUser: false,
    topic: "saved block", startRef: "m0001", endRef: "m0099", anchorKey: keys[0] ?? "before",
    memberKeys: [...keys], directMemberKeys: [...keys], toolCallIds: [],
    includedBlockIds: [], consumedBlockIds: [], summary: `Saved summary ${id}`,
    compressedTokens: 100, summaryTokens: 10, durationMs: 0, createdAt: 1,
    ...overrides,
  };
}

function add(state: RuntimeState, ...blocks: CompressionBlock[]): PersistedMutation {
  const mutation: PersistedMutation = { version: 1, at: 1, kind: "compression-created", blocks };
  applyMutation(state, mutation);
  return mutation;
}

function fixture() {
  const replay = userMessage("Native replay", 2);
  replay.providerPayload = { type: "openaiResponsesHistory", items: [] };
  const source = [
    userMessage("Keep <protect>this detail</protect> from the earlier user.", 1),
    replay,
    toolResult("replayed", "Result", 3),
    userMessage("Later user message", 4),
  ];
  const groups = buildLogicalMessages(source, ["before", "replay", "result", "after"]);
  const state = createRuntimeState();
  assignStableReferences(groups, state.references);
  const creation = add(state, block(1, ["before", "replay"]));
  return { source, groups, state, creation };
}

function invalidate(state: RuntimeState, ids: number[]): PersistedMutation {
  const mutation: PersistedMutation = { version: 1, at: 2, kind: "replay-blocks-invalidated", blockIds: ids };
  applyMutation(state, mutation);
  return mutation;
}

describe("replay block recovery", () => {
  test("reconciles coverage and accounting once, without changing source messages", () => {
    const { state, groups, source } = fixture();
    const original = structuredClone(source);
    assert.deepEqual(planReplayBlockInvalidation(state, groups), [1]);
    const mutation = invalidate(state, [1]);
    assert.equal(state.blocks.get(1)?.invalidatedByReplay, true);
    assert.equal(state.blocks.get(1)?.active, false);
    assert.equal(state.blocks.get(1)?.deactivatedByUser, false);
    assert.equal(state.activeBlockIds.size, 0);
    assert.equal(state.stats.totalPruneTokens, 0);
    for (let request = 0; request < 3; request++) {
      assert.deepEqual(planReplayBlockInvalidation(state, groups), []);
      applyMutation(state, mutation);
      assert.equal(state.stats.totalPruneTokens, 0);
      assert.deepEqual(applyCompressedContext(groups, state, false), source);
    }
    assert.deepEqual(source, original);
  });

  for (const mode of ["message", "range"] as const) {
    test(`new ${mode} compression works after recovery and does not inherit an unsafe block`, () => {
      const { state, groups, source } = fixture();
      invalidate(state, planReplayBlockInvalidation(state, groups));
      const search = buildCompressionSearchContext(state, groups);
      assert.equal(search.activeBlocks.has(1), false);
      assert.throws(() => resolveBoundary(search, state, "b1"), /not available/);
      const prepared = mode === "message"
        ? prepareMessageCompression({ topic: "new", content: [
          { messageId: "m0001", topic: "before", summary: "New summary" },
        ] }, search, state, protection).prepared
        : prepareRangeCompression({ topic: "new", content: [
          { startId: "m0001", endId: "m0002", summary: "New summary" },
        ] }, search, state, { ...protection, protectUserMessages: true });
      assert.equal(prepared.length, 1);
      const created = buildCompressionBlocks(state, prepared);
      const next = created[0];
      assert.ok(next);
      assert.ok(next.compressedTokens > 0);
      assert.equal(next.memberKeys.includes("replay"), false);
      assert.deepEqual(next.consumedBlockIds, []);
      if (mode === "range") assert.ok(next.summary.includes("this detail"));
      add(state, ...created);
      const projected = applyCompressedContext(cloneLogicalMessagesForProjection(groups), state, mode === "message");
      assert.notDeepEqual(projected, source);
      assert.ok(projected.some((message) => message.role === "user" && String(message.content).includes("New summary")));
      assert.doesNotThrow(() => assertValidToolPairingProjection(source, projected));
    });
  }

  test("search also excludes unsafe blocks before the recovery mutation is persisted", () => {
    const { state, groups } = fixture();
    const search = buildCompressionSearchContext(state, groups);
    const result = prepareMessageCompression({ topic: "new", content: [
      { messageId: "m0001", topic: "before", summary: "New summary" },
    ] }, search, state, protection);
    assert.equal(result.prepared.length, 1);
    assert.deepEqual(result.issues, []);
    const range = prepareRangeCompression({ topic: "new", content: [
      { startId: "m0001", endId: "m0002", summary: "New summary" },
    ] }, search, state, { ...protection, protectTags: true });
    assert.deepEqual(range[0]?.consumedBlockIds, []);
    assert.ok(range[0]?.summary.includes("this detail"));
  });

  test("journal restore preserves quarantine and rejects later reactivation or consumption", () => {
    const { state, groups, creation } = fixture();
    const recovery = invalidate(state, planReplayBlockInvalidation(state, groups));
    assert.equal(isPersistedMutation(recovery), true);
    const entries = [creation, recovery].map((data) => ({ type: "custom", customType: DCP_STATE_ENTRY, data }));
    const restored = restoreStateFromBranch(JSON.parse(JSON.stringify(entries)));
    assert.equal(restored.blocks.get(1)?.invalidatedByReplay, true);
    assert.equal(restored.stats.totalPruneTokens, 0);
    assert.throws(() => planRecompress(restored, 1), /invalidated/);
    assert.deepEqual(listCompressionTargets(restored, true), []);
    assert.deepEqual(listCompressionTargets(restored, false), []);
    applyMutation(restored, { version: 1, at: 3, kind: "blocks-activation", changes: [
      { blockId: 1, active: true, deactivatedByUser: false },
    ] });
    assert.equal(restored.activeBlockIds.has(1), false);
    add(restored, block(2, ["before"], { consumedBlockIds: [1] }));
    assert.equal(restored.blocks.has(2), false);
  });

  test("quarantines already user-decompressed blocks without subtracting tokens twice", () => {
    const { state, groups } = fixture();
    applyMutation(state, { version: 1, at: 2, kind: "blocks-activation", changes: planDecompress(state, 1) });
    assert.equal(state.stats.totalPruneTokens, 0);
    invalidate(state, planReplayBlockInvalidation(state, groups));
    assert.equal(state.stats.totalPruneTokens, 0);
    assert.throws(() => planRecompress(state, 1), /invalidated/);
  });

  test("restores tokens for a user-decompressed child still represented by an active parent", () => {
    const { state, groups } = fixture();
    const first = state.blocks.get(1);
    assert.ok(first);
    first.mode = "message";
    add(state, block(2, ["after"], { mode: "message", runId: 1, compressedTokens: 40 }));
    add(state, block(3, ["before", "replay"], {
      directMemberKeys: [], consumedBlockIds: [1], includedBlockIds: [1], compressedTokens: 0,
    }));
    applyMutation(state, { version: 1, at: 3, kind: "blocks-activation", changes: planDecompress(state, 2) });
    assert.equal(state.blocks.get(1)?.deactivatedByUser, true);
    assert.equal(state.blocks.get(3)?.active, true);
    assert.equal(state.stats.totalPruneTokens, 100);
    invalidate(state, planReplayBlockInvalidation(state, groups));
    assert.equal(state.stats.totalPruneTokens, 0);
    assert.equal(state.activeBlockIds.size, 0);
  });

  test("invalidates nested consumers and restores the entire subtree's token accounting", () => {
    const { state, groups } = fixture();
    add(state, block(2, ["after"], { compressedTokens: 40 }));
    add(state, block(3, ["before", "replay", "after"], {
      directMemberKeys: [], consumedBlockIds: [1, 2], includedBlockIds: [1, 2], compressedTokens: 0,
    }));
    add(state, block(4, ["unrelated"], { compressedTokens: 25 }));
    assert.equal(state.stats.totalPruneTokens, 165);
    assert.deepEqual(planReplayBlockInvalidation(state, groups), [1, 3]);
    // The mutation itself expands ancestors too: old journals may contain only a seed.
    invalidate(state, [1]);
    assert.equal(state.blocks.get(3)?.invalidatedByReplay, true);
    assert.deepEqual([...state.activeBlockIds], [4]);
    assert.equal(state.stats.totalPruneTokens, 25);
    assert.equal(state.blocks.get(2)?.invalidatedByReplay, undefined);
    assert.equal(state.blocks.get(2)?.active, false);
    assert.throws(() => planRecompress(state, 3), /invalidated/);
  });

  test("safe siblings in a message-mode run still decompress and recompress", () => {
    const { state, groups } = fixture();
    const unsafe = state.blocks.get(1);
    assert.ok(unsafe);
    unsafe.mode = "message";
    add(state, block(2, ["after"], { mode: "message", runId: 1, compressedTokens: 25 }));
    invalidate(state, planReplayBlockInvalidation(state, groups));
    assert.deepEqual(listCompressionTargets(state, true).map((target) => target.blocks.map((entry) => entry.blockId)), [[2]]);
    applyMutation(state, { version: 1, at: 3, kind: "blocks-activation", changes: planDecompress(state, 2) });
    assert.deepEqual(listCompressionTargets(state, false).map((target) => target.blocks.map((entry) => entry.blockId)), [[2]]);
    applyMutation(state, { version: 1, at: 4, kind: "blocks-activation", changes: planRecompress(state, 2) });
    assert.deepEqual([...state.activeBlockIds], [2]);
    assert.equal(state.blocks.get(1)?.invalidatedByReplay, true);
  });

  test("quarantine remains effective when its original replay is absent from a later context", () => {
    const { state, groups } = fixture();
    invalidate(state, [1]);
    const withoutReplay = groups.filter((group) => group.key === "before" || group.key === "after");
    assert.equal(replayUnsafeBlockIds(state, withoutReplay).has(1), true);
    assert.deepEqual(planReplayBlockInvalidation(state, withoutReplay), []);
    assert.equal(buildCompressionSearchContext(state, withoutReplay).activeBlocks.size, 0);
  });

  test("invalid mutation IDs cannot partially quarantine a valid block", () => {
    const { state } = fixture();
    invalidate(state, [1, 999]);
    assert.equal(state.blocks.get(1)?.active, true);
    assert.equal(state.blocks.get(1)?.invalidatedByReplay, undefined);
    assert.equal(isPersistedMutation({ version: 1, at: 1, kind: "replay-blocks-invalidated", blockIds: [-1] }), false);
  });
});
