import type { LogicalMessage } from "../messages/logical-messages.ts";
import type { CompressionBlock } from "../state/types.ts";

export interface CompressRangeEntry {
  startId: string;
  endId: string;
  summary: string;
}

export interface CompressRangeArgs {
  topic: string;
  content: CompressRangeEntry[];
}

export interface CompressMessageEntry {
  messageId: string;
  topic: string;
  summary: string;
}

export interface CompressMessageArgs {
  topic: string;
  content: CompressMessageEntry[];
}

export interface BoundaryReference {
  kind: "message" | "compressed-block";
  groupIndex: number;
  groupKey?: string;
  blockId?: number;
  anchorKey?: string;
}

export interface CompressionSearchContext {
  groups: readonly LogicalMessage[];
  groupByKey: Map<string, LogicalMessage>;
  indexByKey: Map<string, number>;
  activeBlocks: Map<number, CompressionBlock>;
}

export interface CompressionSelection {
  startReference: BoundaryReference;
  endReference: BoundaryReference;
  groups: LogicalMessage[];
  groupKeys: string[];
  tokensByKey: Map<string, number>;
  toolCallIds: string[];
  requiredBlockIds: number[];
}

export interface ResolvedRangePlan {
  index: number;
  entry: CompressRangeEntry;
  selection: CompressionSelection;
  anchorKey: string;
}

export interface ResolvedMessagePlan {
  index: number;
  entry: CompressMessageEntry;
  selection: CompressionSelection;
  anchorKey: string;
}

export interface CompressionProtectionOptions {
  protectUserMessages: boolean;
  protectTags: boolean;
  protectedTools: string[];
  protectedFilePatterns: string[];
}

export interface PreparedCompression {
  topic: string;
  batchTopic: string;
  mode: "range" | "message";
  startRef: string;
  endRef: string;
  summary: string;
  consumedBlockIds: number[];
  selection: CompressionSelection;
  anchorKey: string;
}

export interface MessageCompressionResult {
  prepared: PreparedCompression[];
  issues: string[];
}
