import { describe, expect, test } from "bun:test";
import { getFilePathsFromParameters, isFilePathProtected, matchesGlob } from "../src/protected-patterns.ts";
import { messageText } from "../src/token-utils.ts";
import { assistantMessage } from "./fixtures/messages.ts";

describe("protected paths", () => {
  test("matches Windows paths and preserves drive letters", () => {
    const paths = getFilePathsFromParameters("read", { path: "C:\\repo\\secrets.txt:50-" });
    expect(paths).toContain("C:\\repo\\secrets.txt");
    expect(isFilePathProtected(paths, ["C:/repo/*.txt"])).toBe(true);
  });

  test("supports every OMP read selector order", () => {
    const selectors = [":50", ":50-", ":50-200", ":50+150", ":5-16,960-973", ":raw", ":2-4:raw", ":raw:2-4", ":conflicts"];
    for (const selector of selectors) {
      const paths = getFilePathsFromParameters("read", { path: `src/secrets.txt${selector}` });
      expect(paths).toContain("src/secrets.txt");
    }
  });

  test("retains exact URL and SQLite targets", () => {
    expect(getFilePathsFromParameters("read", { path: "https://example.test:8080" }))
      .toContain("https://example.test:8080");
    expect(getFilePathsFromParameters("read", { path: "state.db:users:42" }))
      .toContain("state.db:users:42");
    expect(matchesGlob("src/a/b.ts", "src/**/*.ts")).toBe(true);
  });
});

describe("message token source text", () => {
  test("includes OMP thinking payloads", () => {
    const message = assistantMessage([{ type: "thinking", thinking: "private reasoning" }], 1);
    expect(messageText(message)).toContain("private reasoning");
  });

  test("includes execution code and output", () => {
    const execution = {
      role: "pythonExecution",
      code: "print(42)",
      output: "42",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    } as const;
    expect(messageText(execution)).toBe("print(42)\n42");
  });
});
