import type { MessageReferenceState } from "../messages/identity.ts";

export type CompressionMode = "range" | "message";
export type PruneReason = "deduplication" | "purge-error" | "sweep";

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  groupKey?: string;
  groupRef?: string;
  turn: number;
  order: number;
  isError: boolean;
  nativePruned: boolean;
  tokenCount: number;
}

export interface PrunedToolRecord {
  toolCallId: string;
  reason: PruneReason;
  tokenCount: number;
  prunedAt: number;
}

export interface CompressionBlock {
  blockId: number;
  runId: number;
  mode: CompressionMode;
  active: boolean;
  deactivatedByUser: boolean;
  /** Permanently quarantined: this block would hide an opaque replay boundary. */
  invalidatedByReplay?: true;
  topic: string;
  batchTopic?: string;
  startRef: string;
  endRef: string;
  anchorKey: string;
  memberKeys: string[];
  directMemberKeys: string[];
  toolCallIds: string[];
  includedBlockIds: number[];
  consumedBlockIds: number[];
  summary: string;
  compressedTokens: number;
  summaryTokens: number;
  durationMs: number;
  createdAt: number;
}

export interface DcpStats {
  totalPruneTokens: number;
  totalToolsPruned: number;
  totalMessagesCompressed: number;
}

export interface NudgeState {
  contextLimitAnchors: Set<string>;
  turnAnchors: Set<string>;
  iterationAnchors: Set<string>;
}

export interface RuntimeState {
  sessionId: string | null;
  manualMode: boolean | "compress-pending";
  references: MessageReferenceState;
  toolCalls: Map<string, ToolCallRecord>;
  prunedTools: Map<string, PrunedToolRecord>;
  blocks: Map<number, CompressionBlock>;
  activeBlockIds: Set<number>;
  nudges: NudgeState;
  stats: DcpStats;
  currentTurn: number;
  nextBlockId: number;
  nextRunId: number;
}

export interface ReferenceAssignment {
  key: string;
  ref: string;
}

export interface BlockActivationChange {
  blockId: number;
  active: boolean;
  deactivatedByUser: boolean;
}

interface MutationBase {
  version: 1;
  at: number;
}

export type PersistedMutation =
  | (MutationBase & { kind: "references-assigned"; assignments: ReferenceAssignment[]; nextRef: number })
  | (MutationBase & { kind: "tools-pruned"; records: PrunedToolRecord[] })
  | (MutationBase & { kind: "compression-created"; blocks: CompressionBlock[] })
  | (MutationBase & { kind: "blocks-activation"; changes: BlockActivationChange[] })
  | (MutationBase & { kind: "replay-blocks-invalidated"; blockIds: number[] })
  | (MutationBase & { kind: "manual-mode"; enabled: boolean })
  | (MutationBase & {
      kind: "nudge-anchors";
      contextLimit: string[];
      turn: string[];
      iteration: string[];
    })
  | (MutationBase & { kind: "native-compaction-reset"; blockIds: number[] });
