import { computeResolvedRunHash } from "../../app/simulation/RunManifest.js";
import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import { DEFAULT_DYNAMIC_BICYCLE } from "../../app/vehicles/VehicleManifest.js";
import { createPortableHeadlessBundle, createPluginPortableHeadlessBundle, rehashRunBundle } from "./headlessRunnerBundle.js";
import { pluginFixtureResource } from "./pluginFixtures.js";

// Build historical content without authoring normalization, including after the v2 migration lands.
export async function contactHostBundle({ model, plugin = false, nested = false, resource = null } = {}) {
    resource ??= plugin ? await pluginFixtureResource({
        fixture: "test.plant-fixture",
        mutateDocument(document) {
            if (model) document.plants[0].model = model;
        },
    }) : null;
    const bundle = resource
        ? await createPluginPortableHeadlessBundle(resource, { sensors: [] })
        : await createPortableHeadlessBundle({ sensors: [] });
    const manifest = getBuiltInVehicleManifest("big-car");
    manifest.id = "host-contract-car";
    if (resource) {
        const selected = bundle.resolved.plugins[0];
        manifest.dynamics = { plant: "test.plant-fixture.bicycle" };
        manifest.pluginLocks = [{
            pluginId: selected.pluginId,
            version: selected.version,
            packageHash: selected.packageHash,
            runtimeHash: selected.runtimeHash,
            sensorTypes: [],
            plants: [manifest.dynamics.plant],
        }];
    } else if (model) {
        manifest.dynamics = { model, ...DEFAULT_DYNAMIC_BICYCLE };
    }
    const record = {
        actorId: nested ? "other" : "ego",
        vehicleId: manifest.id,
        manifest,
        assetHashes: {},
        hash: computeResolvedRunHash({ manifest, assetHashes: {} }),
    };
    if (nested) {
        bundle.resolved.scenario.vehicles = [record];
        bundle.resolved.scenario.dependencyHashes = { vehicles: { [record.vehicleId]: record.hash } };
    } else {
        bundle.resolved.vehicles = [record];
        bundle.resolved.manifest.initialState.vehicles[0].type = manifest.id;
        bundle.resolved.dependencyHashes.vehicles = { [record.vehicleId]: record.hash };
        bundle.resolved.dependencyHashes.vehicleAssets = { [record.vehicleId]: {} };
    }
    return rehashRunBundle(bundle);
}
