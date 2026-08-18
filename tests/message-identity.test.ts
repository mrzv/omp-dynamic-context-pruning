import { describe, expect, test } from "bun:test";
import { buildLogicalMessages } from "../src/messages/logical-messages.ts";
import {
  associateEntryIds,
  assignStableReferences,
  createMessageReferenceState,
  formatMessageReference,
  messageFingerprint,
  parseMessageReference,
} from "../src/messages/identity.ts";
import { assistantMessage, messageEntry, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

describe("stable DCP references", () => {
  test("associates detached copies with branch entries", () => {
    const user = userMessage("request", 10);
    const assistant = assistantMessage([toolCall("call-1", "read")], 20);
    const result = toolResult("call-1", "result", 30);
    const branch = [messageEntry("entry-user", user), messageEntry("entry-assistant", assistant), messageEntry("entry-result", result)];
    const detached = structuredClone([user, assistant, result]);

    expect(associateEntryIds(detached, branch)).toEqual(["entry-user", "entry-assistant", "entry-result"]);
    expect(messageFingerprint(detached[1]!)).toBe(messageFingerprint(assistant));
  });

  test("keeps logical references stable when tool results are regrouped", () => {
    const messages = [
      userMessage("request", 10),
      assistantMessage([toolCall("call-1", "read")], 20),
      toolResult("call-1", "result", 30),
    ];
    const state = createMessageReferenceState();
    const first = buildLogicalMessages(messages, ["entry-user", "entry-assistant", "entry-result"]);
    assignStableReferences(first, state);
    expect(first.map((group) => group.ref)).toEqual(["m0001", "m0002"]);

    const second = buildLogicalMessages(structuredClone(messages), ["entry-user", "entry-assistant", "entry-result"]);
    expect(assignStableReferences(second, state)).toBe(0);
    expect(second.map((group) => group.ref)).toEqual(["m0001", "m0002"]);
  });

  test("validates the bounded reference syntax", () => {
    expect(formatMessageReference(42)).toBe("m0042");
    expect(parseMessageReference("M0042")).toBe(42);
    expect(parseMessageReference("m0000")).toBeUndefined();
    expect(() => formatMessageReference(10_000)).toThrow();
  });
});
