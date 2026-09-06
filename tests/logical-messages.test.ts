import { describe, expect, test } from "bun:test";
import { assertValidToolPairing, findToolPairingIssues } from "../src/messages/pairing.ts";
import {
  buildLogicalMessages,
  cloneLogicalMessagesForProjection,
  omitIncompleteToolGroupsForProjection,
} from "../src/messages/logical-messages.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

describe("logical OMP messages", () => {
  test("groups a parallel assistant tool batch atomically", () => {
    const messages = [
      userMessage("inspect both files", 1),
      assistantMessage([
        toolCall("call-a", "read", { path: "a.ts" }),
        toolCall("call-b", "read", { path: "b.ts" }),
      ], 2),
      toolResult("call-a", "a", 3),
      toolResult("call-b", "b", 4),
      assistantMessage([{ type: "text", text: "Both inspected." }], 5),
    ];

    const groups = buildLogicalMessages(messages, ["e1", "e2", "e3", "e4", "e5"]);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toMatchObject({
      key: "e2",
      kind: "assistant",
      protected: false,
      startIndex: 1,
      endIndex: 3,
      entryIds: ["e2", "e3", "e4"],
    });
    expect(groups[1]?.toolCalls.map((call) => call.id)).toEqual(["call-a", "call-b"]);
    expect(groups[1]?.toolResults.map((result) => result.toolCallId)).toEqual(["call-a", "call-b"]);
  });

  test("protects an incomplete assistant group", () => {
    const messages = [
      assistantMessage([toolCall("call-a", "read"), toolCall("call-b", "read")], 2),
      toolResult("call-a", "a", 3),
    ];
    const [group] = buildLogicalMessages(messages, ["e2", "e3"]);
    expect(group?.protected).toBe(true);
    expect(group?.endIndex).toBe(1);
  });

  test("does not absorb unrelated tool results", () => {
    const messages = [
      assistantMessage([toolCall("call-a", "read")], 2),
      toolResult("different", "orphan", 3),
    ];
    const groups = buildLogicalMessages(messages, ["e2", "e3"]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.protected).toBe(true);
    expect(groups[1]?.kind).toBe("orphan-tool-result");
  });

  test("omits an incomplete parallel tool group from request projection", () => {
    const messages = [
      userMessage("inspect both files", 1),
      assistantMessage([
        toolCall("complete", "read", { path: "a.ts" }),
        toolCall("running", "read", { path: "b.ts" }),
      ], 2),
      toolResult("complete", "a", 3),
      { role: "developer", content: "Do not execute tools.", timestamp: 4 } as const,
      userMessage("What is happening?", 5),
    ];
    const groups = cloneLogicalMessagesForProjection(buildLogicalMessages(messages));

    const repaired = omitIncompleteToolGroupsForProjection(groups);
    const projectedMessages = repaired.groups.flatMap((group) => group.messages);

    expect(repaired.omitted).toEqual([{
      startIndex: 1,
      missingToolCallIds: ["running"],
    }]);
    expect(projectedMessages.map((message) => message.role)).toEqual(["user", "developer", "user"]);
    expect(findToolPairingIssues(projectedMessages)).toEqual([]);
    expect(() => assertValidToolPairing(projectedMessages)).not.toThrow();
    expect(groups[1]?.toolCalls.map((call) => call.id)).toEqual(["complete", "running"]);
    expect(groups[1]?.toolResults.map((result) => result.toolCallId)).toEqual(["complete"]);
  });

  test("omits trailing results detached from an incomplete tool group", () => {
    const messages = [
      assistantMessage([toolCall("complete", "read"), toolCall("detached", "read")], 1),
      toolResult("complete", "done", 2),
      { role: "developer", content: "Injected between tool results.", timestamp: 3 } as const,
      toolResult("detached", "late", 4),
    ];
    const groups = cloneLogicalMessagesForProjection(buildLogicalMessages(messages));

    const repaired = omitIncompleteToolGroupsForProjection(groups);
    const projectedMessages = repaired.groups.flatMap((group) => group.messages);

    expect(repaired.omitted).toEqual([{
      startIndex: 0,
      missingToolCallIds: ["detached"],
    }]);
    expect(projectedMessages.map((message) => message.role)).toEqual(["developer"]);
    expect(findToolPairingIssues(projectedMessages)).toEqual([]);
    expect(() => assertValidToolPairing(projectedMessages)).not.toThrow();
  });

  test("retains detached duplicate results for calls already resolved in an omitted group", () => {
    const messages = [
      assistantMessage([toolCall("complete", "read"), toolCall("missing", "read")], 1),
      toolResult("complete", "done", 2),
      { role: "developer", content: "Injected after the complete result.", timestamp: 3 } as const,
      toolResult("complete", "duplicate", 4),
    ];
    const groups = cloneLogicalMessagesForProjection(buildLogicalMessages(messages));

    const repaired = omitIncompleteToolGroupsForProjection(groups);
    const projectedMessages = repaired.groups.flatMap((group) => group.messages);

    expect(repaired.omitted).toEqual([{
      startIndex: 0,
      missingToolCallIds: ["missing"],
    }]);
    expect(projectedMessages).toEqual(messages.slice(2));
    expect(findToolPairingIssues(projectedMessages)).toEqual([{
      kind: "orphan-result",
      toolCallId: "complete",
      messageIndex: 1,
    }]);
  });

  test("omits at most one detached result for each missing call", () => {
    const messages = [
      assistantMessage([toolCall("missing", "read")], 1),
      { role: "developer", content: "Injected before detached results.", timestamp: 2 } as const,
      toolResult("missing", "first", 3),
      toolResult("missing", "duplicate", 4),
    ];
    const groups = cloneLogicalMessagesForProjection(buildLogicalMessages(messages));

    const repaired = omitIncompleteToolGroupsForProjection(groups);
    const projectedMessages = repaired.groups.flatMap((group) => group.messages);

    expect(repaired.omitted).toEqual([{
      startIndex: 0,
      missingToolCallIds: ["missing"],
    }]);
    expect(projectedMessages).toEqual(messages.slice(1, 2).concat(messages.slice(3)));
    expect(findToolPairingIssues(projectedMessages)).toEqual([{
      kind: "orphan-result",
      toolCallId: "missing",
      messageIndex: 1,
    }]);
  });

  test("retains orphan results that precede an omitted tool group", () => {
    const messages = [
      toolResult("future", "orphan", 1),
      assistantMessage([toolCall("future", "read")], 2),
    ];
    const groups = cloneLogicalMessagesForProjection(buildLogicalMessages(messages));

    const repaired = omitIncompleteToolGroupsForProjection(groups);
    const projectedMessages = repaired.groups.flatMap((group) => group.messages);

    expect(projectedMessages).toEqual(messages.slice(0, 1));
    expect(findToolPairingIssues(projectedMessages)).toEqual([{
      kind: "orphan-result",
      toolCallId: "future",
      messageIndex: 0,
    }]);
  });

  test("retains complete and intrinsically malformed tool groups for validation", () => {
    const complete = cloneLogicalMessagesForProjection(buildLogicalMessages([
      assistantMessage([toolCall("complete", "read")], 1),
      toolResult("complete", "done", 2),
    ]));
    const duplicate = cloneLogicalMessagesForProjection(buildLogicalMessages([
      assistantMessage([toolCall("duplicate", "read"), toolCall("duplicate", "read")], 3),
    ]));

    expect(omitIncompleteToolGroupsForProjection(complete)).toEqual({
      groups: complete,
      omitted: [],
    });
    expect(omitIncompleteToolGroupsForProjection(duplicate)).toEqual({
      groups: duplicate,
      omitted: [],
    });
    expect(findToolPairingIssues(duplicate.flatMap((group) => group.messages)).map((issue) => issue.kind)).toEqual([
      "duplicate-call",
      "missing-result",
    ]);
  });

  test("retains incomplete groups with conversation-wide duplicate call IDs", () => {
    const groups = cloneLogicalMessagesForProjection(buildLogicalMessages([
      assistantMessage([toolCall("duplicate", "read")], 1),
      toolResult("duplicate", "done", 2),
      assistantMessage([toolCall("duplicate", "read")], 3),
    ]));

    expect(omitIncompleteToolGroupsForProjection(groups)).toEqual({
      groups,
      omitted: [],
    });
    expect(findToolPairingIssues(groups.flatMap((group) => group.messages)).map((issue) => issue.kind)).toContain(
      "duplicate-call",
    );
  });
});
