import { describe, expect, test } from "bun:test";
import { buildLogicalMessages } from "../src/messages/logical-messages.ts";
import { assignStableReferences, createMessageReferenceState } from "../src/messages/identity.ts";
import {
  injectMessageMetadata,
  replaceBlockIdsWithBlocked,
  stripDcpMetadata,
  stripDcpMetadataFromText,
} from "../src/messages/metadata.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

describe("DCP metadata", () => {
  test("injects one logical ID into every parallel tool result", () => {
    const messages = [
      assistantMessage([toolCall("a", "read"), toolCall("b", "read")], 2),
      toolResult("a", "first", 3),
      toolResult("b", "second", 4),
    ];
    const groups = buildLogicalMessages(messages, ["assistant", "result-a", "result-b"]);
    assignStableReferences(groups, createMessageReferenceState());
    injectMessageMetadata(groups, new Map([["assistant", "high"]]));

    expect(messages[1]?.content[0]).toMatchObject({ text: "first\n<dcp-message-id priority=\"high\">m0001</dcp-message-id>" });
    expect(messages[2]?.content[0]).toMatchObject({ text: "second\n<dcp-message-id priority=\"high\">m0001</dcp-message-id>" });
    expect(messages[0]?.content.every((part) => part.type === "toolCall")).toBe(true);
  });

  test("marks unmatched targetable messages as blocked", () => {
    const messages = [userMessage("do not compress", 1)];
    const groups = buildLogicalMessages(messages);
    injectMessageMetadata(groups);
    expect(messages[0]?.content).toContain("<dcp-message-id>BLOCKED</dcp-message-id>");
  });

  test("strips paired, nested, and orphan DCP tags", () => {
    expect(stripDcpMetadataFromText("before<dcp:function_calls><dcp:x>hidden</dcp:x></dcp:function_calls>after"))
      .toBe("beforeafter");
    expect(stripDcpMetadataFromText("before</dcp-message-id>after")).toBe("beforeafter");

    const messages = [assistantMessage([{ type: "text", text: "answer\n<dcp-message-id>m0001</dcp-message-id>" }], 2)];
    stripDcpMetadata(messages);
    expect(messages[0]?.content[0]).toMatchObject({ text: "answer\n" });
  });


  test("preserves non-DCP tags and invalidates native replay payloads", () => {
    expect(stripDcpMetadataFromText("<dcpu>keep</dcpu>")).toBe("<dcpu>keep</dcpu>");
    const message = assistantMessage([{ type: "text", text: "answer" }], 2);
    message.providerPayload = {
      type: "openaiResponsesHistory",
      items: [{ type: "message", content: "stale" }],
    };
    const groups = buildLogicalMessages([message], ["assistant"]);
    assignStableReferences(groups, createMessageReferenceState());
    injectMessageMetadata(groups);
    expect(message.providerPayload).toBeUndefined();
    expect(message.content[0]).toMatchObject({ text: "answer\n<dcp-message-id>m0001</dcp-message-id>" });
  });

  test("does not inject text after an incomplete tool call", () => {
    const message = assistantMessage([toolCall("running", "read")], 2);
    const groups = buildLogicalMessages([message], ["assistant"]);
    injectMessageMetadata(groups);
    expect(message.content).toEqual([toolCall("running", "read")]);
  });
  test("blocks compressed block IDs in message mode", () => {
    expect(replaceBlockIdsWithBlocked("<dcp-message-id>b12</dcp-message-id>"))
      .toBe("<dcp-message-id>BLOCKED</dcp-message-id>");
  });
});
