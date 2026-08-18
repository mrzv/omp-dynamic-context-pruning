import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { assistantToolCalls } from "./logical-messages.ts";

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
