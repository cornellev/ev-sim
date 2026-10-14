import assert from "node:assert/strict";
import test from "node:test";

import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { createBlankVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import {
    assertLegacyVehicleIdentity,
    characterizationDigest,
    loadVehicleIdentityLedger,
    vehicleDependencyHash,
} from "./helpers/vehicleIdentityLedger.js";

test("VEH-09a legacy vehicle identities stay pinned", async () => {
    const ledger = await loadVehicleIdentityLedger();
    assert.equal(ledger.kind, "cev-sim.vehicle-editor-identity");
    assert.equal(ledger.version, 1);
    await assertLegacyVehicleIdentity(ledger);
    assert.equal(await characterizationDigest(), ledger.characterizationSha256);
});

test("VEH-09a dependency hashes omit stage, journal, and GitHub provenance", () => {
    const manifest = createBlankVehicleManifest({ id: "ledger-car", name: "Ledger" });
    const assetHashes = {};
    const clean = { manifest, assetHashes };
    const withProvenance = {
        manifest,
        assetHashes,
        stageId: "stage-1",
        operationId: "ab".repeat(32),
        journal: { phase: "prepared" },
        receipt: { revision: 1 },
        preMigrationSnapshot: { kind: "cev-sim.vehicle-pre-migration" },
        githubSource: { kind: "github", commit: "a".repeat(40) },
        paneLayout: { hierarchy: 0.2 },
    };
    assert.equal(
        vehicleDependencyHash(withProvenance.manifest, withProvenance.assetHashes),
        vehicleDependencyHash(clean.manifest, clean.assetHashes),
    );
    assert.equal(vehicleDependencyHash(clean.manifest, clean.assetHashes), computeResolvedRunHash(clean));
    assert.notEqual(computeResolvedRunHash(withProvenance), computeResolvedRunHash(clean));
});
