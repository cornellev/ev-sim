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

test("ED-02 shortcuts understand Mod, Ctrl, Shift, and Alt prefixes and keep bare letters distinct", async () => {
    const { matchesShortcut, parseShortcut } = await import("../app/ui/shortcutUtils.js");
    const plain = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
    assert.deepEqual(parseShortcut("Shift+Mod+z"), { key: "z", mod: true, ctrl: false, alt: false, shift: true, meta: false, hasModifiers: true });
    assert.equal(parseShortcut(""), null);
    assert.equal(parseShortcut("Escape").hasModifiers, false);
    assert.equal(matchesShortcut(plain("z", { metaKey: true }), "Mod+z"), true, "Cmd counts as Mod");
    assert.equal(matchesShortcut(plain("z", { ctrlKey: true }), "Mod+z"), true, "Ctrl counts as Mod");
    assert.equal(matchesShortcut(plain("z"), "Mod+z"), false);
    assert.equal(matchesShortcut(plain("z", { metaKey: true }), "z"), false, "a bare letter never fires with Cmd held");
    assert.equal(matchesShortcut(plain("z"), "z"), true);
    assert.equal(matchesShortcut(plain("z", { metaKey: true, shiftKey: true }), "Shift+Mod+z"), true);
    assert.equal(matchesShortcut(plain("z", { metaKey: true }), "Shift+Mod+z"), false);
    assert.equal(matchesShortcut(plain("z", { metaKey: true, shiftKey: true }), "Mod+z"), false, "extra Shift does not match a Shift-less binding");
    assert.equal(matchesShortcut(plain("y", { ctrlKey: true }), "Ctrl+y"), true);
    assert.equal(matchesShortcut(plain("y", { metaKey: true }), "Ctrl+y"), false, "Ctrl bindings are literal");
    assert.equal(matchesShortcut(plain("Escape", { ctrlKey: true }), "Escape"), true, "named keys keep matching regardless of modifiers");
    assert.equal(matchesShortcut(plain("Delete"), ["Delete", "Backspace"]), true);
    assert.equal(matchesShortcut(plain("g", { metaKey: true, altKey: true }), "Mod+g"), false);
    assert.equal(matchesShortcut(plain("g", { metaKey: true, altKey: true }), "Alt+Mod+g"), true);
    assert.equal(matchesShortcut({ key: undefined }, "Mod+z"), false);
    const entries = [{ id: "undo", keys: "Mod+z", priority: 15 }, { id: "letter", keys: "z", priority: 0 }];
    assert.deepEqual(getShortcutCandidates(entries, { key: "z", metaKey: true, defaultPrevented: false, target: targetInside(false) }).map((entry) => entry.id), ["undo"]);
    assert.deepEqual(getShortcutCandidates(entries, { key: "z", defaultPrevented: false, target: targetInside(false) }).map((entry) => entry.id), ["letter"]);
});
