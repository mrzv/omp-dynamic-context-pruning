import { getFilePathsFromParameters, isFilePathProtected, isToolNameProtected } from "../protected-patterns.ts";
import type { RuntimeState, PrunedToolRecord, ToolCallRecord } from "../state/types.ts";

export interface StrategyToggle {
  enabled: boolean;
  protectedTools: string[];
}

export interface PurgeErrorStrategy extends StrategyToggle {
  turns: number;
}

export interface PruningStrategyConfig {
  automaticInManualMode: boolean;
  protectedFilePatterns: string[];
  deduplication: StrategyToggle;
  purgeErrors: PurgeErrorStrategy;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

export function createToolSignature(toolName: string, input: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) normalized[key] = value;
  }
  return `${toolName}::${JSON.stringify(sortValue(normalized))}`;
}

export function isToolRecordProtected(
  record: ToolCallRecord,
  tools: readonly string[],
  files: readonly string[],
): boolean {
  if (isToolNameProtected(record.toolName, tools)) return true;
  return isFilePathProtected(getFilePathsFromParameters(record.toolName, record.input), files);
}

function prunedRecord(record: ToolCallRecord, reason: PrunedToolRecord["reason"], now: number): PrunedToolRecord {
  return {
    toolCallId: record.toolCallId,
    reason,
    tokenCount: record.tokenCount,
    prunedAt: now,
  };
}

export function selectDuplicateTools(
  state: RuntimeState,
  config: PruningStrategyConfig,
  now = Date.now(),
): PrunedToolRecord[] {
  if (!config.deduplication.enabled) return [];
  if (state.manualMode && !config.automaticInManualMode) return [];

  const bySignature = new Map<string, ToolCallRecord[]>();
  const ordered = [...state.toolCalls.values()].sort((left, right) => left.order - right.order);
  for (const record of ordered) {
    if (record.nativePruned || state.prunedTools.has(record.toolCallId)) continue;
    if (record.toolName === "edit" || record.toolName === "write") continue;
    if (isToolRecordProtected(record, config.deduplication.protectedTools, config.protectedFilePatterns)) continue;
    const signature = createToolSignature(record.toolName, record.input);
    const matches = bySignature.get(signature);
    if (matches) matches.push(record);
    else bySignature.set(signature, [record]);
  }

  const selected: PrunedToolRecord[] = [];
  for (const matches of bySignature.values()) {
    for (let index = 0; index < matches.length - 1; index++) {
      const record = matches[index];
      if (record) selected.push(prunedRecord(record, "deduplication", now));
    }
  }
  return selected;
}

export function selectOldErrorTools(
  state: RuntimeState,
  config: PruningStrategyConfig,
  now = Date.now(),
): PrunedToolRecord[] {
  if (!config.purgeErrors.enabled) return [];
  if (state.manualMode && !config.automaticInManualMode) return [];
  const threshold = Math.max(1, config.purgeErrors.turns);
  const selected: PrunedToolRecord[] = [];

  for (const record of state.toolCalls.values()) {
    if (!record.isError || record.nativePruned || state.prunedTools.has(record.toolCallId)) continue;
    if (state.currentTurn - record.turn < threshold) continue;
    if (isToolRecordProtected(record, config.purgeErrors.protectedTools, config.protectedFilePatterns)) continue;
    selected.push(prunedRecord(record, "purge-error", now));
  }
  return selected;
}

export function selectAutomaticPrunes(
  state: RuntimeState,
  config: PruningStrategyConfig,
  now = Date.now(),
): PrunedToolRecord[] {
  const selected = selectDuplicateTools(state, config, now);
  const selectedIds = new Set(selected.map((record) => record.toolCallId));
  for (const record of selectOldErrorTools(state, config, now)) {
    if (!selectedIds.has(record.toolCallId)) selected.push(record);
  }
  return selected;
}
