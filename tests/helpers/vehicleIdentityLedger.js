import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeResolvedRunHash } from "../../app/simulation/RunManifest.js";
import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import {
    createBlankVehicleManifest,
    createDefaultVehicleManifest,
} from "../../app/vehicles/VehicleManifest.js";
import { StorageService } from "../../server/storage/StorageService.js";

const ledgerUrl = new URL("../fixtures/vehicle-editor/identity.v1.json", import.meta.url);
const characterizationUrl = new URL("../fixtures/headless/characterization.v1.json", import.meta.url);

export async function loadVehicleIdentityLedger() {
    return JSON.parse(await fs.readFile(ledgerUrl, "utf8"));
}

export function vehicleDependencyHash(manifest, assetHashes = {}) {
    return computeResolvedRunHash({ manifest, assetHashes });
}

export async function assertLegacyVehicleIdentity(ledger) {
    const legacy = ledger.legacy;
    if (computeResolvedRunHash(getBuiltInVehicleManifest("big-car")) !== legacy["big-car"]) {
        throw new Error("big-car identity moved.");
    }
    if (computeResolvedRunHash(getBuiltInVehicleManifest("igvc-car")) !== legacy["igvc-car"]) {
        throw new Error("igvc-car identity moved.");
    }
    if (computeResolvedRunHash(getBuiltInVehicleManifest("scenario-car")) !== legacy["scenario-car"]) {
        throw new Error("scenario-car identity moved.");
    }
    if (computeResolvedRunHash(createDefaultVehicleManifest()) !== legacy.defaultBlank) {
        throw new Error("version 2 blank identity moved.");
    }
    if (computeResolvedRunHash(createBlankVehicleManifest()) !== legacy.blankV3Definition) {
        throw new Error("version 3 blank identity moved.");
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veh09-ledger-"));
    try {
        const service = new StorageService(dir);
        await service.createVehicleManifest(createDefaultVehicleManifest({
            id: "portable-truck",
            model: { asset: "model.glb", scale: 0.5, rotation: {}, offset: {} },
        }));
        await service.putVehicleAsset("portable-truck", "model.glb", Buffer.from("model-bytes"));
        const bundle = await service.exportVehicleBundle("portable-truck");
        if (bundle.bundleHash !== legacy.portableTruckBundle) {
            throw new Error(`portable-truck bundle hash moved to ${bundle.bundleHash}.`);
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

export async function characterizationDigest() {
    const bytes = await fs.readFile(characterizationUrl);
    return createHash("sha256").update(bytes).digest("hex");
}
