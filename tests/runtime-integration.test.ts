import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";
import { isUnknownRecord } from "../src/type-guards.ts";
import { assistantMessage, userMessage } from "./fixtures/messages.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "omp-dcp-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("OMP runtime integration", () => {
  test("registers, compresses request context, and resets blocks after native compaction", async () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "dcp.jsonc"), `{
      "pruneNotification": "off",
      "compress": { "permission": "ask", "nudgeForce": "strong", "minContextLimit": 0, "maxContextLimit": 999999 }
    }`);
    const extensionModule = join(root, "test-extension.ts");
    const source = resolve("src/extension.ts");
    writeFileSync(extensionModule, [
      `import { registerDynamicContextPruning } from ${JSON.stringify(source)};`,
      "export default function (pi) {",
      `  registerDynamicContextPruning(pi, { cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(agentDir)}, createGlobalConfig: false });`,
      "}",
    ].join("\n"));

    const loaded = await loadExtensions([extensionModule], root);
    expect(loaded.errors).toEqual([]);
    const extension = loaded.extensions[0];
    expect(extension?.tools.has("compress")).toBe(true);
    expect(extension?.commands.has("dcp")).toBe(true);

    const persisted: Array<{ type: "custom"; id: string; customType: string; data: unknown }> = [];
    let activeTools = ["read", "compress"];
    const selections: string[] = [];
    const statuses: Array<string | undefined> = [];
    const notifications: string[] = [];
    loaded.runtime.appendEntry = (customType, data) => {
      persisted.push({ type: "custom", id: `state-${persisted.length + 1}`, customType, data });
    };
    loaded.runtime.getActiveTools = () => [...activeTools];
    loaded.runtime.setActiveTools = async (names) => {
      activeTools = [...names];
    };
    loaded.runtime.sendMessage = () => {};
    loaded.runtime.sendUserMessage = () => {};

    const rawMessages: AgentMessage[] = [
      userMessage("Investigate the parser", 1),
      assistantMessage([{ type: "text", text: "The parser uses a two-stage pipeline." }], 2),
    ];
    const branch = [
      { type: "message", id: "entry-user", message: rawMessages[0] },
      { type: "message", id: "entry-assistant", message: rawMessages[1] },
    ];
    const context = {
      cwd: root,
      hasUI: true,
      mode: "tui",
      model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 100, contextWindow: 200_000, percent: 0.05 }),
      waitForIdle: async () => {},
      sessionManager: {
        getBranch: () => [...branch, ...persisted],
        getSessionId: () => "session-1",
        getHeader: () => ({}),
      },
      ui: {
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        notify: (message: string) => notifications.push(message),
        select: async () => selections.shift(),
      },
    };

    const sessionStart = extension?.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();

    const systemPrompt = extension?.handlers.get("before_agent_start")?.[0];
    const prompted = await systemPrompt?.(
      { type: "before_agent_start", prompt: "Investigate", systemPrompt: ["Base prompt"] },
      context,
    );
    expect(JSON.stringify(prompted)).toContain("context-constrained environment");
    await sessionStart?.({ type: "session_start", reason: "startup" }, context);

    const transform = extension?.handlers.get("context")?.[0];
    expect(transform).toBeDefined();
    const turnNudge = await transform?.({ type: "context", messages: [rawMessages[0]] }, context);
    if (!isUnknownRecord(turnNudge) || !Array.isArray(turnNudge.messages)) throw new Error("Context handler returned no messages.");
    expect(turnNudge.messages).toHaveLength(1);
    expect(JSON.stringify(turnNudge.messages[0])).toContain("Evaluate the conversation");
    const first = await transform?.({ type: "context", messages: rawMessages }, context);
    if (!isUnknownRecord(first) || !Array.isArray(first.messages)) throw new Error("Context handler returned no messages.");
    expect(JSON.stringify(first.messages[0])).toContain("m0001");
    expect(JSON.stringify(first.messages[1])).toContain("m0002");
    expect(JSON.stringify(first.messages[0])).toContain("Evaluate the conversation");

    const compress = extension?.tools.get("compress")?.definition;
    if (!compress) throw new Error("Compress tool was not registered.");
    expect(isUnknownRecord(compress.approval) && compress.approval.policy).toBe("prompt");
    const sweepCommand = extension?.commands.get("dcp-sweep");
    if (!sweepCommand) throw new Error("DCP sweep command was not registered.");
    await Reflect.apply(sweepCommand.handler, sweepCommand, ["2oops", context]);
    expect(notifications.at(-1)).toContain("Usage: /dcp-sweep");
    const toolResult: unknown = await Reflect.apply(compress.execute, compress, [
      "compress-call",
      {
        topic: "parser research",
        content: [{ startId: "m0001", endId: "m0002", summary: "The parser uses a two-stage pipeline." }],
      },
      undefined,
      undefined,
      context,
    ]);
    expect(
      isUnknownRecord(toolResult)
      && Array.isArray(toolResult.content)
      && isUnknownRecord(toolResult.content[0])
      && toolResult.content[0].type === "text",
    ).toBe(true);
    expect(persisted.some((entry) => isUnknownRecord(entry.data) && entry.data.kind === "compression-created")).toBe(true);

    const compressed = await transform?.({ type: "context", messages: rawMessages }, context);
    if (!isUnknownRecord(compressed) || !Array.isArray(compressed.messages)) throw new Error("Context handler returned no messages.");
    expect(compressed.messages).toHaveLength(2);
    expect(JSON.stringify(compressed.messages[0])).toContain("<dcp-message-id>b1</dcp-message-id>");
    expect(JSON.stringify(compressed.messages[1])).toContain("Evaluate the conversation");

    const compact = extension?.handlers.get("session_compact")?.[0];
    await compact?.({ type: "session_compact", compactionEntry: {}, fromExtension: false }, context);
    const restored = await transform?.({ type: "context", messages: rawMessages }, context);
    if (!isUnknownRecord(restored) || !Array.isArray(restored.messages)) throw new Error("Context handler returned no messages.");
    expect(restored.messages).toHaveLength(2);
    expect(JSON.stringify(restored.messages[0])).toContain("m0001");
    expect(JSON.stringify(restored.messages[1])).toContain("m0002");
    const resetsBefore = persisted.filter(
      (entry) => isUnknownRecord(entry.data) && entry.data.kind === "native-compaction-reset",
    ).length;
    await compact?.({ type: "session_compact", compactionEntry: {}, fromExtension: false }, context);
    expect(persisted.filter(
      (entry) => isUnknownRecord(entry.data) && entry.data.kind === "native-compaction-reset",
    )).toHaveLength(resetsBefore + 1);
    const afterEmptyCompaction = await transform?.({ type: "context", messages: rawMessages }, context);
    if (!isUnknownRecord(afterEmptyCompaction) || !Array.isArray(afterEmptyCompaction.messages)) {
      throw new Error("Context handler returned no messages.");
    }

    selections.push("Enable manual mode");
    const panelCommand = extension?.commands.get("dcp");
    if (!panelCommand) throw new Error("DCP panel command was not registered.");
    await Reflect.apply(panelCommand.handler, panelCommand, ["", context]);
    const manualCall = () => Reflect.apply(compress.execute, compress, [
      "manual-compress-call",
      {
        topic: "manual",
        content: [{ startId: "m0001", endId: "m0002", summary: "Manual summary." }],
      },
      undefined,
      undefined,
      context,
    ]);
    await expect(manualCall()).rejects.toThrow("requires /dcp-compress");
    const compressCommand = extension?.commands.get("dcp-compress");
    if (!compressCommand) throw new Error("DCP compress command was not registered.");
    await Reflect.apply(compressCommand.handler, compressCommand, ["", context]);
    const agentEnd = extension?.handlers.get("agent_end")?.[0];
    await agentEnd?.({ type: "agent_end", messages: [], willContinue: true }, context);
    await expect(manualCall()).resolves.toMatchObject({ content: [{ type: "text" }] });
    await compact?.({ type: "session_compact", compactionEntry: {}, fromExtension: false }, context);
    await transform?.({ type: "context", messages: rawMessages }, context);
    await Reflect.apply(compressCommand.handler, compressCommand, ["", context]);
    await agentEnd?.({ type: "agent_end", messages: [] }, context);
    await expect(manualCall()).rejects.toThrow("requires /dcp-compress");
    await Reflect.apply(compressCommand.handler, compressCommand, ["", context]);
    await expect(manualCall()).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(statuses.at(-1)).toContain("DCP");

    const forkContext = {
      ...context,
      sessionManager: {
        ...context.sessionManager,
        getHeader: () => ({ parentSession: "ordinary-fork" }),
      },
    };
    await sessionStart?.({ type: "session_start", reason: "startup" }, forkContext);
    expect(activeTools).toContain("compress");

    const subagentContext = {
      ...context,
      sessionManager: {
        ...context.sessionManager,
        getHeader: () => ({ parentSession: "ordinary-fork" }),
        getBranch: () => [
          {
            type: "session_init",
            id: "subagent-init",
            parentId: null,
            timestamp: new Date().toISOString(),
            systemPrompt: "Subagent",
            task: "Work",
            tools: ["read"],
          },
          ...branch,
          ...persisted,
        ],
      },
    };
    await sessionStart?.({ type: "session_start", reason: "startup" }, subagentContext);
    expect(activeTools).not.toContain("compress");
    expect(await transform?.({ type: "context", messages: rawMessages }, subagentContext)).toBeUndefined();
  });

  test("does not register compress when permission is deny", async () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "dcp.jsonc"), '{ "compress": { "permission": "deny" } }');
    const extensionModule = join(root, "denied-extension.ts");
    const source = resolve("src/extension.ts");
    writeFileSync(extensionModule, [
      `import { registerDynamicContextPruning } from ${JSON.stringify(source)};`,
      "export default function (pi) {",
      `  registerDynamicContextPruning(pi, { cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(agentDir)}, createGlobalConfig: false });`,
      "}",
    ].join("\n"));

    const loaded = await loadExtensions([extensionModule], root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions[0]?.tools.has("compress")).toBe(false);
    expect(loaded.extensions[0]?.commands.has("dcp-compress")).toBe(false);
    const beforeAgent = loaded.extensions[0]?.handlers.get("before_agent_start")?.[0];
    const result = await beforeAgent?.(
      { type: "before_agent_start", prompt: "Work", systemPrompt: ["Base"] },
      { sessionManager: { getBranch: () => [] } },
    );
    expect(result).toBeUndefined();
    loaded.runtime.appendEntry = () => {};
    const rawMessage = userMessage("No compression", 1);
    const contextHandler = loaded.extensions[0]?.handlers.get("context")?.[0];
    if (!contextHandler) throw new Error("DCP context handler was not registered.");
    const deniedContext = await Reflect.apply(contextHandler, contextHandler, [
      { type: "context", messages: [rawMessage] },
      {
        model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
        getContextUsage: () => ({ tokens: 1, contextWindow: 200_000, percent: 0 }),
        sessionManager: {
          getBranch: () => [{
            type: "message",
            id: "denied-message",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: rawMessage,
          }],
          getSessionId: () => "denied-session",
        },
        ui: { setStatus: () => {}, notify: () => {} },
      },
    ]);
    expect(JSON.stringify(deniedContext)).not.toContain("<dcp-message-id");
  });
});
