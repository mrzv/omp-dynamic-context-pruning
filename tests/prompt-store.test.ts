import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptStore } from "../src/prompts/store.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "omp-dcp-prompts-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("prompt overrides", () => {
  test("uses project overrides ahead of global overrides", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const projectOverrides = join(project, ".omp", "dcp-prompts", "overrides");
    const globalOverrides = join(agentDir, "dcp-prompts", "overrides");
    mkdirSync(projectOverrides, { recursive: true });
    mkdirSync(globalOverrides, { recursive: true });
    writeFileSync(join(globalOverrides, "system.md"), "Global system prompt");
    writeFileSync(join(projectOverrides, "system.md"), "<!-- note -->\nProject system prompt");

    const store = new PromptStore(project, { agentDir, enabled: true, createDefaults: false });
    expect(store.get("system")).toBe("<dcp-system-reminder>\nProject system prompt\n</dcp-system-reminder>");
    expect(store.warnings).toEqual([]);
  });

  test("creates editable bundled defaults only when enabled", () => {
    const root = temporaryDirectory();
    const disabledDir = join(root, "disabled");
    new PromptStore(root, { agentDir: disabledDir, enabled: false });
    expect(existsSync(join(disabledDir, "dcp-prompts"))).toBe(false);

    const enabledDir = join(root, "enabled");
    const store = new PromptStore(root, { agentDir: enabledDir, enabled: true });
    expect(existsSync(join(store.defaultsDirectory, "system.md"))).toBe(true);
    expect(existsSync(join(store.defaultsDirectory, "compress-range.md"))).toBe(true);
  });

  test("ignores malformed reminder overrides", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const overrides = join(agentDir, "dcp-prompts", "overrides");
    mkdirSync(overrides, { recursive: true });
    writeFileSync(join(overrides, "turn-nudge.md"), "<dcp-system-reminder>missing close");

    const store = new PromptStore(root, { agentDir, enabled: true, createDefaults: false });
    expect(store.get("turn-nudge")).not.toContain("missing close");
    expect(store.warnings[0]).toContain("malformed");
    store.reload();
    expect(store.warnings).toHaveLength(1);
    writeFileSync(join(overrides, "turn-nudge.md"), "Valid replacement");
    store.reload();
    expect(store.warnings).toEqual([]);
    expect(store.get("turn-nudge")).toContain("Valid replacement");
  });
});
