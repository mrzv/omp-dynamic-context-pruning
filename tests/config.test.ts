import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, modelThreshold } from "../src/config.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "omp-dcp-config-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DCP configuration", () => {
  test("merges global and nearest project JSONC layers", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const project = join(root, "workspace");
    const nested = join(project, "src", "nested");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(project, ".omp"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(agentDir, "dcp.jsonc"), `{
      // Global defaults for every project.
      "compress": { "mode": "message", "protectedTools": ["memory"] },
      "protectedFilePatterns": ["**/.env"]
    }`);
    writeFileSync(join(project, ".omp", "dcp.jsonc"), `{
      "compress": {
        "permission": "ask",
        "modelMaxLimits": { "anthropic/claude": "75%" },
      },
      "protectedFilePatterns": ["**/secrets/**"]
    }`);

    const result = loadConfig(nested, { agentDir, createGlobal: false });
    expect(result.warnings).toEqual([]);
    expect(result.paths).toEqual([join(agentDir, "dcp.jsonc"), join(project, ".omp", "dcp.jsonc")]);
    expect(result.config.compress).toMatchObject({ mode: "message", permission: "ask" });
    expect(result.config.compress.protectedTools).toContain("memory");
    expect(result.config.protectedFilePatterns).toEqual(["**/.env", "**/secrets/**"]);
    expect(modelThreshold(result.config, "max", "anthropic", "claude", 200_000)).toBe(150_000);
  });

  test("rejects an invalid layer without partially applying it", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "dcp.jsonc"), `{
      "enabled": false,
      "pruneNotification": ["off"],
      "compress": { "nudgeFrequency": 5 }
    }`);

    const result = loadConfig(root, { agentDir, createGlobal: false });
    expect(result.config.enabled).toBe(true);
    expect(result.config.compress.nudgeFrequency).toBe(5);
    expect(result.warnings[0]).toContain("layer ignored");
  });

  test("reports parse errors and unknown keys", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "dcp.jsonc"), "{ invalid");
    const invalid = loadConfig(root, { agentDir, createGlobal: false });
    expect(invalid.warnings[0]).toContain("layer ignored");

    writeFileSync(join(agentDir, "dcp.jsonc"), '{ "futureOption": true }');
    const unknown = loadConfig(root, { agentDir, createGlobal: false });
    expect(unknown.warnings[0]).toContain("unknown keys ignored: futureOption");
  });
});
