import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
  assignStableReferences,
  createMessageReferenceState,
} from "../src/messages/identity.ts";
import {
  buildLogicalMessages,
  cloneLogicalMessagesForProjection,
  omitIncompleteToolGroupsForProjection,
  type LogicalMessage,
} from "../src/messages/logical-messages.ts";
import { injectMessageMetadata, stripDcpMetadata } from "../src/messages/metadata.ts";
import { assertValidToolPairingProjection } from "../src/messages/pairing.ts";
import {
  buildCompressionSearchContext,
  resolveBoundary,
  resolveSelection,
  selectionAnchor,
} from "../src/compress/search.ts";
import { applyCompressedContext } from "../src/compress/transform.ts";
import type { CompressionBlock, CompressionMode, RuntimeState } from "../src/state/types.ts";
import { toolResult, userMessage } from "./fixtures/messages.ts";

function replayMessage() {
  const message = userMessage("Native compaction summary\n<dcp-message-id>m0099</dcp-message-id>", 2);
  message.providerPayload = {
    type: "openaiResponsesHistory",
    items: [{ type: "message", content: "preserved replay" }],
  };
  return message;
}

function emptyState(): RuntimeState {
  return {
    sessionId: null,
    manualMode: false,
    references: createMessageReferenceState(),
    toolCalls: new Map(),
    prunedTools: new Map(),
    blocks: new Map(),
    activeBlockIds: new Set(),
    nudges: { contextLimitAnchors: new Set(), turnAnchors: new Set(), iterationAnchors: new Set() },
    stats: { totalPruneTokens: 0, totalToolsPruned: 0, totalMessagesCompressed: 0 },
    currentTurn: 0,
    nextBlockId: 1,
    nextRunId: 1,
  };
}

function fixture() {
  const replay = replayMessage();
  const source: AgentMessage[] = [
    userMessage("Earlier ordinary user message", 1),
    replay,
    toolResult("replayed-a", "first result", 3),
    toolResult("replayed-b", "second result", 4),
    userMessage("Later ordinary user message", 5),
  ];
  const groups = buildLogicalMessages(source, ["before", "replay", "result-a", "result-b", "after"]);
  const state = emptyState();
  // Simulate a reference persisted before replay messages became protected.
  state.references.byKey.set("replay", "m0099");
  state.references.byRef.set("m0099", "replay");
  assignStableReferences(groups, state.references);
  return { replay, source, groups, state, search: buildCompressionSearchContext(state, groups) };
}

function addBlock(
  state: RuntimeState,
  memberKeys: string[],
  anchorKey: string,
  mode: CompressionMode,
  blockId = 1,
): CompressionBlock {
  const block: CompressionBlock = {
    blockId,
    runId: blockId,
    mode,
    active: true,
    deactivatedByUser: false,
    topic: "replay compression regression",
    startRef: "m0001",
    endRef: "m0099",
    anchorKey,
    memberKeys: [...memberKeys],
    directMemberKeys: [...memberKeys],
    toolCallIds: [],
    includedBlockIds: [],
    consumedBlockIds: [],
    summary: `Summary ${blockId}`,
    compressedTokens: 100,
    summaryTokens: 10,
    durationMs: 0,
    createdAt: 10,
  };
  state.blocks.set(blockId, block);
  state.activeBlockIds.add(blockId);
  return block;
}

function project(groups: LogicalMessage[], state: RuntimeState, mode: CompressionMode): AgentMessage[] {
  const projection = omitIncompleteToolGroupsForProjection(cloneLogicalMessagesForProjection(groups)).groups;
  injectMessageMetadata(projection);
  return applyCompressedContext(projection, state, mode === "message");
}

describe("opaque provider replay compression protection", () => {
  test("protects a keyed replay before reference assignment and retains that protection in clones", () => {
    const { replay, source, groups } = fixture();
    const snapshot = structuredClone(source);
    expect(groups[1]?.kind).toBe("user");
    expect(groups[1]?.protected).toBe(true);
    expect(groups[1]?.ref).toBe(undefined);
    expect(groups[0]?.protected).toBe(false);
    expect(groups[4]?.protected).toBe(false);

    const clones = cloneLogicalMessagesForProjection(groups);
    expect(clones[1]?.protected).toBe(true);
    stripDcpMetadata(clones.flatMap((group) => group.messages));
    injectMessageMetadata(clones);
    expect(clones[1]?.messages[0]).toEqual(replay);
    expect(source).toEqual(snapshot);
  });

  test("keeps ordinary user messages, including undefined replay payloads, compressible", () => {
    const ordinary = userMessage("Compress this normally", 1);
    const groups = buildLogicalMessages([ordinary, { ...ordinary, providerPayload: undefined }], ["a", "b"]);
    const state = emptyState();
    assignStableReferences(groups, state.references);
    const search = buildCompressionSearchContext(state, groups);
    const start = resolveBoundary(search, state, "m0001");
    const end = resolveBoundary(search, state, "m0002");
    expect(resolveSelection(search, start, end).groupKeys).toEqual(["a", "b"]);
  });

  test("rejects direct message selection through a stored replay reference", () => {
    const { search, state } = fixture();
    const boundary = resolveBoundary(search, state, "m0099");
    expect(() => resolveSelection(search, boundary, boundary)).toThrow("no compressible messages");
  });

  for (const [name, startKey, endKey, expectedKeys] of [
    ["ending at a replay", "before", "replay", ["before"]],
    ["spanning a replay and its results", "before", "after", ["before", "after"]],
    ["starting at a replay", "replay", "after", ["after"]],
  ] as const) {
    test(`range selection ${name} preserves the replay/result boundary`, () => {
      const { replay, source, groups, state, search } = fixture();
      const snapshot = structuredClone(source);
      const startRef = state.references.byKey.get(startKey);
      const endRef = state.references.byKey.get(endKey);
      if (!startRef || !endRef) throw new Error("Missing fixture boundary reference.");
      const start = resolveBoundary(search, state, startRef);
      const end = resolveBoundary(search, state, endRef);
      const selection = resolveSelection(search, start, end);
      expect(selection.groupKeys).toEqual([...expectedKeys]);
      addBlock(state, selection.groupKeys, selectionAnchor(start), "range");

      const projected = project(groups, state, "range");
      const replayIndex = projected.findIndex((message) => (
        message.role === "user" && message.providerPayload === replay.providerPayload
      ));
      expect(replayIndex >= 0).toBe(true);
      expect(projected[replayIndex]).toEqual(replay);
      expect(projected.slice(replayIndex + 1, replayIndex + 3).map((message) => message.role)).toEqual([
        "toolResult", "toolResult",
      ]);
      expect(projected.some((message) => message.role === "user" && message.content === "Summary 1")).toBe(true);
      expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
      expect(source).toEqual(snapshot);
    });
  }

  for (const mode of ["message", "range"] as const) {
    for (const [name, memberKeys, anchorKey] of [
      ["a replay alone", ["replay"], "replay"],
      ["a replay inside a larger block", ["before", "replay", "after"], "before"],
    ] as const) {
      test(`ignores a saved ${mode} compression covering ${name} on every projection`, () => {
        const { replay, source, groups, state } = fixture();
        addBlock(state, [...memberKeys], anchorKey, mode);
        const savedState = structuredClone(state);
        const original = structuredClone(source);
        // Ignoring an unsafe block must not insert its summary or hide any of its members.
        const uncompressed = project(groups, emptyState(), mode);
        for (let request = 0; request < 3; request++) {
          const projected = project(groups, state, mode);
          expect(projected).toEqual(uncompressed);
          expect(projected[1]).toEqual(replay);
          expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
        }
        expect(state).toEqual(savedState);
        expect(source).toEqual(original);
      });
    }

    test(`still applies safe ${mode} blocks while ignoring an unsafe block at the same anchor`, () => {
      const { replay, source, groups, state } = fixture();
      addBlock(state, ["before", "replay"], "before", mode, 1);
      addBlock(state, ["before"], "before", mode, 2);
      const projected = project(groups, state, mode);
      expect(projected[0]?.role).toBe("user");
      expect(projected[0]).toMatchObject({ content: "Summary 2" });
      expect(projected[1]).toEqual(replay);
      expect(projected).toHaveLength(5);
      expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
    });
  }

  test("also preserves replay payloads with no detached results, even with an old unprotected group", () => {
    const replay = replayMessage();
    const groups = buildLogicalMessages([replay], ["replay"]);
    const state = emptyState();
    // The projection guard must inspect the payload rather than trust a cached flag.
    if (groups[0]) groups[0].protected = false;
    addBlock(state, ["replay"], "replay", "range");
    expect(applyCompressedContext(groups, state, false)).toEqual([replay]);
  });
});
