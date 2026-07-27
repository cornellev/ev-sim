import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

const APP_DIR = path.resolve("app");
const BLUR_ALLOWLIST = new Set([
    "3d/overlay/ui/FlyoutPanel.js",
    "scripting/Scripting.js",
    "scripting/bindings/BindingsPage.js",
    "vehicles/editor/VehicleEditorPage.js",
]);

async function sourceFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(target);
        return /\.(js|jsx)$/.test(entry.name) ? [target] : [];
    }));
    return nested.flat();
}

test("interface source follows the shared visual contract", async () => {
    const files = await sourceFiles(APP_DIR);
    const violations = [];

    for (const file of files) {
        const relative = path.relative(APP_DIR, file);
        const source = await fs.readFile(file, "utf8");
        if (/from\s+["']react-icons/.test(source)) violations.push(`${relative}: react-icons import`);
        if (/transition-all/.test(source)) violations.push(`${relative}: transition-all`);
        if (/text-\[(?:7|8|9|10)px\]/.test(source)) violations.push(`${relative}: text below 11px`);
        if (/rounded-(?:xl|2xl|3xl)/.test(source)) violations.push(`${relative}: oversized radius`);
        if (/backdrop-blur/.test(source) && !BLUR_ALLOWLIST.has(relative)) violations.push(`${relative}: unapproved backdrop blur`);
    }

    assert.deepEqual(violations, [], violations.join("\n"));
});
