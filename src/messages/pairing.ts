import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { assistantToolCalls, getProjectionSource, hasOpaqueProviderReplay } from "./logical-messages.ts";

export type PairingIssueKind = "duplicate-call" | "duplicate-result" | "orphan-result" | "missing-result";

export interface PairingIssue {
  kind: PairingIssueKind;
  toolCallId: string;
  messageIndex: number;
}

export function findToolPairingIssues(
  messages: readonly AgentMessage[],
  allowDanglingToolCalls = false,
): PairingIssue[] {
  const seenCallIds = new Map<string, number>();
  const seenResultIds = new Set<string>();
  const pendingCalls = new Map<string, number>();
  const issues: PairingIssue[] = [];

  const closePendingBatch = (): void => {
    for (const [toolCallId, callIndex] of pendingCalls) {
      issues.push({ kind: "missing-result", toolCallId, messageIndex: callIndex });
    }
    pendingCalls.clear();
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;

    if (message.role === "toolResult") {
      if (seenResultIds.has(message.toolCallId)) {
        issues.push({ kind: "duplicate-result", toolCallId: message.toolCallId, messageIndex: index });
        continue;
      }
      seenResultIds.add(message.toolCallId);
      if (!pendingCalls.delete(message.toolCallId)) {
        issues.push({ kind: "orphan-result", toolCallId: message.toolCallId, messageIndex: index });
      }
      continue;
    }

    if (pendingCalls.size > 0) closePendingBatch();
    if (message.role !== "assistant") continue;

    for (const call of assistantToolCalls(message)) {
      if (seenCallIds.has(call.id)) {
        issues.push({ kind: "duplicate-call", toolCallId: call.id, messageIndex: index });
        continue;
      }
      seenCallIds.set(call.id, index);
      pendingCalls.set(call.id, index);
    }
  }

  if (pendingCalls.size > 0 && !allowDanglingToolCalls) closePendingBatch();
  return issues;
}

export function assertValidToolPairing(
  messages: readonly AgentMessage[],
  allowDanglingToolCalls = false,
): void {
  const issues = findToolPairingIssues(messages, allowDanglingToolCalls);
  if (issues.length === 0) return;
  const description = issues
    .map((issue) => `${issue.kind}:${issue.toolCallId}@${issue.messageIndex}`)
    .join(", ");
  throw new Error(`DCP produced invalid tool history: ${description}`);
}

function opaqueReplayPayload(message: AgentMessage | undefined): object | undefined {
  if (!message || !hasOpaqueProviderReplay(message)) return undefined;
  const payload = (message as AgentMessage & Record<string, unknown>).providerPayload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : undefined;
}

/** Associate only the contiguous result run immediately following an opaque replay. */
function replayBoundaries(messages: readonly AgentMessage[]): Map<number, number> {
  const boundaries = new Map<number, number>();
  let boundary: number | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "toolResult") {
      if (boundary !== undefined) boundaries.set(index, boundary);
    } else {
      boundary = opaqueReplayPayload(message) !== undefined ? index : undefined;
    }
  }
  return boundaries;
}

/**
 * Accept only source orphan occurrences at an opaque provider replay boundary.
 * Both that occurrence and its unchanged replay boundary must survive projection.
 * Clones use out-of-band provenance, never tool IDs, timestamps, or content equality.
 */
export function assertValidToolPairingProjection(
  sourceMessages: readonly AgentMessage[],
  projectedMessages: readonly AgentMessage[],
): void {
  const projectedIssues = findToolPairingIssues(projectedMessages);
  // An opaque payload can contain the entire history, even when no visible
  // tool results remain. The pairing fast path must not bypass its preservation.
  const replayIndices = new Set<number>();
  sourceMessages.forEach((message, index) => {
    if (hasOpaqueProviderReplay(message)) replayIndices.add(index);
  });
  if (projectedIssues.length === 0 && replayIndices.size === 0) return;

  const sourceBoundaries = replayBoundaries(sourceMessages);
  const projectedBoundaries = replayBoundaries(projectedMessages);
  const allowedOrphans = new Map<number, PairingIssue>();
  for (const issue of findToolPairingIssues(sourceMessages)) {
    if (issue.kind === "orphan-result" && sourceBoundaries.has(issue.messageIndex)) {
      allowedOrphans.set(issue.messageIndex, issue);
    }
  }

  const sourceIndices = new Map<AgentMessage, number>();
  sourceMessages.forEach((message, index) => {
    sourceIndices.set(message, sourceIndices.has(message) ? -1 : index);
  });
  const sourceIndex = (message: AgentMessage | undefined): number | undefined => {
    if (!message) return undefined;
    const direct = sourceIndices.get(message);
    // An untracked repeated reference is ambiguous; only a clone's index disambiguates it.
    if (direct !== undefined) return direct >= 0 ? direct : undefined;
    for (let source = getProjectionSource(message); source; source = getProjectionSource(source.message)) {
      if (sourceMessages[source.index] === source.message) return source.index;
    }
    return undefined;
  };

  const retainedReplays = new Set<number>();
  const replayIssues: string[] = [];
  for (const message of projectedMessages) {
    const index = sourceIndex(message);
    if (index === undefined || !replayIndices.has(index)) continue;
    const original = sourceMessages[index] as AgentMessage & Record<string, unknown>;
    const projected = message as AgentMessage & Record<string, unknown>;
    if (projected.role !== original.role || projected.providerPayload !== original.providerPayload) {
      replayIssues.push(`modified-provider-replay@${index}`);
    } else if (retainedReplays.has(index)) {
      replayIssues.push(`duplicate-provider-replay@${index}`);
    } else {
      retainedReplays.add(index);
    }
  }
  for (const index of replayIndices) {
    if (!retainedReplays.has(index)) replayIssues.push(`missing-provider-replay@${index}`);
  }

  const issues = projectedIssues.filter((issue) => {
    if (issue.kind !== "orphan-result") return true;
    const originalIndex = sourceIndex(projectedMessages[issue.messageIndex]);
    if (originalIndex === undefined) return true;
    const allowed = allowedOrphans.get(originalIndex);
    if (!allowed || allowed.toolCallId !== issue.toolCallId) return true;

    const originalBoundary = sourceBoundaries.get(originalIndex);
    const projectedBoundary = projectedBoundaries.get(issue.messageIndex);
    if (originalBoundary === undefined || projectedBoundary === undefined) return true;
    const replay = projectedMessages[projectedBoundary];
    if (sourceIndex(replay) !== originalBoundary) return true;
    if (opaqueReplayPayload(replay) !== opaqueReplayPayload(sourceMessages[originalBoundary])) return true;

    allowedOrphans.delete(originalIndex);
    return false;
  });
  if (issues.length === 0 && replayIssues.length === 0) return;
  const description = [
    ...issues.map((issue) => `${issue.kind}:${issue.toolCallId}@${issue.messageIndex}`),
    ...replayIssues,
  ].join(", ");
  throw new Error(`DCP produced invalid tool history: ${description}`);
}
