import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildLogicalMessages, cloneLogicalMessagesForProjection } from "../src/messages/logical-messages.ts";
import { injectMessageMetadata, stripDcpMetadata } from "../src/messages/metadata.ts";
import { assertValidToolPairingProjection } from "../src/messages/pairing.ts";
import { toolResult, userMessage } from "./fixtures/messages.ts";

function nativeSummary(): AgentMessage {
  return {
    role: "compactionSummary", summary: "Native summary <dcp-message-id>m0099</dcp-message-id>",
    tokensBefore: 10_000, timestamp: 1,
    providerPayload: { type: "openaiResponsesHistory", items: [] },
  };
}

function project(source: AgentMessage[]): AgentMessage[] {
  const groups = cloneLogicalMessagesForProjection(buildLogicalMessages(source));
  stripDcpMetadata(groups.flatMap((group) => group.messages));
  injectMessageMetadata(groups);
  return groups.flatMap((group) => group.messages);
}

describe("opaque replay preservation", () => {
  for (const role of ["user", "developer", "compactionSummary"] as const) {
    test(`accepts and preserves a ${role} replay boundary before LLM conversion`, () => {
      const replay = role === "compactionSummary" ? nativeSummary() : {
        ...userMessage("Replay <dcp-message-id>m0099</dcp-message-id>", 1),
        role, providerPayload: { type: "openaiResponsesHistory" as const, items: [] },
      };
      const source = [replay, toolResult("replayed", "Output", 2)];
      const snapshot = structuredClone(source);
      const projected = project(source);
      assert.deepEqual(projected[0], replay);
      assert.doesNotThrow(() => assertValidToolPairingProjection(source, projected));
      assert.deepEqual(source, snapshot);
    });
  }

  for (const scenario of ["removed", "payload deleted", "payload replaced", "duplicated"] as const) {
    test(`rejects ${scenario} opaque history even without visible tool results`, () => {
      const source = [nativeSummary()];
      const projected = project(source);
      const replay = projected[0] as AgentMessage & Record<string, unknown>;
      if (scenario === "removed") projected.splice(0, 1);
      else if (scenario === "payload deleted") delete replay.providerPayload;
      else if (scenario === "payload replaced") replay.providerPayload = { type: "openaiResponsesHistory", items: [] };
      else projected.push(replay);
      assert.throws(() => assertValidToolPairingProjection(source, projected), /provider-replay/);
    });
  }

  test("a separate ordinary nudge does not change or invalidate replay-only history", () => {
    const source = [nativeSummary()];
    const projected = project(source);
    projected.push(userMessage("Please compress older ordinary messages.", 2));
    assert.doesNotThrow(() => assertValidToolPairingProjection(source, projected));
  });

  test("does not authorize orphan results after a native summary with no replay payload", () => {
    const source = [
      { role: "compactionSummary", summary: "Plain textual summary", tokensBefore: 100, timestamp: 1 } as const,
      toolResult("orphan", "Bad output", 2),
    ];
    assert.throws(() => assertValidToolPairingProjection(source, project(source)), /orphan-result/);
  });
});
