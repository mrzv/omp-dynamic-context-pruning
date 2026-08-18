import { describe, expect, test } from "bun:test";
import { buildLogicalMessages } from "../src/messages/logical-messages.ts";
import { assignStableReferences, createMessageReferenceState } from "../src/messages/identity.ts";
import { createRuntimeState, applyMutation } from "../src/state/runtime.ts";
import { rebuildToolCache } from "../src/state/tool-cache.ts";
import {
  createToolSignature,
  selectAutomaticPrunes,
  selectDuplicateTools,
  selectOldErrorTools,
  type PruningStrategyConfig,
} from "../src/strategies/pruning.ts";
import {
  applySelectedToolPruning,
  PRUNED_ERROR_INPUT,
  PRUNED_QUESTION_INPUT,
  PRUNED_TOOL_OUTPUT,
} from "../src/strategies/transform.ts";
import { assistantMessage, toolCall, toolResult, userMessage } from "./fixtures/messages.ts";

function config(overrides: Partial<PruningStrategyConfig> = {}): PruningStrategyConfig {
  return {
    automaticInManualMode: false,
    protectedFilePatterns: [],
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 2, protectedTools: [] },
    ...overrides,
  };
}

function prepare(messages: Parameters<typeof buildLogicalMessages>[0]) {
  const groups = buildLogicalMessages(messages);
  assignStableReferences(groups, createMessageReferenceState());
  const state = createRuntimeState();
  rebuildToolCache(state, groups);
  return { groups, state };
}

describe("tool pruning", () => {
  test("normalizes object keys for duplicate signatures", () => {
    expect(createToolSignature("read", { path: "a", options: { z: 2, a: 1 } }))
      .toBe(createToolSignature("read", { options: { a: 1, z: 2 }, path: "a" }));
  });

  test("deduplicates only older identical tool outputs", () => {
    const first = toolResult("old", "old output", 3);
    const latest = toolResult("new", "new output", 6);
    const { groups, state } = prepare([
      userMessage("one", 1),
      assistantMessage([toolCall("old", "read", { path: "src/a.ts" })], 2),
      first,
      userMessage("two", 4),
      assistantMessage([toolCall("new", "read", { path: "src/a.ts" })], 5),
      latest,
    ]);

    const selected = selectDuplicateTools(state, config(), 10);
    expect(selected.map((record) => record.toolCallId)).toEqual(["old"]);
    applyMutation(state, { version: 1, at: 10, kind: "tools-pruned", records: selected });
    expect(applySelectedToolPruning(groups, state)).toBe(1);
    expect(first.content).toEqual([{ type: "text", text: PRUNED_TOOL_OUTPUT }]);
    expect(latest.content).toEqual([{ type: "text", text: "new output" }]);
  });

  test("preserves ask answers and skips edit and write deduplication", () => {
    const oldAsk = assistantMessage([toolCall("ask-old", "ask", { questions: [{ question: "Choose?" }] })], 2);
    const oldAnswer = toolResult("ask-old", "User selected A", 3, false, "ask");
    const { groups, state } = prepare([
      userMessage("one", 1),
      oldAsk,
      oldAnswer,
      assistantMessage([toolCall("edit-old", "edit", { path: "a.ts", patch: "x" })], 4),
      toolResult("edit-old", "edited", 5, false, "edit"),
      userMessage("two", 6),
      assistantMessage([toolCall("ask-new", "ask", { questions: [{ question: "Choose?" }] })], 7),
      toolResult("ask-new", "User selected B", 8, false, "ask"),
      assistantMessage([toolCall("edit-new", "edit", { path: "a.ts", patch: "x" })], 9),
      toolResult("edit-new", "edited", 10, false, "edit"),
    ]);

    const selected = selectDuplicateTools(state, config(), 11);
    expect(selected.map((record) => record.toolCallId)).toEqual(["ask-old"]);
    applyMutation(state, { version: 1, at: 11, kind: "tools-pruned", records: selected });
    expect(applySelectedToolPruning(groups, state)).toBe(1);
    expect(oldAsk.content[0]).toMatchObject({ arguments: { questions: PRUNED_QUESTION_INPUT } });
    expect(oldAnswer.content).toEqual([{ type: "text", text: "User selected A" }]);
  });

  test("protects OMP read paths, selectors, and native-pruned results", () => {
    const native = toolResult("native", "[Uneventful result elided]", 3);
    native.prunedAt = 3;
    const { state } = prepare([
      userMessage("one", 1),
      assistantMessage([
        toolCall("protected-old", "read", { path: "secrets.txt:50-" }),
        toolCall("native", "read", { path: "src/a.ts" }),
      ], 2),
      toolResult("protected-old", "secret", 3),
      native,
      userMessage("two", 4),
      assistantMessage([
        toolCall("protected-new", "read", { path: "secrets.txt:50-" }),
        toolCall("new", "read", { path: "src/a.ts" }),
      ], 5),
      toolResult("protected-new", "secret again", 6),
      toolResult("new", "new", 7),
    ]);

    const selected = selectDuplicateTools(state, config({ protectedFilePatterns: ["**/secrets.txt"] }));
    expect(selected).toEqual([]);
  });

  test("never rewrites provider-native tool history", () => {
    const providerCall = toolCall("provider-old", "computer", { action: "click" });
    providerCall.providerMetadata = { type: "computer" } as never;
    const providerResult = toolResult("provider-old", "screenshot", 3, false, "computer");
    providerResult.providerMetadata = { type: "computer" } as never;
    const { groups, state } = prepare([
      userMessage("one", 1),
      assistantMessage([providerCall], 2),
      providerResult,
      userMessage("two", 4),
      assistantMessage([toolCall("provider-new", "computer", { action: "click" })], 5),
      toolResult("provider-new", "screenshot", 6, false, "computer"),
    ]);

    expect(selectDuplicateTools(state, config())).toEqual([]);
    applyMutation(state, {
      version: 1,
      at: 10,
      kind: "tools-pruned",
      records: [{ toolCallId: "provider-old", reason: "sweep", tokenCount: 10, prunedAt: 10 }],
    });
    expect(applySelectedToolPruning(groups, state)).toBe(0);
    expect(providerResult.content).toEqual([{ type: "text", text: "screenshot" }]);
  });

  test("purges old failed inputs without removing their results", () => {
    const failedAssistant = assistantMessage([
      toolCall("failed", "bash", { command: "cat secret", options: { cwd: "/tmp", retries: 2 } }),
    ], 2);
    failedAssistant.providerPayload = { type: "openaiResponsesHistory", items: [] };
    const failedResult = toolResult("failed", "permission denied", 3, true, "bash");
    const { groups, state } = prepare([
      userMessage("one", 1),
      failedAssistant,
      failedResult,
      userMessage("two", 4),
      assistantMessage([{ type: "text", text: "iteration two" }], 5),
      userMessage("three", 6),
      assistantMessage([{ type: "text", text: "iteration three" }], 7),
    ]);

    expect(state.currentTurn).toBe(3);
    const selected = selectOldErrorTools(state, config(), 10);
    expect(selected.map((record) => record.toolCallId)).toEqual(["failed"]);
    applyMutation(state, { version: 1, at: 10, kind: "tools-pruned", records: selected });
    expect(applySelectedToolPruning(groups, state)).toBe(1);
    expect(failedAssistant.content[0]).toMatchObject({
      arguments: { command: PRUNED_ERROR_INPUT, options: { cwd: "/tmp", retries: 2 } },
    });
    expect(failedAssistant.providerPayload).toBeUndefined();
    expect(failedResult.content).toEqual([{ type: "text", text: "permission denied" }]);
  });

  test("honors fractional error-age thresholds", () => {
    const { state } = prepare([
      userMessage("one", 1),
      assistantMessage([toolCall("failed", "bash", { command: "false" })], 2),
      toolResult("failed", "exit 1", 3, true, "bash"),
      assistantMessage([{ type: "text", text: "iteration two" }], 4),
    ]);
    const fractional = config({
      purgeErrors: { enabled: true, turns: 1.5, protectedTools: [] },
    });
    expect(selectOldErrorTools(state, fractional)).toEqual([]);
    state.currentTurn = 3;
    expect(selectOldErrorTools(state, fractional).map((record) => record.toolCallId)).toEqual(["failed"]);
  });

  test("deduplicated failures preserve diagnostics and prune failed inputs", () => {
    const oldFailure = assistantMessage([toolCall("error-old", "bash", { command: "false" })], 2);
    const oldResult = toolResult("error-old", "exit 1", 3, true, "bash");
    const { groups, state } = prepare([
      userMessage("one", 1),
      oldFailure,
      oldResult,
      assistantMessage([toolCall("error-new", "bash", { command: "false" })], 4),
      toolResult("error-new", "exit 1", 5, true, "bash"),
    ]);

    const selected = selectDuplicateTools(state, config(), 10);
    expect(selected.map((record) => record.toolCallId)).toEqual(["error-old"]);
    applyMutation(state, { version: 1, at: 10, kind: "tools-pruned", records: selected });
    expect(applySelectedToolPruning(groups, state)).toBe(1);
    expect(oldFailure.content[0]).toMatchObject({ arguments: { command: PRUNED_ERROR_INPUT } });
    expect(oldResult.content).toEqual([{ type: "text", text: "exit 1" }]);
  });

  test("automatic pruning is disabled in manual mode", () => {
    const { state } = prepare([]);
    state.manualMode = true;
    expect(selectAutomaticPrunes(state, config())).toEqual([]);
  });
});
