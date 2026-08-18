import { describe, expect, test } from "bun:test";
import { assertValidToolPairing, findToolPairingIssues } from "../src/messages/pairing.ts";
import { assistantMessage, toolCall, toolResult } from "./fixtures/messages.ts";

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
