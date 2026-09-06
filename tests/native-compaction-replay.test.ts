import { describe, expect, test } from "bun:test";
import { createCompactionSummaryMessage, convertMessageToLlm } from "@oh-my-pi/pi-agent-core/compaction/messages";
import { buildLogicalMessages, cloneLogicalMessagesForProjection, omitIncompleteToolGroupsForProjection } from "../src/messages/logical-messages.ts";
import { injectMessageMetadata, stripDcpMetadata } from "../src/messages/metadata.ts";
import { assertValidToolPairingProjection } from "../src/messages/pairing.ts";
import { applyCompressedContext } from "../src/compress/transform.ts";
import { createRuntimeState } from "../src/state/runtime.ts";
import { toolResult } from "./fixtures/messages.ts";

describe("OMP native compaction representation", () => {
  for (const withResult of [false, true]) {
    test(`retains the native constructor's payload through DCP and LLM conversion (result=${withResult})`, () => {
      const payload = {
        type: "openaiResponsesHistory" as const,
        provider: "openai",
        items: [{ type: "function_call", id: "fc_x", call_id: "call_x", name: "read", arguments: "{}" }],
      };
      const summary = createCompactionSummaryMessage(
        "Native summary", 10_000, "2026-09-06T00:00:00.000Z", undefined, payload, undefined,
        [{ type: "text", text: "Retained native archive block" }],
      );
      const source = [summary, ...(withResult ? [toolResult("call_x|fc_x", "real output", 3)] : [])];
      const original = structuredClone(source);
      const messages = structuredClone(source);
      stripDcpMetadata(messages);
      const groups = omitIncompleteToolGroupsForProjection(cloneLogicalMessagesForProjection(
        buildLogicalMessages(messages, ["summary", "result"]),
      )).groups;
      injectMessageMetadata(groups);
      const projected = applyCompressedContext(groups, createRuntimeState(), false);
      expect(projected[0]?.role).toBe("compactionSummary");
      expect(() => assertValidToolPairingProjection(messages, projected)).not.toThrow();
      const converted = projected.map(convertMessageToLlm);
      expect(converted[0]?.role).toBe("user");
      const convertedSummary = converted[0];
      if (convertedSummary?.role !== "user") throw new Error("Expected converted native summary");
      expect(convertedSummary.providerPayload).toEqual(payload);
      expect(convertedSummary.content).toEqual([
        { type: "text", text: "Native summary" }, { type: "text", text: "Retained native archive block" },
      ]);
      expect(converted.map((message) => message?.role)).toEqual(withResult ? ["user", "toolResult"] : ["user"]);
      expect(source).toEqual(original);
    });
  }
});
