import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageService } from "../storage/StorageService.js";
import { selectRouteEndpoints } from "./PlanningBundle.js";

function scenarioDraft({ environmentId, actorId, endpoints }) {
    const point = (node) => ({ x: node.x, y: 0, z: node.z });
    return {
        kind: "cev-sim.scenario",
        version: 1,
        id: "igvc-headless-smoke",
        name: "IGVC Headless Smoke",
        description: "Generated verified route for headless GPU and CLI smoke tests.",
        folderId: null,
        environment: { id: environmentId, expectedHash: null },
        actors: [{
            id: actorId,
            name: "Ego",
            role: "ego",
            vehicleId: null,
            enabled: true,
        }],
        routes: [{
            id: "ego-route",
            name: "Ego route",
            actorId,
            initialSpeedMps: 0,
            waypoints: [{
                id: "start",
                order: 0,
                kind: "start",
                position: point(endpoints.start),
                heading: 0,
                anchor: {
                    kind: "road",
                    id: endpoints.edge.id,
                    fraction: endpoints.startFraction,
                },
            }, {
                id: "finish",
                order: 1,
                kind: "finish",
                position: point(endpoints.finish),
                heading: 0,
                anchor: {
                    kind: "road",
                    id: endpoints.edge.id,
                    fraction: endpoints.finishFraction,
                },
            }],
        }],
        zones: [],
        triggers: [{
            id: "finish-after-smoke",
            name: "Finish after smoke steps",
            enabled: true,
            once: true,
            condition: { kind: "step", step: 5 },
            actions: [{ kind: "finish" }],
        }],
        completion: { conditions: [] },
        expectedOutcomes: [],
        sensorAliases: [],
        parameters: [],
    };
}

export async function createHeadlessSmokeBundle({
    sourceManifestId = "igvc-default",
    storageFactory = (root) => new StorageService(root),
} = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-headless-smoke-"));
    try {
        const storage = storageFactory(root);
        const source = await storage.getRunManifest(sourceManifestId);
        if (!source) throw new Error(`Run manifest "${sourceManifestId}" does not exist.`);
        const environmentId = source.environment?.id;
        const environment = await storage.getEnvironment(environmentId, { full: true });
        const initial = source.initialState?.vehicles?.find((vehicle) => vehicle.id === "ego")
            ?? source.initialState?.vehicles?.[0];
        if (!initial) throw new Error("The smoke-bundle manifest has no Ego vehicle.");
        const scenario = scenarioDraft({
            environmentId,
            actorId: initial.id,
            endpoints: selectRouteEndpoints(environment, { initialPosition: initial.pose.position }),
        });
        const verified = await storage.verifyScenarioRoute(scenario.id, {
            scenario,
            routeId: scenario.routes[0].id,
        });
        if (!verified.ok) {
            throw new Error(`Could not verify the smoke-bundle Ego route: ${verified.issues?.[0]?.message || "unknown route error"}`);
        }
        scenario.routes[0].waypoints = verified.waypoints;
        scenario.routes[0].verification = verified.verification;
        const storedScenario = await storage.createScenario(scenario);
        const manifest = await storage.createRunManifest({
            ...source,
            id: "igvc-headless-smoke",
            name: "IGVC Headless Smoke",
            description: "Portable GPU-enabled headless smoke run with a verified Ego route.",
            scenario: {
                id: storedScenario.id,
                expectedHash: storedScenario.definitionHash,
                egoVehicleId: initial.type,
                sensorBindings: {},
                parameterValues: {},
            },
        });
        return storage.exportRunManifest(manifest.id);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}
