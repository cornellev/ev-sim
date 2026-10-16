import assert from "node:assert/strict";
import test from "node:test";

import {
    formatReimportResult,
    localPackageImported,
    localPackageInstallState,
    selectLocalPackage,
    selectPackageHash,
} from "../app/plugin/ui/pluginSelection.js";

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

test("localPackageImported matches any library row for the plugin id", () => {
    const entry = { id: "folder", document: { id: "acme.controls", version: "1.1.0" } };
    assert.equal(localPackageImported(entry, []), false);
    assert.equal(localPackageImported(entry, [second]), true);
    assert.equal(localPackageImported({ id: "acme.controls" }, [first]), true);
    assert.equal(localPackageImported(null, [first]), false);
});

test("formatReimportResult summarizes adopted documents", () => {
    assert.equal(formatReimportResult({ unchanged: true, updated: { vehicles: ["a"] } }), "Already current.");
    assert.equal(formatReimportResult({ updated: { vehicles: [], scripts: [], runManifests: [] } }), "Imported.");
    assert.equal(formatReimportResult({
        updated: { vehicles: ["truck"], scripts: ["scale"], runManifests: ["run"] },
    }), "Updated 1 vehicle, 1 script, 1 run manifest.");
    assert.equal(formatReimportResult({
        updated: { vehicles: ["a", "b"], scripts: [], runManifests: [] },
    }), "Updated 2 vehicles.");
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
    const plant = {
        ...detected,
        sourceFingerprint: "abc",
        directory: "acme.controls",
    };
    assert.equal(localPackageInstallState(plant, [same], [{
        directoryKey: "acme.controls",
        sourceFingerprint: "abc",
    }]), "installed");
    assert.equal(localPackageInstallState(plant, [same], [{
        directoryKey: "acme.controls",
        sourceFingerprint: "def",
    }]), "update-available");
});

test("selectPackageHash distinguishes versions of the same plugin id", () => {
    assert.equal(selectPackageHash([first, second], first.packageHash), first.packageHash);
    assert.notEqual(first.packageHash, second.packageHash);
    assert.equal(first.pluginId, second.pluginId);
});
