import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";
import type { CompressionBlock } from "../src/state/types.ts";
import { isUnknownRecord } from "../src/type-guards.ts";
import { messageEntry, toolResult, userMessage } from "./fixtures/messages.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function runtime(source: AgentMessage[], anchors = false, restoredBlocks: CompressionBlock[] = []) {
  const root = mkdtempSync(join(tmpdir(), "dcp-replay-nudge-"));
  directories.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "dcp.jsonc"), JSON.stringify({
    pruneNotification: "off",
    compress: { permission: "allow", minContextLimit: 0, maxContextLimit: 1000, nudgeForce: "strong", summaryBuffer: true },
    experimental: { customPrompts: false },
  }));
  const modulePath = join(root, "extension.ts");
  writeFileSync(modulePath, [
    `import { registerDynamicContextPruning } from ${JSON.stringify(resolve("src/extension.ts"))};`,
    `export default function(pi) { registerDynamicContextPruning(pi, ${JSON.stringify({ cwd: root, agentDir, createGlobalConfig: false })}); }`,
  ].join("\n"));
  const loaded = await loadExtensions([modulePath], root);
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  if (!extension) throw new Error("Missing DCP extension");
  const saved: unknown[] = [];
  loaded.runtime.appendEntry = (customType, data) => {
    saved.push({ type: "custom", id: `saved-${saved.length}`, customType, data });
  };
  loaded.runtime.getActiveTools = () => ["compress"];
  loaded.runtime.setActiveTools = async () => {};
  loaded.runtime.sendMessage = () => {};
  loaded.runtime.sendUserMessage = () => {};
  const oldReferences = {
    type: "custom", id: "old-refs", customType: "dev.ohmypi.dcp.state.v1",
    data: { version: 1, at: 1, kind: "references-assigned", nextRef: 3,
      assignments: source.length === 1
        ? [{ key: "e0", ref: "m0099" }]
        : [{ key: "e0", ref: "m0001" }, { key: "e3", ref: "m0002" }],
    },
  };
  const branch = [
    ...source.map((message, index) => messageEntry(`e${index}`, message)), oldReferences,
    ...(restoredBlocks.length > 0 ? [{ type: "custom", id: "old-blocks", customType: "dev.ohmypi.dcp.state.v1",
      data: { version: 1, at: 1, kind: "compression-created", blocks: restoredBlocks },
    }] : []),
    ...(anchors ? [{ type: "custom", id: "old-nudge", customType: "dev.ohmypi.dcp.state.v1",
      data: { version: 1, at: 2, kind: "nudge-anchors", contextLimit: ["m0001"], turn: [], iteration: [] },
    }] : []),
  ];
  const context = {
    cwd: root, hasUI: false,
    model: { provider: "openai", id: "test", contextWindow: 10000 },
    getContextUsage: () => ({ tokens: 2000, contextWindow: 10000 }),
    sessionManager: { getBranch: () => [...branch, ...saved], getSessionId: () => "replay-test", getHeader: () => ({}) },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  const start = extension.handlers.get("session_start")?.[0];
  const transform = extension.handlers.get("context")?.[0];
  if (!start || !transform) throw new Error("Missing DCP handlers");
  await Reflect.apply(start, undefined, [{ type: "session_start", reason: "startup" }, context]);
  const transformContext = async (): Promise<AgentMessage[]> => {
    const result: unknown = await Reflect.apply(transform, undefined, [{ type: "context", messages: source }, context]);
    if (!isUnknownRecord(result) || !Array.isArray(result.messages)) throw new Error("Missing transformed context");
    return result.messages as AgentMessage[];
  };
  return Object.assign(transformContext, { saved });
}

const payload = {
  type: "openaiResponsesHistory" as const, provider: "openai",
  items: [{ type: "function_call", id: "fc_x", call_id: "call_x", name: "read", arguments: "{}" }],
};

describe("registered DCP context handler replay nudge safety", () => {
  for (const native of [false, true]) {
    test(`a result-free replay keeps its payload despite an old reference (native=${native})`, async () => {
      const text = "Replay\n<dcp-message-id>m0099</dcp-message-id>";
      const message: AgentMessage = native
        ? createCompactionSummaryMessage(text, 10000, "2026-09-06T00:00:00Z", undefined, payload)
        : { ...userMessage(text), providerPayload: payload };
      const source = [message];
      const original = structuredClone(source);
      const transform = await runtime(source);
      for (let request = 0; request < 3; request++) {
        const projected = await transform();
        expect(projected[0]).toEqual(message);
        expect(projected).toHaveLength(2);
        expect(projected[1]).toMatchObject({ role: "user", synthetic: true, attribution: "agent" });
      }
      expect(source).toEqual(original);
    });
  }

  test("ignored legacy summaries cannot inflate the context-limit nudge budget", async () => {
    const replay: AgentMessage = { ...userMessage("Replay", 2), providerPayload: payload };
    const source = [userMessage("Before", 1), replay, toolResult("call_x|fc_x", "output", 3), userMessage("After", 4)];
    const oldBlock: CompressionBlock = {
      blockId: 1, runId: 1, mode: "range", active: true, deactivatedByUser: false,
      topic: "legacy", startRef: "m0001", endRef: "m0099", anchorKey: "e0",
      memberKeys: ["e0", "e1"], directMemberKeys: ["e0", "e1"], toolCallIds: [],
      consumedBlockIds: [], includedBlockIds: [], summary: "Ignored legacy summary",
      compressedTokens: 100, summaryTokens: 1_000_000, createdAt: 1, durationMs: 0,
    };
    const transform = await runtime(source, false, [oldBlock]);
    const projected = await transform();
    expect(projected[1]).toEqual(replay);
    const anchorMutation = transform.saved.find((entry) => (
      isUnknownRecord(entry) && isUnknownRecord(entry.data) && entry.data.kind === "nudge-anchors"
    ));
    if (!isUnknownRecord(anchorMutation)) throw new Error("Missing persisted nudge anchor");
    expect(anchorMutation.data).toMatchObject({ contextLimit: ["m0002"], turn: [], iteration: [] });
  });

  test("opaque text cannot hijack a retained nudge anchor by repeating its tag", async () => {
    const replay: AgentMessage = { ...userMessage("Replay\n<dcp-message-id>m0001</dcp-message-id>", 2), providerPayload: payload };
    const source = [userMessage("Before", 1), replay, toolResult("call_x|fc_x", "output", 3), userMessage("After", 4)];
    const original = structuredClone(source);
    const transform = await runtime(source, true);
    const projected = await transform();
    expect(projected[1]).toEqual(replay);
    expect(projected[2]?.role).toBe("toolResult");
    expect(projected).toHaveLength(4);
    expect(source).toEqual(original);
  });
});
