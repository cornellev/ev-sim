import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    computeEpisodeHash,
    defaultEpisodeIdentity,
} from "../../app/simulation/kernel/SimulationHashes.js";
import { createDefaultRunManifest, normalizeRunManifest } from "../../app/simulation/RunManifest.js";
import { StorageService } from "../../server/storage/StorageService.js";

function acceptanceRun(vehicleId) {
    const run = createDefaultRunManifest({ id: `veh09-${vehicleId}` });
    run.initialState.vehicles[0].type = vehicleId;
    run.sensorRig = {
        ...run.sensorRig,
        sensors: run.sensorRig.sensors.map((sensor) => (
            sensor.type === "camera" ? { ...sensor, enabled: false } : sensor
        )),
    };
    return normalizeRunManifest(run);
}

export async function createVehicleAcceptanceHarness() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veh09-"));
    let service = new StorageService(dir);
    await service.putEnvironment("igvc", { environmentId: "igvc" }, { create: true });

    return {
        get dir() { return dir; },
        get service() { return service; },
        restart(options = {}) {
            service = new StorageService(dir, options);
            return service;
        },
        async resolveRun(vehicleId) {
            return service.resolveRunManifest(`veh09-${vehicleId}`, acceptanceRun(vehicleId));
        },
        async snapshotIdentity(vehicleId) {
            const stored = await service.getVehicleManifest(vehicleId);
            if (!stored) throw new Error(`Vehicle "${vehicleId}" does not exist.`);
            const visible = await service.readVehicleSnapshot(vehicleId);
            const resolved = await service.resolveRunManifest(`veh09-${vehicleId}`, acceptanceRun(vehicleId));
            const dependency = resolved.vehicles.find((entry) => entry.actorId === "ego");
            const bundle = await service.exportVehicleBundle(vehicleId);
            return Object.freeze({
                definitionHash: stored.definitionHash,
                assetNames: visible.files.map((file) => file.name),
                assetHashes: dependency.assetHashes,
                dependencyHash: dependency.hash,
                bundleHash: bundle.bundleHash,
                resolvedHash: resolved.resolvedHash,
                simulationSemanticHash: resolved.simulationSemanticHash,
                episodeHash: computeEpisodeHash(defaultEpisodeIdentity(resolved)),
                resolved,
            });
        },
        async dispose() {
            await fs.rm(dir, { recursive: true, force: true });
        },
    };
}
