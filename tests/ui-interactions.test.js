import assert from "node:assert/strict";
import test from "node:test";

import { getShortcutCandidates, isEditableTarget } from "../app/ui/shortcutUtils.js";
import { applyWorkspaceDecision, selectDirtyGuard } from "../app/ui/workspaceGuardUtils.js";

function targetInside(match) {
    return { closest: () => match ? {} : null };
}

test("shortcut candidates honor priority and overlay precedence", () => {
    const event = { key: "Escape", defaultPrevented: false, target: targetInside(false) };
    const entries = [
        { id: "global", keys: "Escape", priority: 0 },
        { id: "workspace", keys: "Escape", priority: 10 },
        { id: "draft", keys: "Escape", priority: 20 },
    ];
    assert.deepEqual(getShortcutCandidates(entries, event).map((entry) => entry.id), ["draft", "workspace", "global"]);
    assert.deepEqual(getShortcutCandidates(entries, event, { overlayOpen: true }), []);
});

test("editable targets suppress shortcuts unless explicitly allowed", () => {
    const editable = targetInside(true);
    assert.equal(isEditableTarget(editable), true);
    const entries = [
        { id: "blocked", keys: "Space", priority: 10 },
        { id: "allowed", keys: "Space", priority: 0, allowInEditable: true },
    ];
    const event = { key: " ", defaultPrevented: false, target: editable };
    assert.deepEqual(getShortcutCandidates(entries, event).map((entry) => entry.id), ["allowed"]);
});

test("keydown events without a key do not crash shortcut matching", () => {
    const entries = [
        { id: "escape", keys: "Escape", priority: 0 },
        { id: "missing", keys: undefined, priority: 10 },
        { id: "partial", keys: ["Space", undefined], priority: 5 },
    ];
    const event = { key: undefined, defaultPrevented: false, target: targetInside(false) };
    assert.deepEqual(getShortcutCandidates(entries, event), []);
    assert.deepEqual(
        getShortcutCandidates(entries, { key: "Escape", defaultPrevented: false, target: targetInside(false) }).map((entry) => entry.id),
        ["escape"],
    );
});

test("workspace guards select the first dirty registration", () => {
    const clean = { id: "clean", dirty: false };
    const dirty = { id: "dirty", dirty: true };
    assert.equal(selectDirtyGuard([clean, dirty]), dirty);
    assert.equal(selectDirtyGuard([clean]), null);
});

test("workspace decisions save or discard before navigating and stay put on failure", async () => {
    const calls = [];
    const guard = {
        save: async () => calls.push("save"),
        discard: async () => calls.push("discard"),
    };
    assert.equal(await applyWorkspaceDecision({ decision: "stay", guard, navigate: () => calls.push("navigate") }), false);
    assert.deepEqual(calls, []);
    assert.equal(await applyWorkspaceDecision({ decision: "save", guard, navigate: () => calls.push("navigate") }), true);
    assert.deepEqual(calls, ["save", "navigate"]);

    const failed = [];
    await assert.rejects(() => applyWorkspaceDecision({
        decision: "save",
        guard: { save: async () => { throw new Error("save failed"); } },
        navigate: () => failed.push("navigate"),
    }), /save failed/);
    assert.deepEqual(failed, []);
});
