import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage, convertMessageToLlm } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerDynamicContextPruning } from "../src/extension.ts";
import { DCP_STATE_ENTRY, restoreStateFromBranch } from "../src/state/persistence.ts";
import type { CompressionBlock, PersistedMutation } from "../src/state/types.ts";
import { isUnknownRecord } from "../src/type-guards.ts";
import { messageEntry, toolResult, userMessage } from "./fixtures/messages.ts";

type Handler = (event: unknown, context: ExtensionContext) => unknown;
interface TestEntry {
  type: string;
  id: string;
  message?: AgentMessage;
  customType?: string;
  data?: unknown;
}

// The host is a test double; the registered context handler, configuration,
// persistence, nudge, compression, and validation functions are all production code.
function harness(
  messages: AgentMessage[],
  keys: string[],
  mutations: PersistedMutation[] = [],
  mode: "range" | "message" = "range",
  tokens = 0,
) {
  const directory = mkdtempSync(join(tmpdir(), "dcp-replay-context-"));
  const agentDir = join(directory, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "dcp.json"), JSON.stringify({
    pruneNotification: "off",
    compress: { mode, minContextLimit: 10, maxContextLimit: 100, nudgeForce: "strong" },
    strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
  }));
  const branch: TestEntry[] = messages.map((message, index) => messageEntry(keys[index] ?? `entry-${index}`, message));
  for (const data of mutations) branch.push({ type: "custom", id: `saved-${branch.length}`, customType: DCP_STATE_ENTRY, data });
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  const statuses: (string | undefined)[] = [];
  const warnings: string[] = [];
  // Parameter-schema construction is not the behavior under test.
  const schema = { describe: () => schema, min: () => schema };
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => unknown }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: `new-${branch.length}`, customType, data }),
    zod: { object: () => schema, string: () => schema, array: () => schema },
    setLabel: () => {},
    getActiveTools: () => ["compress"],
    setActiveTools: async () => {},
    logger: { warn: () => {}, debug: () => {} },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: directory,
    hasUI: false,
    sessionManager: { getBranch: () => branch, getSessionId: () => "replay-context-test" },
    ui: { notify: (text: string) => warnings.push(text), setStatus: (_key: string, text?: string) => statuses.push(text) },
    getContextUsage: () => ({ tokens, contextWindow: 1_000 }),
  } as unknown as ExtensionContext;
  registerDynamicContextPruning(pi, { cwd: directory, agentDir, createGlobalConfig: false });
  const emit = async (name: string, event: unknown = { type: name }) => {
    const handler = handlers.get(name);
    assert.ok(handler, `${name} handler was registered`);
    return await handler(event, context);
  };
  return {
    branch, statuses, warnings,
    restore: () => emit("session_start"),
    state: () => restoreStateFromBranch(branch),
    project: async (): Promise<AgentMessage[]> => {
      const result = await emit("context", { type: "context", messages });
      assert.ok(isUnknownRecord(result) && Array.isArray(result.messages));
      return result.messages as AgentMessage[];
    },
    compress: async (args: unknown) => {
      const tool = tools.get("compress");
      assert.ok(tool);
      return await tool.execute("compression-call", args, undefined, undefined, context);
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function replay(text = "Native replay") {
  const message = userMessage(text, 2);
  message.providerPayload = { type: "openaiResponsesHistory", items: [
    { type: "function_call", call_id: "call_x", id: "fc_x", name: "read", arguments: "{}" },
  ] };
  return message;
}

function references(): PersistedMutation {
  return { version: 1, at: 1, kind: "references-assigned", nextRef: 100, assignments: [
    { key: "before", ref: "m0001" }, { key: "replay", ref: "m0099" }, { key: "after", ref: "m0002" },
  ] };
}

function savedBlock(memberKeys: string[]): PersistedMutation {
  const block: CompressionBlock = {
    blockId: 1, runId: 1, mode: "range", active: true, deactivatedByUser: false,
    topic: "saved", startRef: "m0001", endRef: "m0099", anchorKey: "before",
    memberKeys, directMemberKeys: [...memberKeys], toolCallIds: [], includedBlockIds: [], consumedBlockIds: [],
    summary: "Old saved summary", compressedTokens: 100, summaryTokens: 10, durationMs: 0, createdAt: 1,
  };
  return { version: 1, at: 2, kind: "compression-created", blocks: [block] };
}

function assertReplay(messages: AgentMessage[], original: ReturnType<typeof replay>) {
  const message = messages.find((candidate) => candidate.role === "user" && candidate.timestamp === original.timestamp);
  assert.deepEqual(message, original, "the entire replay carrier survives unchanged");
}

describe("registered DCP replay context lifecycle", () => {
  test("handles OMP's native constructor before its actual LLM conversion", async () => {
    const summary = createCompactionSummaryMessage(
      "Native compaction summary", 1_000, new Date(1).toISOString(), undefined,
      replay().providerPayload, undefined, [{ type: "text", text: "Retained archive" }],
    );
    const source: AgentMessage[] = [summary, toolResult("call_x|fc_x", "real output", 3)];
    const snapshot = structuredClone(source);
    const h = harness(source, ["summary", "result"]);
    try {
      await h.restore();
      for (let request = 0; request < 3; request++) {
        const projected = await h.project();
        assert.deepEqual(projected[0], summary);
        const converted = projected.map(convertMessageToLlm);
        assert.deepEqual(converted.map((message) => message?.role), ["user", "toolResult"]);
        const convertedSummary = converted[0];
        assert.ok(convertedSummary?.role === "user");
        assert.deepEqual(convertedSummary.providerPayload, summary.providerPayload);
      }
      assert.deepEqual(source, snapshot);
      assert.deepEqual(h.warnings, []);
    } finally { h.dispose(); }
  });

  test("does not restore a nudgeable reference onto a protected replay-only context", async () => {
    const original = replay("Replay\n<dcp-message-id>m0099</dcp-message-id>");
    const h = harness([original], ["replay"], [references()], "range", 200);
    try {
      await h.restore();
      assertReplay(await h.project(), original);
      assertReplay(await h.project(), original);
      assert.deepEqual(h.warnings, []);
    } finally { h.dispose(); }
  });

  for (const hasResult of [false, true]) {
    test(`stale replay tag cannot capture a nudge for an omitted ordinary message (result=${hasResult})`, async () => {
      const original = replay("Replay\n<dcp-message-id>m0001</dcp-message-id>");
      const source: AgentMessage[] = [userMessage("Earlier", 1), original];
      const keys = ["before", "replay"];
      if (hasResult) { source.push(toolResult("call_x|fc_x", "output", 3)); keys.push("result"); }
      source.push(userMessage("Later", 4)); keys.push("after");
      const snapshot = structuredClone(source);
      const h = harness(source, keys, [references(), savedBlock(["before"]), {
        version: 1, at: 3, kind: "nudge-anchors", contextLimit: ["m0001"], turn: [], iteration: [],
      }], "range", 200);
      try {
        await h.restore();
        const projected = await h.project();
        assertReplay(projected, original);
        const last = projected.at(-1);
        assert.ok(last?.role === "user" && last.synthetic === true);
        assert.match(String(last.content), /MAX CONTEXT LIMIT REACHED/);
        assert.deepEqual(source, snapshot);
      } finally { h.dispose(); }
    });
  }

  for (const mode of ["message", "range"] as const) {
    test(`restores, quarantines, then applies new ${mode} compression through the real handlers`, async () => {
      const original = replay();
      const source = [userMessage("Earlier details", 1), original, toolResult("call_x|fc_x", "output", 3), userMessage("Later details", 4)];
      const snapshot = structuredClone(source);
      const h = harness(source, ["before", "replay", "result", "after"], [references(), savedBlock(["before", "replay"])], mode);
      try {
        await h.restore();
        assertReplay(await h.project(), original);
        let state = h.state();
        assert.equal(state.blocks.get(1)?.invalidatedByReplay, true);
        assert.equal(state.activeBlockIds.size, 0);
        assert.equal(state.stats.totalPruneTokens, 0);
        const args = mode === "message"
          ? { topic: "fresh", content: [{ messageId: "m0001", topic: "before", summary: "Fresh summary" }] }
          : { topic: "fresh", content: [{ startId: "m0001", endId: "m0002", summary: "Fresh summary" }] };
        await h.compress(args);
        state = h.state();
        const created = state.blocks.get(2);
        assert.ok(created?.active);
        assert.deepEqual(created.consumedBlockIds, []);
        assert.equal(created.memberKeys.includes("replay"), false);
        assert.ok(created.compressedTokens > 0);
        for (let request = 0; request < 3; request++) {
          if (request === 1) await h.restore();
          const projected = await h.project();
          assertReplay(projected, original);
          assert.ok(projected.some((message) => message.role === "user" && String(message.content).includes("Fresh summary")));
        }
        assert.equal(h.branch.filter((entry) => isUnknownRecord(entry.data) && entry.data.kind === "replay-blocks-invalidated").length, 1);
        assert.deepEqual(source, snapshot);
        assert.deepEqual(h.warnings, []);
      } finally { h.dispose(); }
    });
  }
});
