import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { effectiveActiveBlocks } from "../src/compress/active-blocks.ts";
import { buildCompressionBlocks } from "../src/compress/apply.ts";
import { prepareMessageCompression } from "../src/compress/message.ts";
import { buildPriorityMap } from "../src/compress/priority.ts";
import { prepareRangeCompression } from "../src/compress/range.ts";
import { buildCompressionSearchContext, resolveBoundary } from "../src/compress/search.ts";
import { applyCompressedContext } from "../src/compress/transform.ts";
import type { CompressionProtectionOptions } from "../src/compress/types.ts";
import { assignStableReferences } from "../src/messages/identity.ts";
import {
  buildLogicalMessages, cloneLogicalMessagesForProjection, hasOpaqueProviderReplay,
  omitIncompleteToolGroupsForProjection, type LogicalMessage,
} from "../src/messages/logical-messages.ts";
import { injectMessageMetadata, stripDcpMetadata } from "../src/messages/metadata.ts";
import { assertValidToolPairingProjection } from "../src/messages/pairing.ts";
import { applyMutation, createRuntimeState } from "../src/state/runtime.ts";
import type { CompressionBlock, RuntimeState } from "../src/state/types.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

const protection: CompressionProtectionOptions = {
  protectUserMessages: false, protectTags: false, protectedTools: [], protectedFilePatterns: [],
};
const replayRoles = ["user", "developer", "compactionSummary"] as const;
type ReplayRole = typeof replayRoles[number];

function replay(role: ReplayRole = "compactionSummary", timestamp = 2): AgentMessage {
  const providerPayload = {
    type: "openaiResponsesHistory" as const,
    provider: "openai",
    items: [{ type: "function_call", call_id: "call_x", id: "fc_x", name: "read", arguments: "{}" }],
  };
  const summary = "Native summary\n<dcp-message-id>m0099</dcp-message-id>";
  return role === "compactionSummary"
    ? { role, summary, tokensBefore: 10_000, timestamp, providerPayload }
    : { role, content: summary, timestamp, providerPayload };
}

function project(groups: LogicalMessage[], state = createRuntimeState()): AgentMessage[] {
  const projection = omitIncompleteToolGroupsForProjection(cloneLogicalMessagesForProjection(groups)).groups;
  stripDcpMetadata(projection.flatMap((group) => group.messages));
  injectMessageMetadata(projection);
  return applyCompressedContext(projection, state, false);
}

function oldBlock(memberKeys = ["before", "replay"], anchorKey = "before", blockId = 1): CompressionBlock {
  return {
    blockId, runId: blockId, mode: "range", active: true, deactivatedByUser: false,
    topic: "legacy", startRef: "m0001", endRef: "m0099", anchorKey,
    memberKeys, directMemberKeys: [...memberKeys], toolCallIds: [],
    consumedBlockIds: [], includedBlockIds: [], summary: "Unsafe legacy summary",
    compressedTokens: 100, summaryTokens: 10, createdAt: 1, durationMs: 0,
  };
}

function fixture(role: ReplayRole = "compactionSummary") {
  const source: AgentMessage[] = [
    userMessage("Earlier ordinary user <protect>keep this fact</protect>", 1),
    replay(role), toolResult("call_x|fc_x", "real output", 3),
    userMessage("Later ordinary user", 4),
  ];
  const groups = buildLogicalMessages(source, ["before", "replay", "result", "after"]);
  const state = createRuntimeState();
  state.references.byKey.set("replay", "m0099");
  state.references.byRef.set("m0099", "replay");
  assignStableReferences(groups, state.references);
  const block = oldBlock();
  applyMutation(state, { version: 1, at: 1, kind: "compression-created", blocks: [block] });
  return { source, groups, state, block };
}

function messagePlan(groups: LogicalMessage[], state: RuntimeState) {
  return prepareMessageCompression({ topic: "new", content: [
    { messageId: "m0001", topic: "before", summary: "New summary" },
  ] }, buildCompressionSearchContext(state, groups), state, protection);
}

function rangePlan(groups: LogicalMessage[], state: RuntimeState, options = protection) {
  return prepareRangeCompression({ topic: "new", content: [
    { startId: "m0001", endId: "m0002", summary: "New summary" },
  ] }, buildCompressionSearchContext(state, groups), state, options);
}

describe("replay preservation across the whole projection", () => {
  for (const role of replayRoles) {
    test(`accepts the retained ${role} replay and its real result before LLM conversion`, () => {
      const source = [replay(role), toolResult("call_x|fc_x", "real output", 3)];
      const original = structuredClone(source);
      const groups = buildLogicalMessages(source, ["replay", "result"]);
      const state = createRuntimeState();
      assignStableReferences(groups, state.references);
      expect(hasOpaqueProviderReplay(source[0]!)).toBe(true);
      expect(groups[0]?.protected).toBe(true);
      expect(groups[0]?.ref).toBe(undefined);
      const projected = project(groups);
      expect(projected[0]).toEqual(source[0]);
      expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
      expect(source).toEqual(original);
    });

    test(`detects deletion of a result-free ${role} replay`, () => {
      const source = [replay(role)];
      expect(() => assertValidToolPairingProjection(source, [])).toThrow("provider replay history");
    });

    test(`detects removal of a ${role} replay payload even without pairing issues`, () => {
      const source = [replay(role)];
      const projected = project(buildLogicalMessages(source));
      delete (projected[0] as AgentMessage & Record<string, unknown>).providerPayload;
      expect(() => assertValidToolPairingProjection(source, projected)).toThrow("modified-provider-replay");
    });

    test(`detects ${role} replay text rewritten without discarding its payload`, () => {
      const source = [replay(role)];
      const projected = project(buildLogicalMessages(source));
      const changed = projected[0] as AgentMessage & Record<string, unknown>;
      if (role === "compactionSummary") changed.summary = "rewritten";
      else changed.content = "rewritten";
      expect(() => assertValidToolPairingProjection(source, projected)).toThrow("modified-provider-replay");
    });
  }

  test("rejects ordinary summaries with orphan results and no payload", () => {
    const message = { role: "compactionSummary", summary: "plain summary", tokensBefore: 1, timestamp: 1 } as const;
    const source = [message, toolResult("x", "orphan", 2)];
    expect(() => assertValidToolPairingProjection(source, project(buildLogicalMessages(source)))).toThrow("orphan-result");
  });

  test("rejects reordered and duplicated result-free replay occurrences", () => {
    const source = [replay("user", 1), replay("compactionSummary", 2)];
    const projected = project(buildLogicalMessages(source));
    expect(() => assertValidToolPairingProjection(source, [...projected].reverse())).toThrow("provider replay history");
    expect(() => assertValidToolPairingProjection(source, [...projected, projected[0]!])).toThrow("provider replay history");
  });

  test("does not accept an equal-looking untracked replacement replay", () => {
    const source = [replay()];
    expect(() => assertValidToolPairingProjection(source, structuredClone(source))).toThrow("provider replay history");
  });

  test("allows repeated cloning without losing native replay occurrence provenance", () => {
    const source = [replay(), toolResult("call_x|fc_x", "output", 3)];
    const twice = cloneLogicalMessagesForProjection(cloneLogicalMessagesForProjection(buildLogicalMessages(source)));
    expect(() => assertValidToolPairingProjection(source, twice.flatMap((group) => group.messages))).not.toThrow();
  });

  test("continues rejecting a detached duplicate after an omitted incomplete batch", () => {
    const source = [
      replay(), assistantMessage([toolCall("missing", "read")], 3), userMessage("interruption", 4),
      toolResult("missing", "first", 5), toolResult("missing", "duplicate", 6),
    ];
    expect(() => assertValidToolPairingProjection(source, project(buildLogicalMessages(source)))).toThrow("orphan-result:missing");
  });
});

describe("effective compression state after restoring unsafe blocks", () => {
  for (const role of replayRoles) {
    test(`can message-compress a visible ordinary message next to a restored ${role} replay`, () => {
      const { source, groups, state } = fixture(role);
      const original = structuredClone(state);
      expect(effectiveActiveBlocks(state, groups).size).toBe(0);
      const planned = messagePlan(groups, state);
      expect(planned.issues).toEqual([]);
      expect(planned.prepared).toHaveLength(1);
      const blocks = buildCompressionBlocks(state, planned.prepared, 0, 10);
      expect(blocks[0]?.directMemberKeys).toEqual(["before"]);
      expect(blocks[0]?.compressedTokens).toBe(planned.prepared[0]?.selection.tokensByKey.get("before"));
      expect(state).toEqual(original);
      applyMutation(state, { version: 1, at: 10, kind: "compression-created", blocks });
      const projected = project(groups, state);
      expect(JSON.stringify(projected)).toContain("New summary");
      expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
    });

    test(`a new range cannot inherit unsafe ${role} coverage or its old summary`, () => {
      const { source, groups, state } = fixture(role);
      const plans = rangePlan(groups, state);
      expect(plans[0]?.selection.groupKeys).toEqual(["before", "after"]);
      expect(plans[0]?.selection.requiredBlockIds).toEqual([]);
      expect(plans[0]?.consumedBlockIds).toEqual([]);
      expect(plans[0]?.summary).not.toContain("Unsafe legacy summary");
      const blocks = buildCompressionBlocks(state, plans, 0, 10);
      expect(blocks[0]?.memberKeys).toEqual(["before", "after"]);
      expect(blocks[0]?.directMemberKeys).toEqual(["before", "after"]);
      applyMutation(state, { version: 1, at: 10, kind: "compression-created", blocks });
      for (let request = 0; request < 3; request++) {
        const projected = project(groups, state);
        expect(projected).toHaveLength(3);
        expect(JSON.stringify(projected[0])).toContain("New summary");
        expect(projected[1]).toEqual(source[1]);
        expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
      }
      const search = buildCompressionSearchContext(state, groups);
      expect([...search.activeBlocks.keys()]).toEqual([2]);
    });
  }

  test("unsafe saved block IDs are not available as compression boundaries", () => {
    const { state, groups } = fixture();
    const search = buildCompressionSearchContext(state, groups);
    expect(() => resolveBoundary(search, state, "b1")).toThrow("not available");
  });

  test("priority tags describe visible messages rather than ignored coverage", () => {
    const { state, groups } = fixture();
    expect([...buildPriorityMap(groups, state, true, false).keys()]).toEqual(["before", "after"]);
  });

  test("verbatim user and protect-tag preservation does not use unsafe coverage", () => {
    const { state, groups } = fixture();
    const plans = rangePlan(groups, state, { ...protection, protectUserMessages: true, protectTags: true });
    expect(plans[0]?.summary).toContain("Earlier ordinary user");
    expect(plans[0]?.summary).toContain("Later ordinary user");
    expect(plans[0]?.summary).toContain("keep this fact");
  });

  test("nests only an applicable safe block while an unsafe block shares its anchor", () => {
    const { source, state, groups } = fixture();
    const first = buildCompressionBlocks(state, messagePlan(groups, state).prepared, 0, 10);
    applyMutation(state, { version: 1, at: 10, kind: "compression-created", blocks: first });
    const plans = rangePlan(groups, state);
    expect(plans[0]?.consumedBlockIds).toEqual([2]);
    expect(plans[0]?.summary).not.toContain("Unsafe legacy summary");
    const blocks = buildCompressionBlocks(state, plans, 0, 11);
    expect(blocks[0]?.directMemberKeys).toEqual(["after"]);
    expect(blocks[0]?.memberKeys).not.toContain("replay");
    applyMutation(state, { version: 1, at: 11, kind: "compression-created", blocks });
    expect(() => assertValidToolPairingProjection(source, project(groups, state))).not.toThrow();
  });

  test("block building rejects a consumed block excluded by the selection snapshot", () => {
    const { state, groups } = fixture();
    const plans = rangePlan(groups, state);
    plans[0]!.consumedBlockIds.push(1);
    expect(() => buildCompressionBlocks(state, plans)).toThrow("not applicable");
  });

  test("projection, search, and priorities leave raw saved state and input messages unchanged", () => {
    const { source, state, groups } = fixture();
    const saved = structuredClone(state);
    const original = structuredClone(source);
    for (let request = 0; request < 3; request++) {
      project(groups, state);
      messagePlan(groups, state);
      rangePlan(groups, state);
      buildPriorityMap(groups, state, true, false);
    }
    expect(state).toEqual(saved);
    expect(source).toEqual(original);
  });
});
