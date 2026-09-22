import assert from "node:assert/strict";
import test from "node:test";

import { localPackageInstallState, selectLocalPackage, selectPackageHash } from "../app/plugin/ui/pluginSelection.js";

const first = { pluginId: "acme.controls", version: "1.0.0", packageHash: "a".repeat(64) };
const second = { pluginId: "acme.controls", version: "2.0.0", packageHash: "b".repeat(64) };

test("selectPackageHash returns null for an empty library", () => {
    assert.equal(selectPackageHash([], "a".repeat(64)), null);
    assert.equal(selectPackageHash([], null), null);
});

test("selectPackageHash keeps the current package hash", () => {
    assert.equal(selectPackageHash([first, second], second.packageHash), second.packageHash);
});

test("selectPackageHash falls back to the first package", () => {
    assert.equal(selectPackageHash([first, second], "c".repeat(64)), first.packageHash);
    assert.equal(selectPackageHash([first, second], null), first.packageHash);
});

test("selectLocalPackage keeps the current directory and otherwise uses the first row", () => {
    const packages = [
        { directory: "acme.controls", id: "acme.controls" },
        { directory: "helios32/package", id: "vendor.robosense.helios32" },
    ];
    assert.equal(selectLocalPackage(packages, "helios32/package"), "helios32/package");
    assert.equal(selectLocalPackage(packages, "missing"), "acme.controls");
    assert.equal(selectLocalPackage([], "helios32/package"), null);
});

test("localPackageInstallState matches plugin id and version", () => {
    const detected = { id: "acme.controls", version: "1.0.0", document: { id: "acme.controls", version: "1.0.0" } };
    const otherVersion = { pluginId: "acme.controls", version: "2.0.0" };
    const same = { pluginId: "acme.controls", version: "1.0.0" };
    assert.equal(localPackageInstallState(detected, []), "detected");
    assert.equal(localPackageInstallState(detected, [otherVersion]), "detected");
    assert.equal(localPackageInstallState(detected, [same]), "installed");
    assert.equal(localPackageInstallState({ id: "broken", error: "plugin.json is not valid JSON.", document: null }, [same]), "unavailable");
    assert.equal(localPackageInstallState(null, [same]), "unavailable");
});

test("selectPackageHash distinguishes versions of the same plugin id", () => {
    assert.equal(selectPackageHash([first, second], first.packageHash), first.packageHash);
    assert.notEqual(first.packageHash, second.packageHash);
    assert.equal(first.pluginId, second.pluginId);
});
