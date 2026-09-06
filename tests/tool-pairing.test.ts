import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
  buildLogicalMessages,
  cloneLogicalMessagesForProjection,
  omitIncompleteToolGroupsForProjection,
} from "../src/messages/logical-messages.ts";
import {
  assertValidToolPairing,
  assertValidToolPairingProjection,
  findToolPairingIssues,
} from "../src/messages/pairing.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

function replayMessage(timestamp = 1) {
  const message = userMessage("Native compaction summary", timestamp);
  message.providerPayload = {
    type: "openaiResponsesHistory",
    items: [{ type: "message", content: "preserved replay" }],
  };
  return message;
}

function project(messages: readonly AgentMessage[]): AgentMessage[] {
  return cloneLogicalMessagesForProjection(buildLogicalMessages(messages))
    .flatMap((group) => group.messages);
}

describe("tool pairing invariants", () => {
  test("accepts complete parallel tool batches", () => {
    const messages = [
      assistantMessage([toolCall("a", "read"), toolCall("b", "read")], 1),
      toolResult("a", "a", 2),
      toolResult("b", "b", 3),
    ];
    expect(findToolPairingIssues(messages)).toEqual([]);
    expect(() => assertValidToolPairing(messages)).not.toThrow();
  });

  test("reports orphaned and missing results", () => {
    const messages = [
      assistantMessage([toolCall("expected", "read")], 1),
      toolResult("orphan", "bad", 2),
    ];
    expect(findToolPairingIssues(messages)).toEqual([
      { kind: "orphan-result", toolCallId: "orphan", messageIndex: 1 },
      { kind: "missing-result", toolCallId: "expected", messageIndex: 0 },
    ]);
    expect(() => assertValidToolPairing(messages)).toThrow("invalid tool history");
  });

  test("permits only provider-replayed orphan results already present in the source", () => {
    const replayedResult = toolResult("provider-replayed", "preserved output", 2);
    const source = [replayMessage(), replayedResult];
    const projected = project(source);

    expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
    expect(() => assertValidToolPairingProjection(
      [assistantMessage([toolCall("provider-replayed", "read")], 1), replayedResult],
      projected,
    )).toThrow("orphan-result:provider-replayed@1");
    expect(() => assertValidToolPairingProjection(
      source,
      [replayedResult, replayedResult],
    )).toThrow("duplicate-result:provider-replayed@1");
  });

  test("rejects results before or outside their assistant batch", () => {
    const beforeCall = [
      toolResult("late-call", "result", 1),
      assistantMessage([toolCall("late-call", "read")], 2),
    ];
    expect(findToolPairingIssues(beforeCall).map((issue) => issue.kind)).toEqual([
      "orphan-result",
      "missing-result",
    ]);

    const separated = [
      assistantMessage([toolCall("separated", "read")], 1),
      { role: "user", content: "new turn", timestamp: 2 } as const,
      toolResult("separated", "result", 3),
    ];
    expect(findToolPairingIssues(separated).map((issue) => issue.kind)).toEqual([
      "missing-result",
      "orphan-result",
    ]);
  });

  test("can allow an active dangling frontier explicitly", () => {
    const messages = [assistantMessage([toolCall("running", "read")], 1)];
    expect(findToolPairingIssues(messages, true)).toEqual([]);
  });
});


describe("provider replay projection validation", () => {
  test("rejects ordinary source orphans, including after a plain user message", () => {
    const result = toolResult("orphan", "invalid output", 2);
    for (const source of [[result], [userMessage("ordinary turn"), result]]) {
      expect(() => assertValidToolPairingProjection(source, source)).toThrow("orphan-result:orphan");
      expect(() => assertValidToolPairingProjection(source, project(source))).toThrow("orphan-result:orphan");
    }
  });

  test("does not treat absent, null, or primitive payloads as opaque replay", () => {
    for (const payload of [undefined, null, false, 0, "not a replay", []]) {
      const boundary = userMessage("not a replay boundary");
      Reflect.set(boundary, "providerPayload", payload);
      const source = [boundary, toolResult("orphan", "invalid output", 2)];
      expect(() => assertValidToolPairingProjection(source, project(source))).toThrow("orphan-result:orphan@1");
    }
  });

  test("does not allow orphans before a replay boundary", () => {
    const source = [toolResult("orphan", "invalid output", 1), replayMessage(2)];
    expect(() => assertValidToolPairingProjection(source, project(source))).toThrow("orphan-result:orphan@0");
  });

  test("ends a replay boundary at any intervening non-result message", () => {
    const interruptions: AgentMessage[] = [
      userMessage("new turn", 2),
      assistantMessage([{ type: "text", text: "new assistant turn" }], 2),
      { role: "developer", content: "interruption", timestamp: 2 },
    ];
    for (const interruption of interruptions) {
      const source = [replayMessage(), interruption, toolResult("orphan", "invalid output", 3)];
      const projected = project(source);
      expect(() => assertValidToolPairingProjection(source, projected)).toThrow("orphan-result:orphan@2");
      // Removing the interruption must not retroactively authorize the source orphan.
      expect(() => assertValidToolPairingProjection(
        source,
        projected.slice(0, 1).concat(projected.slice(2)),
      )).toThrow("orphan-result:orphan@1");
    }
  });

  test("requires an opaque user replay rather than an assistant payload", () => {
    const assistant = assistantMessage([{ type: "text", text: "ordinary assistant" }], 1);
    Reflect.set(assistant, "providerPayload", replayMessage().providerPayload);
    const source = [assistant, toolResult("orphan", "invalid output", 2)];
    expect(() => assertValidToolPairingProjection(source, project(source))).toThrow("orphan-result:orphan@1");
  });

  test("does not authorize an orphan using a replay added only by projection", () => {
    const source = [toolResult("orphan", "invalid output", 2)];
    const projected = [replayMessage(), ...project(source)];
    expect(() => assertValidToolPairingProjection(source, projected)).toThrow("orphan-result:orphan@1");
  });

  test("rejects a newly orphaned visible result even next to a retained replay", () => {
    const source = [
      replayMessage(),
      assistantMessage([toolCall("visible", "read")], 2),
      toolResult("visible", "output", 3),
    ];
    const projected = project(source);
    expect(() => assertValidToolPairingProjection(
      source,
      projected.slice(0, 1).concat(projected.slice(2)),
    )).toThrow("orphan-result:visible@1");
  });

  test("requires the original replay boundary to remain in the projection", () => {
    const source = [replayMessage(), toolResult("replayed", "output", 2)];
    const projected = project(source);
    expect(() => assertValidToolPairingProjection(source, projected.slice(1))).toThrow("orphan-result:replayed@0");
    expect(() => assertValidToolPairingProjection(
      source,
      [replayMessage(), ...projected.slice(1)],
    )).toThrow("orphan-result:replayed@1");
  });

  test("rejects replay results when the retained boundary payload is removed or replaced", () => {
    const source = [replayMessage(), toolResult("replayed", "output", 2)];
    for (const payload of [undefined, null, replayMessage().providerPayload]) {
      const projected = project(source);
      const boundary = projected[0];
      if (!boundary) throw new Error("Missing replay boundary.");
      Reflect.set(boundary, "providerPayload", payload);
      expect(() => assertValidToolPairingProjection(source, projected)).toThrow("orphan-result:replayed@1");
    }
  });

  test("does not transfer an allowance to a different retained replay boundary", () => {
    const source = [replayMessage(), toolResult("replayed", "output", 2), replayMessage(3)];
    const projected = project(source);
    expect(() => assertValidToolPairingProjection(
      source,
      projected.slice(2).concat(projected.slice(1, 2)),
    )).toThrow("orphan-result:replayed@1");
  });

  test("rejects an interruption introduced between the replay and its result", () => {
    const source = [replayMessage(), toolResult("replayed", "output", 2)];
    const projected = project(source);
    projected.splice(1, 0, userMessage("synthetic interruption", 3));
    expect(() => assertValidToolPairingProjection(source, projected)).toThrow("orphan-result:replayed@2");
  });

  test("does not authorize a fabricated result with identical fields", () => {
    const source = [replayMessage(), toolResult("replayed", "output", 2)];
    const projected = project(source).slice(0, 1).concat(structuredClone(source.slice(1)));
    expect(() => assertValidToolPairingProjection(source, projected)).toThrow("orphan-result:replayed@1");
  });

  test("does not transfer an allowance to an identical duplicate source occurrence", () => {
    const result = toolResult("replayed", "identical output", 2);
    // Exercise distinct but equal objects as well as repeated references to one object.
    for (const duplicate of [structuredClone(result), result]) {
      const source = [replayMessage(), result, duplicate];
      const projected = project(source);
      expect(() => assertValidToolPairingProjection(
        source,
        projected.slice(0, 1).concat(projected.slice(2)),
      )).toThrow("orphan-result:replayed@1");
      expect(() => assertValidToolPairingProjection(
        source,
        projected.slice(0, 2),
      )).not.toThrow();
    }
  });

  test("rejects a duplicate retained after incomplete-batch repair removes the first result", () => {
    const interruptions: AgentMessage[] = [
      { role: "developer", content: "interruption", timestamp: 2 },
      replayMessage(2),
    ];
    for (const interruption of interruptions) {
      const source = [
        assistantMessage([toolCall("missing", "read")], 1),
        interruption,
        toolResult("missing", "first", 3),
        toolResult("missing", "duplicate", 4),
      ];
      const repaired = omitIncompleteToolGroupsForProjection(
        cloneLogicalMessagesForProjection(buildLogicalMessages(source)),
      );
      const projected = repaired.groups.flatMap((group) => group.messages);
      expect(projected).toEqual(source.slice(1, 2).concat(source.slice(3)));
      expect(() => assertValidToolPairingProjection(source, projected)).toThrow("orphan-result:missing@1");
    }
  });

  test("retains valid replay provenance after omissions, metadata changes, and inserted messages", () => {
    const source = [
      assistantMessage([toolCall("unfinished", "read")], 1),
      replayMessage(2),
      toolResult("replayed", "output", 3),
      toolResult("also-replayed", "another output", 4),
    ];
    const sourceSnapshot = JSON.stringify(source);
    const repaired = omitIncompleteToolGroupsForProjection(
      cloneLogicalMessagesForProjection(buildLogicalMessages(source)),
    );
    const projected = repaired.groups.flatMap((group) => group.messages);
    const result = projected[1];
    if (!result || result.role !== "toolResult") throw new Error("Missing replay result.");
    result.content = [{ type: "text", text: "output with DCP metadata" }];
    projected.unshift(userMessage("synthetic summary", 0));
    projected.push(userMessage("DCP nudge", 5));
    expect(() => assertValidToolPairingProjection(source, projected)).not.toThrow();
    expect(JSON.stringify(source)).toBe(sourceSnapshot);
  });

  test("accepts raw and repeatedly cloned retained replay occurrences", () => {
    const source = [replayMessage(), toolResult("replayed", "output", 2)];
    const firstProjection = project(source);
    const secondProjection = project(firstProjection);
    expect(() => assertValidToolPairingProjection(source, source)).not.toThrow();
    expect(() => assertValidToolPairingProjection(source, secondProjection)).not.toThrow();
    expect(() => assertValidToolPairingProjection(firstProjection, secondProjection)).not.toThrow();
    expect(JSON.stringify(firstProjection)).toBe(JSON.stringify(source));
    expect(Reflect.ownKeys(firstProjection[1] as object)).toEqual(Reflect.ownKeys(source[1] as object));
  });

  test("does not exempt duplicate calls, duplicate results, or missing results", () => {
    const source = [
      replayMessage(),
      toolResult("replayed", "output", 2),
      toolResult("replayed", "duplicate", 3),
      assistantMessage([toolCall("visible", "read"), toolCall("visible", "read")], 4),
    ];
    const projected = project(source);
    expect(() => assertValidToolPairingProjection(source, projected)).toThrow("duplicate-result:replayed@2");
    expect(() => assertValidToolPairingProjection(source, projected)).toThrow("duplicate-call:visible@3");
    expect(() => assertValidToolPairingProjection(source, projected)).toThrow("missing-result:visible@3");
  });
});
