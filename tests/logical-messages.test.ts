import { describe, expect, test } from "bun:test";
import { buildLogicalMessages } from "../src/messages/logical-messages.ts";
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
});
