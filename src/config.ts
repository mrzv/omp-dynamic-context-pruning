import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { isUnknownRecord } from "./type-guards.ts";

export type Permission = "ask" | "allow" | "deny";
export type CompressMode = "range" | "message";
export type ContextThreshold = number | `${number}%`;

export interface DcpConfig {
  enabled: boolean;
  debug: boolean;
  pruneNotification: "off" | "minimal" | "detailed";
  pruneNotificationType: "chat" | "toast";
  commands: { enabled: boolean; protectedTools: string[] };
  manualMode: { enabled: boolean; automaticStrategies: boolean };
  turnProtection: { enabled: boolean; turns: number };
  experimental: { allowSubAgents: boolean; customPrompts: boolean };
  protectedFilePatterns: string[];
  compress: {
    mode: CompressMode;
    permission: Permission;
    showCompression: boolean;
    summaryBuffer: boolean;
    maxContextLimit: ContextThreshold;
    minContextLimit: ContextThreshold;
    modelMaxLimits: Record<string, ContextThreshold>;
    modelMinLimits: Record<string, ContextThreshold>;
    nudgeFrequency: number;
    iterationNudgeThreshold: number;
    nudgeForce: "strong" | "soft";
    protectedTools: string[];
    protectTags: boolean;
    protectUserMessages: boolean;
  };
  strategies: {
    deduplication: { enabled: boolean; protectedTools: string[] };
    purgeErrors: { enabled: boolean; turns: number; protectedTools: string[] };
  };
}

export interface ConfigLoadResult {
  config: DcpConfig;
  paths: string[];
  warnings: string[];
}

export interface ConfigLoadOptions {
  agentDir?: string;
  createGlobal?: boolean;
}

export const CORE_PROTECTED_TOOLS = [
  "task",
  "skill",
  "todo",
  "todowrite",
  "todoread",
  "compress",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit",
] as const;

export const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
  commands: { enabled: true, protectedTools: [...CORE_PROTECTED_TOOLS] },
  manualMode: { enabled: false, automaticStrategies: true },
  turnProtection: { enabled: false, turns: 4 },
  experimental: { allowSubAgents: false, customPrompts: false },
  protectedFilePatterns: [],
  compress: {
    mode: "range",
    permission: "allow",
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 100_000,
    minContextLimit: 50_000,
    modelMaxLimits: {},
    modelMinLimits: {},
    nudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    protectedTools: ["task", "skill", "todo", "todowrite", "todoread"],
    protectTags: false,
    protectUserMessages: false,
  },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
  },
};

const ALLOWED_KEYS = new Set([
  "$schema",
  "enabled",
  "debug",
  "pruneNotification",
  "pruneNotificationType",
  "commands",
  "commands.enabled",
  "commands.protectedTools",
  "manualMode",
  "manualMode.enabled",
  "manualMode.automaticStrategies",
  "turnProtection",
  "turnProtection.enabled",
  "turnProtection.turns",
  "experimental",
  "experimental.allowSubAgents",
  "experimental.customPrompts",
  "protectedFilePatterns",
  "compress",
  "compress.mode",
  "compress.permission",
  "compress.showCompression",
  "compress.summaryBuffer",
  "compress.maxContextLimit",
  "compress.minContextLimit",
  "compress.modelMaxLimits",
  "compress.modelMinLimits",
  "compress.nudgeFrequency",
  "compress.iterationNudgeThreshold",
  "compress.nudgeForce",
  "compress.protectedTools",
  "compress.protectTags",
  "compress.protectUserMessages",
  "strategies",
  "strategies.deduplication",
  "strategies.deduplication.enabled",
  "strategies.deduplication.protectedTools",
  "strategies.purgeErrors",
  "strategies.purgeErrors.enabled",
  "strategies.purgeErrors.turns",
  "strategies.purgeErrors.protectedTools",
]);


function configKeyPaths(value: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    if (isUnknownRecord(nested) && path !== "compress.modelMaxLimits" && path !== "compress.modelMinLimits") {
      paths.push(...configKeyPaths(nested, path));
    }
  }
  return paths;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isContextThreshold(value: unknown): value is ContextThreshold {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?%$/.test(value)) return false;
  const percentage = Number(value.slice(0, -1));
  return percentage >= 0 && percentage <= 100;
}

function isThresholdMap(value: unknown): value is Record<string, ContextThreshold> {
  return isUnknownRecord(value) && Object.values(value).every(isContextThreshold);
}

function isPruneNotification(value: unknown): value is DcpConfig["pruneNotification"] {
  return value === "off" || value === "minimal" || value === "detailed";
}

function isPruneNotificationType(value: unknown): value is DcpConfig["pruneNotificationType"] {
  return value === "chat" || value === "toast";
}

function isCompressMode(value: unknown): value is CompressMode {
  return value === "range" || value === "message";
}

function isPermission(value: unknown): value is Permission {
  return value === "ask" || value === "allow" || value === "deny";
}

function isNudgeForce(value: unknown): value is DcpConfig["compress"]["nudgeForce"] {
  return value === "strong" || value === "soft";
}

function pushTypeError(
  errors: string[],
  object: Record<string, unknown>,
  key: string,
  valid: (value: unknown) => boolean,
  expected: string,
): void {
  if (Object.hasOwn(object, key) && !valid(object[key])) errors.push(`${key} must be ${expected}`);
}

function validateLayer(data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  pushTypeError(errors, data, "enabled", (value) => typeof value === "boolean", "a boolean");
  pushTypeError(errors, data, "debug", (value) => typeof value === "boolean", "a boolean");
  pushTypeError(errors, data, "pruneNotification", isPruneNotification, '"off", "minimal", or "detailed"');
  pushTypeError(errors, data, "pruneNotificationType", (value) => value === "chat" || value === "toast", '"chat" or "toast"');
  pushTypeError(errors, data, "protectedFilePatterns", isStringArray, "an array of strings");

  const commands = data.commands;
  if (commands !== undefined) {
    if (!isUnknownRecord(commands)) errors.push("commands must be an object");
    else {
      pushTypeError(errors, commands, "enabled", (value) => typeof value === "boolean", "a boolean");
      pushTypeError(errors, commands, "protectedTools", isStringArray, "an array of strings");
    }
  }
  const manualMode = data.manualMode;
  if (manualMode !== undefined) {
    if (!isUnknownRecord(manualMode)) errors.push("manualMode must be an object");
    else {
      pushTypeError(errors, manualMode, "enabled", (value) => typeof value === "boolean", "a boolean");
      pushTypeError(errors, manualMode, "automaticStrategies", (value) => typeof value === "boolean", "a boolean");
    }
  }
  const turnProtection = data.turnProtection;
  if (turnProtection !== undefined) {
    if (!isUnknownRecord(turnProtection)) errors.push("turnProtection must be an object");
    else {
      pushTypeError(errors, turnProtection, "enabled", (value) => typeof value === "boolean", "a boolean");
      pushTypeError(errors, turnProtection, "turns", (value) => typeof value === "number" && Number.isFinite(value) && value >= 1, "a positive number");
    }
  }
  const experimental = data.experimental;
  if (experimental !== undefined) {
    if (!isUnknownRecord(experimental)) errors.push("experimental must be an object");
    else {
      pushTypeError(errors, experimental, "allowSubAgents", (value) => typeof value === "boolean", "a boolean");
      pushTypeError(errors, experimental, "customPrompts", (value) => typeof value === "boolean", "a boolean");
    }
  }
  const compress = data.compress;
  if (compress !== undefined) {
    if (!isUnknownRecord(compress)) errors.push("compress must be an object");
    else {
      pushTypeError(errors, compress, "mode", (value) => value === "range" || value === "message", '"range" or "message"');
      pushTypeError(errors, compress, "permission", (value) => value === "ask" || value === "allow" || value === "deny", '"ask", "allow", or "deny"');
      for (const key of ["showCompression", "summaryBuffer", "protectTags", "protectUserMessages"]) {
        pushTypeError(errors, compress, key, (value) => typeof value === "boolean", "a boolean");
      }
      pushTypeError(errors, compress, "maxContextLimit", isContextThreshold, "a non-negative number or percentage");
      pushTypeError(errors, compress, "minContextLimit", isContextThreshold, "a non-negative number or percentage");
      pushTypeError(errors, compress, "modelMaxLimits", isThresholdMap, "a threshold map");
      pushTypeError(errors, compress, "modelMinLimits", isThresholdMap, "a threshold map");
      pushTypeError(errors, compress, "nudgeFrequency", (value) => Number.isInteger(value) && Number(value) >= 1, "a positive integer");
      pushTypeError(errors, compress, "iterationNudgeThreshold", (value) => Number.isInteger(value) && Number(value) >= 0, "a non-negative integer");
      pushTypeError(errors, compress, "nudgeForce", (value) => value === "strong" || value === "soft", '"strong" or "soft"');
      pushTypeError(errors, compress, "protectedTools", isStringArray, "an array of strings");
    }
  }
  const strategies = data.strategies;
  if (strategies !== undefined) {
    if (!isUnknownRecord(strategies)) errors.push("strategies must be an object");
    else {
      for (const name of ["deduplication", "purgeErrors"] as const) {
        const strategy = strategies[name];
        if (strategy === undefined) continue;
        if (!isUnknownRecord(strategy)) {
          errors.push(`strategies.${name} must be an object`);
          continue;
        }
        pushTypeError(errors, strategy, "enabled", (value) => typeof value === "boolean", "a boolean");
        pushTypeError(errors, strategy, "protectedTools", isStringArray, "an array of strings");
        if (name === "purgeErrors") {
          pushTypeError(errors, strategy, "turns", (value) => typeof value === "number" && Number.isFinite(value) && value >= 1, "a positive number");
        }
      }
    }
  }
  return errors;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function cloneDefaultConfig(): DcpConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function mergeLayer(config: DcpConfig, data: Record<string, unknown>): DcpConfig {
  const commands = isUnknownRecord(data.commands) ? data.commands : {};
  const manualMode = isUnknownRecord(data.manualMode) ? data.manualMode : {};
  const turnProtection = isUnknownRecord(data.turnProtection) ? data.turnProtection : {};
  const experimental = isUnknownRecord(data.experimental) ? data.experimental : {};
  const compress = isUnknownRecord(data.compress) ? data.compress : {};
  const strategies = isUnknownRecord(data.strategies) ? data.strategies : {};
  const deduplication = isUnknownRecord(strategies.deduplication) ? strategies.deduplication : {};
  const purgeErrors = isUnknownRecord(strategies.purgeErrors) ? strategies.purgeErrors : {};
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : config.enabled,
    debug: typeof data.debug === "boolean" ? data.debug : config.debug,
    pruneNotification: isPruneNotification(data.pruneNotification) ? data.pruneNotification : config.pruneNotification,
    pruneNotificationType: isPruneNotificationType(data.pruneNotificationType) ? data.pruneNotificationType : config.pruneNotificationType,
    commands: {
      enabled: typeof commands.enabled === "boolean" ? commands.enabled : config.commands.enabled,
      protectedTools: unique([...config.commands.protectedTools, ...(isStringArray(commands.protectedTools) ? commands.protectedTools : [])]),
    },
    manualMode: {
      enabled: typeof manualMode.enabled === "boolean" ? manualMode.enabled : config.manualMode.enabled,
      automaticStrategies: typeof manualMode.automaticStrategies === "boolean" ? manualMode.automaticStrategies : config.manualMode.automaticStrategies,
    },
    turnProtection: {
      enabled: typeof turnProtection.enabled === "boolean" ? turnProtection.enabled : config.turnProtection.enabled,
      turns: typeof turnProtection.turns === "number" ? turnProtection.turns : config.turnProtection.turns,
    },
    experimental: {
      allowSubAgents: typeof experimental.allowSubAgents === "boolean" ? experimental.allowSubAgents : config.experimental.allowSubAgents,
      customPrompts: typeof experimental.customPrompts === "boolean" ? experimental.customPrompts : config.experimental.customPrompts,
    },
    protectedFilePatterns: unique([...config.protectedFilePatterns, ...(isStringArray(data.protectedFilePatterns) ? data.protectedFilePatterns : [])]),
    compress: {
      mode: isCompressMode(compress.mode) ? compress.mode : config.compress.mode,
      permission: isPermission(compress.permission) ? compress.permission : config.compress.permission,
      showCompression: typeof compress.showCompression === "boolean" ? compress.showCompression : config.compress.showCompression,
      summaryBuffer: typeof compress.summaryBuffer === "boolean" ? compress.summaryBuffer : config.compress.summaryBuffer,
      maxContextLimit: isContextThreshold(compress.maxContextLimit) ? compress.maxContextLimit : config.compress.maxContextLimit,
      minContextLimit: isContextThreshold(compress.minContextLimit) ? compress.minContextLimit : config.compress.minContextLimit,
      modelMaxLimits: isThresholdMap(compress.modelMaxLimits) ? compress.modelMaxLimits : config.compress.modelMaxLimits,
      modelMinLimits: isThresholdMap(compress.modelMinLimits) ? compress.modelMinLimits : config.compress.modelMinLimits,
      nudgeFrequency: typeof compress.nudgeFrequency === "number" ? compress.nudgeFrequency : config.compress.nudgeFrequency,
      iterationNudgeThreshold: typeof compress.iterationNudgeThreshold === "number" ? compress.iterationNudgeThreshold : config.compress.iterationNudgeThreshold,
      nudgeForce: isNudgeForce(compress.nudgeForce) ? compress.nudgeForce : config.compress.nudgeForce,
      protectedTools: unique([...config.compress.protectedTools, ...(isStringArray(compress.protectedTools) ? compress.protectedTools : [])]),
      protectTags: typeof compress.protectTags === "boolean" ? compress.protectTags : config.compress.protectTags,
      protectUserMessages: typeof compress.protectUserMessages === "boolean" ? compress.protectUserMessages : config.compress.protectUserMessages,
    },
    strategies: {
      deduplication: {
        enabled: typeof deduplication.enabled === "boolean" ? deduplication.enabled : config.strategies.deduplication.enabled,
        protectedTools: unique([...config.strategies.deduplication.protectedTools, ...(isStringArray(deduplication.protectedTools) ? deduplication.protectedTools : [])]),
      },
      purgeErrors: {
        enabled: typeof purgeErrors.enabled === "boolean" ? purgeErrors.enabled : config.strategies.purgeErrors.enabled,
        turns: typeof purgeErrors.turns === "number" ? purgeErrors.turns : config.strategies.purgeErrors.turns,
        protectedTools: unique([...config.strategies.purgeErrors.protectedTools, ...(isStringArray(purgeErrors.protectedTools) ? purgeErrors.protectedTools : [])]),
      },
    },
  };
}

export function findProjectConfigDir(startDir: string): string | undefined {
  let current = startDir;
  for (;;) {
    const candidate = join(current, ".omp");
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Treat inaccessible ancestors as absent and continue toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function existingConfig(directory: string): string | undefined {
  const jsonc = join(directory, "dcp.jsonc");
  if (existsSync(jsonc)) return jsonc;
  const json = join(directory, "dcp.json");
  return existsSync(json) ? json : undefined;
}

function parseConfigFile(path: string): { data?: Record<string, unknown>; error?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { error: `cannot read file: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parseErrors: ParseError[] = [];
  const value: unknown = parse(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0) {
    const detail = parseErrors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ");
    return { error: detail };
  }
  if (!isUnknownRecord(value)) return { error: "root must be an object" };
  return { data: value };
}

export function loadConfig(cwd: string, options: ConfigLoadOptions = {}): ConfigLoadResult {
  const warnings: string[] = [];
  const agentDir = options.agentDir ?? getAgentDir();
  const globalPath = existingConfig(agentDir);
  if (!globalPath && options.createGlobal !== false) {
    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "dcp.jsonc"),
        '{\n  "$schema": "https://unpkg.com/omp-dynamic-context-pruning@latest/dcp.schema.json"\n}\n',
        "utf8",
      );
    } catch (error) {
      warnings.push(`${agentDir}: cannot create default configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const projectDir = findProjectConfigDir(cwd);
  const paths = [globalPath ?? existingConfig(agentDir), ...(projectDir ? [existingConfig(projectDir)] : [])]
    .filter((path): path is string => path !== undefined);
  let config = cloneDefaultConfig();
  for (const path of paths) {
    const loaded = parseConfigFile(path);
    if (!loaded.data) {
      warnings.push(`${path}: ${loaded.error ?? "invalid configuration"}; layer ignored`);
      continue;
    }
    const unknownKeys = configKeyPaths(loaded.data).filter((key) => !ALLOWED_KEYS.has(key));
    if (unknownKeys.length > 0) warnings.push(`${path}: unknown keys ignored: ${unknownKeys.join(", ")}`);
    const validationErrors = validateLayer(loaded.data);
    if (validationErrors.length > 0) {
      warnings.push(`${path}: ${validationErrors.join("; ")}; layer ignored`);
      continue;
    }
    config = mergeLayer(config, loaded.data);
  }
  return { config, paths, warnings };
}

export function resolveContextThreshold(
  threshold: ContextThreshold,
  contextWindow: number | undefined,
): number {
  if (typeof threshold === "number") return threshold;
  if (!contextWindow || contextWindow <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(contextWindow * Number(threshold.slice(0, -1)) / 100);
}

export function modelThreshold(
  config: DcpConfig,
  kind: "min" | "max",
  provider: string | undefined,
  model: string | undefined,
  contextWindow: number | undefined,
): number {
  const key = provider && model ? `${provider}/${model}` : undefined;
  const overrides = kind === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits;
  const fallback = kind === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit;
  return resolveContextThreshold(key ? overrides[key] ?? fallback : fallback, contextWindow);
}
