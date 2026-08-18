import { describe, expect, test } from "bun:test";
import { DCP_STATE_ENTRY, appendMutation, restoreStateFromBranch } from "../src/state/persistence.ts";
import { applyMutation, createMutation, createRuntimeState } from "../src/state/runtime.ts";
import type { PersistedMutation } from "../src/state/types.ts";

describe("DCP state persistence", () => {
  test("folds only namespaced mutations on the active branch", () => {
    const references: PersistedMutation = {
      version: 1,
      at: 1,
      kind: "references-assigned",
      assignments: [{ key: "entry-a", ref: "m0001" }],
      nextRef: 2,
    };
    const manual: PersistedMutation = { version: 1, at: 2, kind: "manual-mode", enabled: true };
    const branch = [
      { type: "custom", customType: "other", data: manual },
      { type: "custom", customType: DCP_STATE_ENTRY, data: references },
      { type: "custom", customType: DCP_STATE_ENTRY, data: { version: 99, kind: "manual-mode" } },
      {
        type: "custom",
        customType: DCP_STATE_ENTRY,
        data: { version: 1, at: 1, kind: "tools-pruned", records: "malformed" },
      },
      { type: "custom", customType: DCP_STATE_ENTRY, data: manual },
    ];

    const state = restoreStateFromBranch(branch, false, "session-1");
    expect(state.sessionId).toBe("session-1");
    expect(state.manualMode).toBe(true);
    expect(state.references.byKey.get("entry-a")).toBe("m0001");
    expect(state.references.nextRef).toBe(2);
  });

  test("branch rollback naturally omits later state", () => {
    const enabled: PersistedMutation = { version: 1, at: 1, kind: "manual-mode", enabled: true };
    const disabled: PersistedMutation = { version: 1, at: 2, kind: "manual-mode", enabled: false };
    const first = { type: "custom", customType: DCP_STATE_ENTRY, data: enabled };
    const second = { type: "custom", customType: DCP_STATE_ENTRY, data: disabled };
    expect(restoreStateFromBranch([first]).manualMode).toBe(true);
    expect(restoreStateFromBranch([first, second]).manualMode).toBe(false);
  });

  test("rejects malformed persisted metrics and references", () => {
    const invalid = {
      type: "custom",
      customType: DCP_STATE_ENTRY,
      data: {
        version: 1,
        at: 1,
        kind: "tools-pruned",
        records: [{ toolCallId: "bad", reason: "deduplication", tokenCount: -100, prunedAt: 1 }],
      },
    };
    const invalidReferences = {
      type: "custom",
      customType: DCP_STATE_ENTRY,
      data: {
        version: 1,
        at: 1,
        kind: "references-assigned",
        assignments: [
          { key: "first", ref: "m0000" },
          { key: "second", ref: "m0000" },
        ],
        nextRef: 2,
      },
    };
    const state = restoreStateFromBranch([invalid, invalidReferences]);
    expect(state.prunedTools.size).toBe(0);
    expect(state.stats.totalPruneTokens).toBe(0);
    expect(state.references.byKey.size).toBe(0);
  });

  test("does not double-count replayed prune records", () => {
    const state = createRuntimeState();
    const mutation: PersistedMutation = {
      version: 1,
      at: 1,
      kind: "tools-pruned",
      records: [{ toolCallId: "call", reason: "deduplication", tokenCount: 100, prunedAt: 1 }],
    };
    applyMutation(state, mutation);
    applyMutation(state, mutation);
    expect(state.stats).toMatchObject({ totalPruneTokens: 100, totalToolsPruned: 1 });
  });

  test("applies reference mutations atomically across branch history", () => {
    const state = createRuntimeState();
    applyMutation(state, {
      version: 1,
      at: 1,
      kind: "references-assigned",
      assignments: [{ key: "first", ref: "m0001" }],
      nextRef: 2,
    });
    applyMutation(state, {
      version: 1,
      at: 2,
      kind: "references-assigned",
      assignments: [{ key: "conflict", ref: "m0001" }],
      nextRef: 10_000,
    });
    expect(state.references.byKey.get("first")).toBe("m0001");
    expect(state.references.byKey.has("conflict")).toBe(false);
    expect(state.references.nextRef).toBe(2);
  });

  test("appends versioned state entries through OMP", () => {
    const calls: unknown[][] = [];
    const pi = { appendEntry: (...args: unknown[]) => calls.push(args) };
    const mutation = createMutation({ kind: "manual-mode", enabled: true }, 123);
    appendMutation(pi as never, mutation);
    expect(calls).toEqual([[DCP_STATE_ENTRY, { version: 1, at: 123, kind: "manual-mode", enabled: true }]]);
  });
});
