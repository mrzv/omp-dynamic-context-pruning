import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildCompressionBlocks } from "./compress/apply.ts";
import { prepareMessageCompression } from "./compress/message.ts";
import {
  listCompressionTargets,
  planDecompress,
  planRecompress,
  selectSweepTools,
} from "./compress/operations.ts";
import { buildPriorityMap, priorityTags } from "./compress/priority.ts";
import { prepareRangeCompression } from "./compress/range.ts";
import { buildCompressionSearchContext } from "./compress/search.ts";
import { applyCompressedContext } from "./compress/transform.ts";
import type {
  CompressMessageArgs,
  CompressRangeArgs,
  CompressionProtectionOptions,
  PreparedCompression,
} from "./compress/types.ts";
import {
  CORE_PROTECTED_TOOLS,
  loadConfig,
  modelThreshold,
  type DcpConfig,
} from "./config.ts";
import {
  assignStableReferences,
  MessageEntryAssociationCache,
} from "./messages/identity.ts";
import {
  buildLogicalMessages,
  cloneLogicalMessagesForProjection,
  type LogicalMessage,
} from "./messages/logical-messages.ts";
import {
  capturePruneNotificationItems,
  emptyPruneNotification,
  formatCompactTokenCount,
  formatCompressionNotification,
  formatPruneNotification,
  truncateToastNotification,
  type PendingPruneNotification,
} from "./notifications.ts";
import { injectMessageMetadata, stripDcpMetadata } from "./messages/metadata.ts";
import { assertValidToolPairing } from "./messages/pairing.ts";
import { MANUAL_MODE_PROMPT, PromptStore, SUBAGENT_PROMPT } from "./prompts/store.ts";
import { appendMutation, restoreStateFromBranch } from "./state/persistence.ts";
import { applyMutation } from "./state/runtime.ts";
import { rebuildToolCache, ToolRecordCache } from "./state/tool-cache.ts";
import type {
  BlockActivationChange,
  PersistedMutation,
  PrunedToolRecord,
  RuntimeState,
} from "./state/types.ts";
import { selectAutomaticPrunes, type PruningStrategyConfig } from "./strategies/pruning.ts";
import { applySelectedToolPruning } from "./strategies/transform.ts";

import { countMessagesTokens } from "./token-utils.ts";
import { isUnknownRecord } from "./type-guards.ts";
export interface RegisterDcpOptions {
  cwd?: string;
  agentDir?: string;
  createGlobalConfig?: boolean;
}

const NOTIFICATION_TYPE = "dev.ohmypi.dcp.notification.v1";
const STATUS_KEY = "dcp";
const CONTEXT_SLICE_BUDGET_MS = 8;
const SLOW_CONTEXT_TRANSFORM_MS = 100;

class EventLoopBudget {
  private sliceStartedAt = performance.now();
  yields = 0;
  yieldMs = 0;

  async checkpoint(): Promise<void> {
    if (performance.now() - this.sliceStartedAt < CONTEXT_SLICE_BUDGET_MS) return;
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    this.yields += 1;
    this.yieldMs += performance.now() - startedAt;
    this.sliceStartedAt = performance.now();
  }
}

interface RuntimeController {
  config: DcpConfig;
  prompts: PromptStore;
  state: RuntimeState;
  latestGroups: LogicalMessage[];
  requestSequence: number;
  mutationTail: Promise<void>;
  manualCompressionGrants: number;
  reportedPromptWarnings: Set<string>;
  messageAssociations: MessageEntryAssociationCache;
  toolRecords: ToolRecordCache;
  pendingPruneNotification: PendingPruneNotification;
  pruneNotificationGeneration: number;
}

function isDcpNotification(message: AgentMessage): boolean {
  return message.role === "custom"
    && isUnknownRecord(message)
    && message.customType === NOTIFICATION_TYPE;
}

function isSubagent(context: ExtensionContext): boolean {
  return context.sessionManager.getBranch().some((entry) => entry.type === "session_init");
}

function pruningConfig(config: DcpConfig): PruningStrategyConfig {
  return {
    automaticInManualMode: config.manualMode.automaticStrategies,
    protectedFilePatterns: config.protectedFilePatterns,
    turnProtection: config.turnProtection,
    deduplication: {
      enabled: config.strategies.deduplication.enabled,
      protectedTools: [...new Set([...CORE_PROTECTED_TOOLS, ...config.strategies.deduplication.protectedTools])],
    },
    purgeErrors: {
      enabled: config.strategies.purgeErrors.enabled,
      turns: config.strategies.purgeErrors.turns,
      protectedTools: [...new Set([...CORE_PROTECTED_TOOLS, ...config.strategies.purgeErrors.protectedTools])],
    },
  };
}

function protectionOptions(config: DcpConfig): CompressionProtectionOptions {
  return {
    protectUserMessages: config.compress.protectUserMessages,
    protectTags: config.compress.protectTags,
    protectedTools: config.compress.protectedTools,
    protectedFilePatterns: config.protectedFilePatterns,
  };
}

function persist(pi: ExtensionAPI, state: RuntimeState, mutation: PersistedMutation): void {
  appendMutation(pi, mutation);
  applyMutation(state, mutation);
}

function restoreController(controller: RuntimeController, context: ExtensionContext): void {
  controller.manualCompressionGrants = 0;
  controller.state = restoreStateFromBranch(
    context.sessionManager.getBranch(),
    controller.config.manualMode.enabled,
    context.sessionManager.getSessionId(),
  );
  controller.latestGroups = [];
  controller.requestSequence = 0;
  controller.messageAssociations.reset();
  controller.toolRecords.clear();
  resetPendingPruneNotification(controller);
}

function synchronizeReferences(
  pi: ExtensionAPI,
  state: RuntimeState,
  groups: LogicalMessage[],
): void {
  const next = {
    byKey: new Map(state.references.byKey),
    byRef: new Map(state.references.byRef),
    nextRef: state.references.nextRef,
  };
  assignStableReferences(groups, next);
  const assignments = [...next.byKey]
    .filter(([key]) => !state.references.byKey.has(key))
    .map(([key, ref]) => ({ key, ref }));
  if (assignments.length > 0) {
    persist(pi, state, {
      version: 1,
      at: Date.now(),
      kind: "references-assigned",
      assignments,
      nextRef: next.nextRef,
    });
  }
  for (const group of groups) {
    if (group.key) {
      const reference = next.byKey.get(group.key);
      if (reference) group.ref = reference;
      else delete group.ref;
    }
  }
}

function buildProtectedToolsPrompt(config: DcpConfig): string {
  if (config.compress.protectedTools.length === 0) return "";
  const names = config.compress.protectedTools.map((name) => `\`${name}\``).join(", ");
  return `<dcp-system-reminder>\nThe environment preserves outputs from ${names} during compression. Do not duplicate those outputs in summaries.\n</dcp-system-reminder>`;
}

function notify(
  pi: ExtensionAPI,
  context: ExtensionContext,
  config: DcpConfig,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (config.pruneNotification === "off") return;
  if (config.pruneNotificationType === "toast" || !context.hasUI) {
    context.ui.notify(truncateToastNotification(message), level);
    return;
  }
  pi.sendMessage(
    {
      customType: NOTIFICATION_TYPE,
      content: message,
      display: true,
      details: { level },
      attribution: "agent",
    },
    { deliverAs: "nextTurn" },
  );
}
function invalidateScheduledPruneNotification(controller: RuntimeController): void {
  controller.pruneNotificationGeneration += 1;
}

function resetPendingPruneNotification(controller: RuntimeController): void {
  invalidateScheduledPruneNotification(controller);
  controller.pendingPruneNotification = emptyPruneNotification();
}

function queuePruneNotification(
  controller: RuntimeController,
  records: readonly PrunedToolRecord[],
  workingDirectory: string,
): void {
  controller.pendingPruneNotification.items.push(
    ...capturePruneNotificationItems(records, controller.state.toolCalls, workingDirectory),
  );
  controller.pendingPruneNotification.tokens += records.reduce(
    (total, record) => total + record.tokenCount,
    0,
  );
}

function flushPruneNotification(
  pi: ExtensionAPI,
  controller: RuntimeController,
  context: ExtensionContext,
): void {
  const pending = controller.pendingPruneNotification;
  controller.pendingPruneNotification = emptyPruneNotification();
  if (controller.config.pruneNotification === "off" || pending.items.length === 0) return;
  const message = formatPruneNotification(
    pending,
    controller.state.stats.totalPruneTokens,
    controller.config.pruneNotification,
  );
  if (controller.config.pruneNotificationType === "toast" || !context.hasUI) {
    notify(pi, context, controller.config, message);
    return;
  }

  const generation = controller.pruneNotificationGeneration;
  const sessionId = context.sessionManager.getSessionId();
  const deliverWhenIdle = (): void => {
    if (
      generation !== controller.pruneNotificationGeneration
      || sessionId !== context.sessionManager.getSessionId()
    ) return;
    if (!context.isIdle()) {
      context.setTimeout(deliverWhenIdle, 25);
      return;
    }
    notify(pi, context, controller.config, message);
  };
  context.setTimeout(deliverWhenIdle, 0);
}

function reloadPrompts(
  pi: ExtensionAPI,
  controller: RuntimeController,
  context: ExtensionContext | ExtensionCommandContext,
  reportRepeatedWarnings = false,
): string[] {
  controller.prompts.reload();
  const warnings = [...controller.prompts.warnings];
  const currentWarnings = new Set(warnings);
  for (const warning of warnings) {
    if (!reportRepeatedWarnings && controller.reportedPromptWarnings.has(warning)) continue;
    context.ui.notify(`DCP: ${warning}`, "warning");
    pi.logger.warn("DCP prompt warning", { warning });
  }
  controller.reportedPromptWarnings = currentWarnings;
  return warnings;
}

function compactStatusText(state: RuntimeState): string {
  return `DCP −${formatCompactTokenCount(state.stats.totalPruneTokens)}`;
}

function statusText(state: RuntimeState, usage?: { tokens: number; contextWindow: number }): string {
  const saved = Math.round(state.stats.totalPruneTokens).toLocaleString();
  if (!usage) return `DCP −${saved}`;
  const percent = usage.contextWindow > 0 ? Math.round(usage.tokens / usage.contextWindow * 100) : 0;
  return `DCP ${percent}% · −${saved}`;
}

function hasMessageReference(message: AgentMessage, reference: string): boolean {
  const marker = `>${reference}</dcp-message-id>`;
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content.includes(marker);
    return message.content.some((part) => part.type === "text" && part.text.includes(marker));
  }
  if (message.role === "assistant" || message.role === "toolResult") {
    return message.content.some((part) => part.type === "text" && part.text.includes(marker));
  }
  return false;
}

function findNudgeTargetIndex(
  messages: readonly AgentMessage[],
  reference: string,
  targetRole: "user" | "assistant",
): number {
  const taggedIndex = messages.findLastIndex((message) => hasMessageReference(message, reference));
  const tagged = messages[taggedIndex];
  if (tagged?.role === targetRole) return taggedIndex;
  if (targetRole !== "assistant" || tagged?.role !== "toolResult") return -1;
  for (let index = taggedIndex - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.content.some((part) => part.type === "toolCall" && part.id === tagged.toolCallId)) return index;
  }
  return -1;
}

function appendNudge(
  pi: ExtensionAPI,
  controller: RuntimeController,
  context: ExtensionContext,
  messages: AgentMessage[],
  groups: readonly LogicalMessage[],
): void {
  if (controller.state.manualMode || controller.config.compress.permission === "deny") return;
  const lastGroup = groups.at(-1);
  if (!lastGroup?.ref) return;
  const usage = context.getContextUsage();
  const contextWindow = usage?.contextWindow ?? context.model?.contextWindow ?? undefined;
  const tokens = usage?.tokens ?? countMessagesTokens(messages);
  const provider = context.model?.provider;
  const model = context.model?.id;
  const minimum = modelThreshold(controller.config, "min", provider, model, contextWindow);
  const summaryBuffer = controller.config.compress.summaryBuffer
    ? [...controller.state.activeBlockIds].reduce((total, blockId) => total + (controller.state.blocks.get(blockId)?.summaryTokens ?? 0), 0)
    : 0;
  const maximum = modelThreshold(controller.config, "max", provider, model, contextWindow) + summaryBuffer;
  const nextAnchors = {
    contextLimit: [...controller.state.nudges.contextLimitAnchors],
    turn: [...controller.state.nudges.turnAnchors],
    iteration: [...controller.state.nudges.iterationAnchors],
  };
  let nudge: string | undefined;
  let targetRole: "user" | "assistant" | undefined;
  let targetRef: string | undefined;
  let changed = false;

  if (tokens < minimum) {
    if (nextAnchors.turn.length === 0 && nextAnchors.iteration.length === 0) return;
    nextAnchors.turn = [];
    nextAnchors.iteration = [];
    changed = true;
  } else if (tokens >= maximum) {
    nudge = controller.prompts.get("context-limit-nudge");
    const addAnchor = nextAnchors.contextLimit.length === 0
      || controller.requestSequence % controller.config.compress.nudgeFrequency === 0;
    const anchorGroup = addAnchor
      ? lastGroup
      : groups.findLast(
        (group) => group.ref !== undefined && controller.state.nudges.contextLimitAnchors.has(group.ref),
      ) ?? lastGroup;
    targetRole = anchorGroup.kind === "user" ? "user" : anchorGroup.kind === "assistant" ? "assistant" : undefined;
    targetRef = anchorGroup.ref;
    if (addAnchor && !controller.state.nudges.contextLimitAnchors.has(lastGroup.ref)) {
      nextAnchors.contextLimit.push(lastGroup.ref);
      changed = true;
    }
  } else if (lastGroup.kind === "user") {
    const soft = controller.config.compress.nudgeForce === "soft";
    const anchorGroup = soft
      ? groups.findLast((group) => group.kind === "assistant" && group.ref !== undefined)
      : lastGroup;
    if (anchorGroup?.ref) {
      nudge = controller.prompts.get("turn-nudge");
      targetRole = soft ? "assistant" : "user";
      targetRef = anchorGroup.ref;
      if (!controller.state.nudges.turnAnchors.has(anchorGroup.ref)) {
        nextAnchors.turn.push(anchorGroup.ref);
        changed = true;
      }
    }
  } else {
    let iterations = 0;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (!group || group.kind === "user") break;
      if (group.kind === "assistant") iterations += 1;
    }
    if (iterations >= controller.config.compress.iterationNudgeThreshold) {
      nudge = controller.prompts.get("iteration-nudge");
      targetRole = lastGroup.kind === "assistant" ? "assistant" : undefined;
      targetRef = lastGroup.ref;
      const addAnchor = nextAnchors.iteration.length === 0
        || controller.requestSequence % controller.config.compress.nudgeFrequency === 0;
      if (addAnchor && !controller.state.nudges.iterationAnchors.has(lastGroup.ref)) {
        nextAnchors.iteration.push(lastGroup.ref);
        changed = true;
      }
    }
  }
  if (!nudge && tokens >= minimum) {
    const anchoredTurn = groups.findLast(
      (group) => group.ref !== undefined && controller.state.nudges.turnAnchors.has(group.ref),
    );
    const anchoredIteration = groups.findLast(
      (group) => group.ref !== undefined && controller.state.nudges.iterationAnchors.has(group.ref),
    );
    if (anchoredTurn?.ref) {
      nudge = controller.prompts.get("turn-nudge");
      targetRef = anchoredTurn.ref;
      targetRole = controller.config.compress.nudgeForce === "soft" ? "assistant" : "user";
    } else if (anchoredIteration?.ref) {
      nudge = controller.prompts.get("iteration-nudge");
      targetRef = anchoredIteration.ref;
      targetRole = "assistant";
    }
  }


  let injected = false;
  if (nudge && targetRole && targetRef) {
    const targetIndex = findNudgeTargetIndex(messages, targetRef, targetRole);
    const target = messages[targetIndex];
    if (target?.role === "user") {
      const updated = {
        ...target,
        content: typeof target.content === "string"
          ? `${target.content}\n\n${nudge}`
          : [...target.content, { type: "text" as const, text: nudge }],
      };
      delete updated.providerPayload;
      messages[targetIndex] = updated;
      injected = true;
    } else if (target?.role === "assistant") {
      let appended = false;
      const content = target.content.map((part) => {
        if (!appended && part.type === "text") {
          appended = true;
          return { ...part, text: `${part.text}\n\n${nudge}` };
        }
        return part;
      });
      if (!appended) {
        const toolIndex = content.findIndex((part) => part.type === "toolCall");
        content.splice(toolIndex >= 0 ? toolIndex : content.length, 0, { type: "text", text: nudge });
      }
      const updated = { ...target, content };
      delete updated.providerPayload;
      messages[targetIndex] = updated;
      injected = true;
    }
  }
  if (nudge && !injected) {
    messages.push({
      role: "user",
      content: nudge,
      timestamp: Date.now(),
      synthetic: true,
      attribution: "agent",
    });
  }
  if (changed) {
    persist(pi, controller.state, {
      version: 1,
      at: Date.now(),
      kind: "nudge-anchors",
      ...nextAnchors,
    });
  }
}

async function serializeMutation<T>(controller: RuntimeController, action: () => Promise<T> | T): Promise<T> {
  const previous = controller.mutationTail;
  let release: (() => void) | undefined;
  controller.mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release?.();
  }
}

function compressionResultText(blocks: readonly { blockId: number; compressedTokens: number }[], issues: readonly string[]): string {
  const ids = blocks.map((block) => `b${block.blockId}`).join(", ");
  const tokens = blocks.reduce((total, block) => total + block.compressedTokens, 0);
  const lines = blocks.length > 0
    ? [`Compressed ${blocks.length} block${blocks.length === 1 ? "" : "s"} (${ids}); ${Math.round(tokens)} tokens removed.`]
    : ["No messages were compressed."];
  if (issues.length > 0) lines.push(`Skipped: ${issues.join(" ")}`);
  return lines.join("\n");
}

function registerCompressTool(pi: ExtensionAPI, controller: RuntimeController): void {

function normalizeRangeArgs(value: unknown): CompressRangeArgs {
  if (!isUnknownRecord(value) || typeof value.topic !== "string" || !Array.isArray(value.content)) {
    throw new Error("Invalid range compression arguments.");
  }
  const content: CompressRangeArgs["content"] = [];
  for (const entry of value.content) {
    if (
      !isUnknownRecord(entry)
      || typeof entry.startId !== "string"
      || typeof entry.endId !== "string"
      || typeof entry.summary !== "string"
    ) throw new Error("Invalid range compression entry.");
    content.push({ startId: entry.startId, endId: entry.endId, summary: entry.summary });
  }
  return { topic: value.topic, content };
}

function normalizeMessageArgs(value: unknown): CompressMessageArgs {
  if (!isUnknownRecord(value) || typeof value.topic !== "string" || !Array.isArray(value.content)) {
    throw new Error("Invalid message compression arguments.");
  }
  const content: CompressMessageArgs["content"] = [];
  for (const entry of value.content) {
    if (
      !isUnknownRecord(entry)
      || typeof entry.messageId !== "string"
      || typeof entry.topic !== "string"
      || typeof entry.summary !== "string"
    ) throw new Error("Invalid message compression entry.");
    content.push({ messageId: entry.messageId, topic: entry.topic, summary: entry.summary });
  }
  return { topic: value.topic, content };
}
  if (controller.config.compress.permission === "deny") return;
  const z = pi.zod;
  const range = controller.config.compress.mode === "range";
  const parameters = range
    ? z.object({
      topic: z.string().describe("Short topic for this compression batch"),
      content: z.array(z.object({
        startId: z.string().describe("First visible mNNNN or bN boundary"),
        endId: z.string().describe("Last visible mNNNN or bN boundary"),
        summary: z.string().describe("High-fidelity technical summary"),
      })).min(1),
    })
    : z.object({
      topic: z.string().describe("Short topic for this compression batch"),
      content: z.array(z.object({
        messageId: z.string().describe("One visible mNNNN message ID"),
        topic: z.string().describe("Short topic for this message"),
        summary: z.string().describe("High-fidelity technical summary"),
      })).min(1),
    });
  const permission = controller.config.compress.permission;

  pi.registerTool({
    name: "compress",
    label: "Compress",
    get description() {
      return controller.prompts.get(range ? "compress-range" : "compress-message");
    },
    parameters,
    loadMode: "essential",
    approval: {
      tier: "read",
      policy: permission === "ask" ? "prompt" : "allow",
      override: permission === "ask",
      reason: "Compression changes the model-visible context for this session.",
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, context) {
      return serializeMutation(controller, () => {
        if (isSubagent(context) && !controller.config.experimental.allowSubAgents) {
          throw new Error("DCP compression is disabled in subagent sessions.");
        }
        if (controller.state.manualMode) {
          if (controller.manualCompressionGrants < 1) {
            throw new Error("Manual mode requires /dcp-compress before a compress tool call.");
          }
          controller.manualCompressionGrants -= 1;
        }
        if (controller.latestGroups.length === 0) throw new Error("No model-visible context is available to compress.");
        const search = buildCompressionSearchContext(controller.state, controller.latestGroups);
        const startedAt = Date.now();
        let prepared: PreparedCompression[];
        let issues: string[] = [];
        if (range) {
          prepared = prepareRangeCompression(
            normalizeRangeArgs(rawParams),
            search,
            controller.state,
            protectionOptions(controller.config),
          );
        } else {
          const result = prepareMessageCompression(
            normalizeMessageArgs(rawParams),
            search,
            controller.state,
            protectionOptions(controller.config),
          );
          prepared = result.prepared;
          issues = result.issues;
        }
        const blocks = buildCompressionBlocks(controller.state, prepared, Date.now() - startedAt);
        if (blocks.length > 0) {
          persist(pi, controller.state, {
            version: 1,
            at: Date.now(),
            kind: "compression-created",
            blocks,
          });
        }
        const text = compressionResultText(blocks, issues);
        if (blocks.length > 0 && controller.config.pruneNotification !== "off") {
          const notification = formatCompressionNotification(
            controller.state,
            blocks,
            controller.latestGroups,
            controller.config.pruneNotification,
            controller.config.compress.showCompression,
          );
          context.ui.notify(truncateToastNotification(notification), "info");
        }
        context.ui.setStatus(STATUS_KEY, compactStatusText(controller.state));
        return { content: [{ type: "text" as const, text }], details: { blocks, issues } };
      });
    },
  });
}

function parseBlockId(argument: string): number | undefined {
  const match = /^b?([1-9]\d*)$/i.exec(argument.trim());
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

function applyActivation(
  pi: ExtensionAPI,
  controller: RuntimeController,
  changes: BlockActivationChange[],
): void {
  if (changes.length === 0) return;
  persist(pi, controller.state, {
    version: 1,
    at: Date.now(),
    kind: "blocks-activation",
    changes,
  });
}

async function chooseBlock(
  context: ExtensionCommandContext,
  controller: RuntimeController,
  active: boolean,
): Promise<number | undefined> {
  const targets = listCompressionTargets(controller.state, active);
  if (targets.length === 0) {
    context.ui.notify(active ? "No active DCP compression blocks." : "No user-decompressed DCP blocks.", "info");
    return undefined;
  }
  const labels = targets.map((target) => {
    const tokens = target.blocks.reduce((total, block) => total + block.compressedTokens, 0);
    return `b${target.displayId} · ${target.topic} · ${Math.round(tokens)} tokens`;
  });
  const selected = await context.ui.select(active ? "Decompress block" : "Recompress block", labels);
  const index = selected ? labels.indexOf(selected) : -1;
  return index >= 0 ? targets[index]?.displayId : undefined;
}

async function runDecompressCommand(
  pi: ExtensionAPI,
  controller: RuntimeController,
  argument: string,
  context: ExtensionCommandContext,
): Promise<void> {
  const blockId = parseBlockId(argument) ?? await chooseBlock(context, controller, true);
  if (!blockId) return;
  await serializeMutation(controller, () => {
    try {
      applyActivation(pi, controller, planDecompress(controller.state, blockId));
      notify(pi, context, controller.config, `Decompressed b${blockId}.`);
    } catch (error) {
      context.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });
}

async function runRecompressCommand(
  pi: ExtensionAPI,
  controller: RuntimeController,
  argument: string,
  context: ExtensionCommandContext,
): Promise<void> {
  const blockId = parseBlockId(argument) ?? await chooseBlock(context, controller, false);
  if (!blockId) return;
  await serializeMutation(controller, () => {
    try {
      applyActivation(pi, controller, planRecompress(controller.state, blockId));
      notify(pi, context, controller.config, `Recompressed b${blockId}.`);
    } catch (error) {
      context.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });
}

async function runSweepCommand(
  pi: ExtensionAPI,
  controller: RuntimeController,
  argument: string,
  context: ExtensionCommandContext,
): Promise<void> {
  await serializeMutation(controller, () => {
    if (controller.latestGroups.length === 0) {
      context.ui.notify("No model-visible context is available to sweep.", "warning");
      return;
    }
    const rawCount = argument.trim();
    const requested = rawCount ? (/^\d+$/.test(rawCount) ? Number(rawCount) : Number.NaN) : undefined;
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
      context.ui.notify("Usage: /dcp-sweep [positive tool count]", "error");
      return;
    }
    rebuildToolCache(
      controller.state,
      controller.latestGroups,
      controller.toolRecords,
      (entryId) => controller.messageAssociations.fingerprintForEntryId(entryId),
    );
    const records = selectSweepTools(
      controller.state,
      controller.latestGroups,
      {
        protectedTools: controller.config.commands.protectedTools,
        protectedFilePatterns: controller.config.protectedFilePatterns,
        ...(requested ? { lastN: requested } : {}),
      },
    );
    if (records.length > 0) {
      persist(pi, controller.state, {
        version: 1,
        at: Date.now(),
        kind: "tools-pruned",
        records,
      });
    }
    notify(pi, context, controller.config, `Swept ${records.length} tool output${records.length === 1 ? "" : "s"}.`);
  });
}

async function openPanel(
  pi: ExtensionAPI,
  controller: RuntimeController,
  context: ExtensionCommandContext,
): Promise<void> {
  if (!context.hasUI) {
    context.ui.notify(statusText(controller.state, context.getContextUsage()), "info");
    return;
  }
  for (;;) {
    const state = controller.state;
    const active = listCompressionTargets(state, true).length;
    const title = `${statusText(state, context.getContextUsage())} · ${active} active block${active === 1 ? "" : "s"}`;
    const toggle = state.manualMode ? "Disable manual mode" : "Enable manual mode";
    const reloadOption = controller.config.experimental.customPrompts
      ? "Reload prompt overrides"
      : "Prompt overrides disabled";
    const selected = await context.ui.select(title, [
      toggle,
      "Decompress block",
      "Recompress block",
      "Sweep tool outputs",
      reloadOption,
      "Close",
    ]);
    if (!selected || selected === "Close") return;
    if (selected === toggle) {
      await serializeMutation(controller, () => {
        const currentState = controller.state;
        persist(pi, currentState, { version: 1, at: Date.now(), kind: "manual-mode", enabled: !currentState.manualMode });
        if (!currentState.manualMode) controller.manualCompressionGrants = 0;
      });
      continue;
    }
    if (selected === "Decompress block") await runDecompressCommand(pi, controller, "", context);
    else if (selected === "Recompress block") await runRecompressCommand(pi, controller, "", context);
    else if (selected === "Sweep tool outputs") await runSweepCommand(pi, controller, "", context);
    else if (selected === reloadOption) {
      if (!controller.config.experimental.customPrompts) {
        context.ui.notify("DCP custom prompt overrides are disabled. Set experimental.customPrompts to true.", "warning");
        continue;
      }
      const warnings = reloadPrompts(pi, controller, context, true);
      context.ui.notify(
        warnings.length === 0
          ? "DCP prompt overrides reloaded."
          : `DCP prompt overrides reloaded with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
        warnings.length === 0 ? "info" : "warning",
      );
    }
  }
}

function registerCommands(pi: ExtensionAPI, controller: RuntimeController): void {
  if (!controller.config.commands.enabled) return;
  pi.registerCommand("dcp", {
    description: "Open DCP context statistics and controls",
    handler: async (_args, context) => openPanel(pi, controller, context),
  });
  if (controller.config.compress.permission !== "deny") {
    pi.registerCommand("dcp-compress", {
      description: "Ask the model to run one DCP compression pass",
      handler: async (args, context) => {
        await context.waitForIdle();
        const focus = args.trim() ? ` Focus on: ${args.trim()}` : "";
        pi.sendUserMessage(`<compress triggered manually> Run exactly one safe compression pass.${focus}`);
        if (controller.state.manualMode) controller.manualCompressionGrants += 1;
      },
    });
  }
  pi.registerCommand("dcp-decompress", {
    description: "Restore one active DCP block",
    handler: async (args, context) => runDecompressCommand(pi, controller, args, context),
  });
  pi.registerCommand("dcp-recompress", {
    description: "Reactivate one user-decompressed DCP block",
    handler: async (args, context) => runRecompressCommand(pi, controller, args, context),
  });
  pi.registerCommand("dcp-sweep", {
    description: "Prune tool outputs since the latest user turn or the last N tools",
    handler: async (args, context) => runSweepCommand(pi, controller, args, context),
  });
  pi.registerCommand("dcp-stats", {
    description: "Show DCP token and compression statistics",
    handler: async (_args, context) => {
      const stats = controller.state.stats;
      context.ui.notify(
        `${statusText(controller.state, context.getContextUsage())}; ${stats.totalToolsPruned} tools pruned; ${stats.totalMessagesCompressed} messages compressed.`,
        "info",
      );
    },
  });
}

export function registerDynamicContextPruning(
  pi: ExtensionAPI,
  options: RegisterDcpOptions = {},
): void {
  const cwd = options.cwd ?? process.cwd();
  const loaded = loadConfig(cwd, {
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.createGlobalConfig !== undefined ? { createGlobal: options.createGlobalConfig } : {}),
  });
  const controller: RuntimeController = {
    config: loaded.config,
    prompts: new PromptStore(cwd, {
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      enabled: loaded.config.experimental.customPrompts,
      ...(options.createGlobalConfig !== undefined ? { createDefaults: options.createGlobalConfig } : {}),
    }),
    state: restoreStateFromBranch([], loaded.config.manualMode.enabled),
    latestGroups: [],
    messageAssociations: new MessageEntryAssociationCache(),
    toolRecords: new ToolRecordCache(),
    requestSequence: 0,
    mutationTail: Promise.resolve(),
    manualCompressionGrants: 0,
    reportedPromptWarnings: new Set(),
    pendingPruneNotification: emptyPruneNotification(),
    pruneNotificationGeneration: 0,
  };
  pi.setLabel("Dynamic Context Pruning");
  if (!controller.config.enabled) return;

  registerCompressTool(pi, controller);
  registerCommands(pi, controller);

  const restore = async (_event: unknown, context: ExtensionContext): Promise<void> => {
    await serializeMutation(controller, () => restoreController(controller, context));
    const subagentDisabled = isSubagent(context) && !controller.config.experimental.allowSubAgents;
    if (controller.config.compress.permission !== "deny") {
      const active = pi.getActiveTools();
      const next = subagentDisabled
        ? active.filter((name) => name !== "compress")
        : [...new Set([...active, "compress"])];
      if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
        await pi.setActiveTools(next);
      }
    }
    context.ui.setStatus(STATUS_KEY, subagentDisabled ? undefined : compactStatusText(controller.state));
    for (const warning of loaded.warnings) {
      context.ui.notify(`DCP: ${warning}`, "warning");
      pi.logger.warn("DCP configuration warning", { warning });
    }
    for (const warning of controller.prompts.warnings) {
      context.ui.notify(`DCP: ${warning}`, "warning");
      pi.logger.warn("DCP prompt warning", { warning });
    }
    controller.reportedPromptWarnings = new Set(controller.prompts.warnings);
  };

  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_branch", restore);
  pi.on("session_tree", restore);

  pi.on("agent_start", () => serializeMutation(controller, () => {
    invalidateScheduledPruneNotification(controller);
  }));

  pi.on("before_agent_start", async (event, context) => {
    if (isSubagent(context) && !controller.config.experimental.allowSubAgents) return;
    if (controller.config.compress.permission === "deny") return;
    reloadPrompts(pi, controller, context);
    const additions = [controller.prompts.get("system")];
    if (controller.state.manualMode) additions.push(MANUAL_MODE_PROMPT);
    if (isSubagent(context)) additions.push(SUBAGENT_PROMPT);
    const protectedToolsPrompt = buildProtectedToolsPrompt(controller.config);
    if (protectedToolsPrompt) additions.push(protectedToolsPrompt);
    return { systemPrompt: [...event.systemPrompt, ...additions] };
  });

  pi.on("context", (event, context) => serializeMutation(controller, async () => {
    if (isSubagent(context) && !controller.config.experimental.allowSubAgents) return;
    const startedAt = performance.now();
    const budget = new EventLoopBudget();
    const phases: Record<string, number> = {};
    controller.requestSequence += 1;

    let phaseStartedAt = performance.now();
    reloadPrompts(pi, controller, context);
    phases.prompts = performance.now() - phaseStartedAt;

    phaseStartedAt = performance.now();
    const sourceMessages = event.messages.filter((message) => !isDcpNotification(message));
    const association = controller.messageAssociations.associate(
      sourceMessages,
      context.sessionManager.getBranch(),
    );
    phases.association = performance.now() - phaseStartedAt;
    await budget.checkpoint();

    phaseStartedAt = performance.now();
    const messages = structuredClone(sourceMessages);
    stripDcpMetadata(messages);
    phases.clone = performance.now() - phaseStartedAt;
    await budget.checkpoint();

    phaseStartedAt = performance.now();
    const groups = buildLogicalMessages(messages, association.entryIds);
    synchronizeReferences(pi, controller.state, groups);
    phases.grouping = performance.now() - phaseStartedAt;

    phaseStartedAt = performance.now();
    const toolCache = rebuildToolCache(
      controller.state,
      groups,
      controller.toolRecords,
      (entryId) => controller.messageAssociations.fingerprintForEntryId(entryId),
    );
    phases.toolCache = performance.now() - phaseStartedAt;
    await budget.checkpoint();

    phaseStartedAt = performance.now();
    const selected = selectAutomaticPrunes(controller.state, pruningConfig(controller.config));
    if (selected.length > 0) {
      persist(pi, controller.state, {
        version: 1,
        at: Date.now(),
        kind: "tools-pruned",
        records: selected,
      });
      queuePruneNotification(controller, selected, context.cwd);
    }
    applySelectedToolPruning(groups, controller.state);
    controller.latestGroups = groups;
    phases.pruning = performance.now() - phaseStartedAt;
    await budget.checkpoint();

    phaseStartedAt = performance.now();
    const projectionGroups = cloneLogicalMessagesForProjection(groups);
    if (controller.config.compress.permission !== "deny") {
      const priorities = buildPriorityMap(
        projectionGroups,
        controller.state,
        controller.config.compress.mode === "message",
        controller.config.compress.protectUserMessages,
      );
      injectMessageMetadata(projectionGroups, priorityTags(priorities));
    }
    const transformed = applyCompressedContext(
      projectionGroups,
      controller.state,
      controller.config.compress.mode === "message",
    );
    phases.projection = performance.now() - phaseStartedAt;
    await budget.checkpoint();

    phaseStartedAt = performance.now();
    appendNudge(pi, controller, context, transformed, groups);
    assertValidToolPairing(transformed);
    context.ui.setStatus(STATUS_KEY, compactStatusText(controller.state));
    phases.finalization = performance.now() - phaseStartedAt;

    const totalMs = performance.now() - startedAt;
    const diagnostics = {
      totalMs,
      phases,
      yields: budget.yields,
      yieldMs: budget.yieldMs,
      inputMessages: event.messages.length,
      outputMessages: transformed.length,
      associationFingerprints: association.stats.fingerprintedMessages,
      indexedEntries: association.stats.indexedEntries,
      associationReset: association.stats.reset,
      toolCacheHits: toolCache.hits,
      toolCacheMisses: toolCache.misses,
      activeBlocks: controller.state.activeBlockIds.size,
      prunedTools: controller.state.prunedTools.size,
    };
    if (totalMs >= SLOW_CONTEXT_TRANSFORM_MS) {
      pi.logger.warn("DCP slow context transform", diagnostics);
    } else if (controller.config.debug) {
      pi.logger.debug("DCP context transformed", diagnostics);
    }
    return { messages: transformed };
  }));

  pi.on("agent_end", async (event, context) => {
    if (event.willContinue !== true) {
      await serializeMutation(controller, () => {
        controller.manualCompressionGrants = 0;
        flushPruneNotification(pi, controller, context);
      });
    }
  });

  pi.on("session_compact", async (_event, context) => {
    await serializeMutation(controller, () => {
      persist(pi, controller.state, {
        version: 1,
        at: Date.now(),
        kind: "native-compaction-reset",
        blockIds: [...controller.state.activeBlockIds],
      });
      controller.latestGroups = [];
      controller.messageAssociations.reset();
      resetPendingPruneNotification(controller);
      controller.toolRecords.clear();
      context.ui.setStatus(STATUS_KEY, compactStatusText(controller.state));
    });
  });

  pi.on("session_shutdown", async (_event, context) => {
    context.ui.setStatus(STATUS_KEY, undefined);
  });
}
