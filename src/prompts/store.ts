import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { findProjectConfigDir } from "../config.ts";
import { DEFAULT_PROMPTS, type PromptName } from "./defaults.ts";

export const MANUAL_MODE_PROMPT = `<dcp-system-reminder>
Manual mode is enabled. Do not use compress unless the current user instruction contains <compress triggered manually>. One marker grants exactly one compress call. After that call, stop and wait for the next user input.
</dcp-system-reminder>`;

export const SUBAGENT_PROMPT = `<dcp-system-reminder>
You are operating in a subagent environment. Follow the initial subagent instruction exactly. It is protected and intentionally has no DCP message ID; subsequent messages can be compressed.
</dcp-system-reminder>`;

const PROMPT_FILES: Record<PromptName, string> = {
  system: "system.md",
  "compress-range": "compress-range.md",
  "compress-message": "compress-message.md",
  "context-limit-nudge": "context-limit-nudge.md",
  "turn-nudge": "turn-nudge.md",
  "iteration-nudge": "iteration-nudge.md",
};

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const LEGACY_COMMENT_LINE = /^[ \t]*\/\/.*?\/\/[ \t]*$/gm;
const REMINDER = /^\s*<dcp-system-reminder\b[^>]*>\s*([\s\S]*?)\s*<\/dcp-system-reminder>\s*$/i;

export interface PromptStoreOptions {
  agentDir?: string;
  enabled?: boolean;
  createDefaults?: boolean;
}

export class PromptStore {
  readonly warnings: string[] = [];
  readonly defaultsDirectory: string;
  readonly globalOverridesDirectory: string;
  readonly projectOverridesDirectory: string | undefined;
  private readonly enabled: boolean;
  private readonly initializationWarnings: string[] = [];
  private prompts: Record<PromptName, string> = structuredClone(DEFAULT_PROMPTS);

  constructor(cwd: string, options: PromptStoreOptions = {}) {
    const agentDir = options.agentDir ?? getAgentDir();
    const root = join(agentDir, "dcp-prompts");
    this.defaultsDirectory = join(root, "defaults");
    this.globalOverridesDirectory = join(root, "overrides");
    const projectDir = findProjectConfigDir(cwd);
    this.projectOverridesDirectory = projectDir ? join(projectDir, "dcp-prompts", "overrides") : undefined;
    this.enabled = options.enabled === true;
    if (this.enabled && options.createDefaults !== false) this.ensureDefaultFiles();
    this.reload();
  }

  get(name: PromptName): string {
    return this.prompts[name];
  }

  all(): Readonly<Record<PromptName, string>> {
    return { ...this.prompts };
  }

  reload(): void {
    const warnings = [...this.initializationWarnings];
    const prompts = structuredClone(DEFAULT_PROMPTS);
    if (!this.enabled) {
      this.prompts = prompts;
      this.warnings.splice(0, this.warnings.length, ...warnings);
      return;
    }
    for (const name of Object.keys(PROMPT_FILES) as PromptName[]) {
      const fileName = PROMPT_FILES[name];
      const candidates = [
        ...(this.projectOverridesDirectory ? [join(this.projectOverridesDirectory, fileName)] : []),
        join(this.globalOverridesDirectory, fileName),
      ];
      for (const path of candidates) {
        if (!existsSync(path)) continue;
        let source: string;
        try {
          source = readFileSync(path, "utf8");
        } catch (error) {
          warnings.push(`${path}: cannot read prompt: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const normalized = normalizePrompt(name, source);
        if (!normalized) {
          warnings.push(`${path}: prompt is empty or malformed; override ignored`);
          continue;
        }
        prompts[name] = normalized;
        break;
      }
    }
    this.prompts = prompts;
    this.warnings.splice(0, this.warnings.length, ...warnings);
  }

  private ensureDefaultFiles(): void {
    try {
      mkdirSync(this.defaultsDirectory, { recursive: true });
      mkdirSync(this.globalOverridesDirectory, { recursive: true });
      for (const name of Object.keys(PROMPT_FILES) as PromptName[]) {
        const path = join(this.defaultsDirectory, PROMPT_FILES[name]);
        const content = editablePrompt(name, DEFAULT_PROMPTS[name]);
        if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, `${content.trim()}\n`, "utf8");
      }
    } catch (error) {
      const warning = `cannot initialize prompt defaults: ${error instanceof Error ? error.message : String(error)}`;
      this.initializationWarnings.push(warning);
      this.warnings.push(warning);
    }
  }
}

function stripComments(source: string): string {
  return source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(HTML_COMMENT, "")
    .replace(LEGACY_COMMENT_LINE, "")
    .trim();
}

function editablePrompt(name: PromptName, source: string): string {
  const stripped = stripComments(source);
  if (name === "compress-range" || name === "compress-message") return stripped;
  return REMINDER.exec(stripped)?.[1]?.trim() ?? stripped;
}

function normalizePrompt(name: PromptName, source: string): string {
  const stripped = stripComments(source);
  if (!stripped) return "";
  if (name === "compress-range" || name === "compress-message") return stripped;
  const begins = /^\s*<dcp-system-reminder\b[^>]*>/i.test(stripped);
  const ends = /<\/dcp-system-reminder>\s*$/i.test(stripped);
  if (begins !== ends) return "";
  const editable = REMINDER.exec(stripped)?.[1]?.trim() ?? stripped;
  return editable ? `<dcp-system-reminder>\n${editable}\n</dcp-system-reminder>` : "";
}
