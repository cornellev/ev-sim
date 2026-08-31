import {
    RUN_BUNDLE_KIND,
    RUN_BUNDLE_VERSION,
    RUN_MANIFEST_KIND,
    RUN_MANIFEST_VERSION,
    canonicalStringify,
    computeResolvedRunHash,
} from "../../app/simulation/RunManifest.js";
import { computeSimulationSemanticHash } from "../../app/simulation/kernel/SimulationHashes.js";
import { HeadlessEpisodeError } from "../../app/simulation/headless/HeadlessErrors.js";
import { assertWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { assertLidarGeometryResource } from "../../app/simulation/lidar/LidarGeometry.js";
import { assertRenderSceneResource } from "../../app/simulation/render/RenderScene.js";

function invalid(code, message, details = null) {
    throw new HeadlessEpisodeError(code, message, details);
}

/** Verify an immutable portable bundle without resolving or importing authoring data. */
export function verifyRunBundle(bundle) {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
        invalid("BUNDLE_INVALID", "A portable cev-sim.run-bundle document is required.");
    }
    if (bundle.kind !== RUN_BUNDLE_KIND || Number(bundle.version) !== RUN_BUNDLE_VERSION) {
        invalid("BUNDLE_INVALID", `Unsupported run bundle; expected ${RUN_BUNDLE_KIND} version ${RUN_BUNDLE_VERSION}.`);
    }
    const resolved = bundle.resolved;
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
        invalid("BUNDLE_INVALID", "The run bundle does not contain an immutable resolved run.");
    }
    if (resolved.kind !== RUN_MANIFEST_KIND || Number(resolved.version) !== RUN_MANIFEST_VERSION) {
        invalid("BUNDLE_INVALID", `The resolved run must use ${RUN_MANIFEST_KIND} version ${RUN_MANIFEST_VERSION}.`);
    }
    if (!bundle.manifest || canonicalStringify(bundle.manifest) !== canonicalStringify(resolved.manifest)) {
        invalid("BUNDLE_INVALID", "The bundle manifest does not match the resolved manifest.");
    }
    if (!resolved.world?.description || !resolved.world?.hash) {
        invalid("BUNDLE_INVALID", "The resolved run is missing its world description or world hash.");
    }
    try {
        assertWorldResource(resolved.world);
    } catch (error) {
        invalid("BUNDLE_HASH_MISMATCH", error.message);
    }
    if (resolved.dependencyHashes?.world !== resolved.world.hash) {
        invalid("BUNDLE_HASH_MISMATCH", "The resolved world dependency hash does not match the world resource.");
    }
    const requestsLidar = resolved.manifest.sensorRig?.sensors?.some(
        (sensor) => sensor.enabled !== false && sensor.type === "lidar3d",
    );
    if (requestsLidar && !resolved.lidarGeometry) {
        invalid(
            "BUNDLE_INVALID",
            "This LiDAR run bundle predates persisted geometry twins; re-resolve and export the run manifest.",
        );
    }
    if (resolved.lidarGeometry) {
        if (!requestsLidar) {
            invalid("BUNDLE_INVALID", "A non-LiDAR bundle must not persist LiDAR geometry twins.");
        }
        try {
            assertLidarGeometryResource(resolved.lidarGeometry);
        } catch (error) {
            invalid("BUNDLE_HASH_MISMATCH", error.message);
        }
        if (resolved.dependencyHashes?.lidarGeometry !== resolved.lidarGeometry.hash) {
            invalid("BUNDLE_HASH_MISMATCH", "The resolved LiDAR geometry dependency hash does not match the geometry resource.");
        }
    } else if (resolved.dependencyHashes?.lidarGeometry) {
        invalid("BUNDLE_INVALID", "A non-LiDAR bundle must not declare a LiDAR geometry dependency hash.");
    }
    const requestsCamera = resolved.manifest.sensorRig?.sensors?.some(
        (sensor) => sensor.enabled !== false && sensor.type === "camera",
    );
    if (requestsCamera && !resolved.renderScene) {
        invalid(
            "BUNDLE_INVALID",
            "This camera run bundle predates persisted render scenes; re-resolve and export the run manifest.",
        );
    }
    if (resolved.renderScene) {
        if (!requestsCamera) invalid("BUNDLE_INVALID", "A non-camera bundle must not persist a render scene.");
        try {
            assertRenderSceneResource(resolved.renderScene);
        } catch (error) {
            invalid("BUNDLE_HASH_MISMATCH", error.message);
        }
        if (resolved.dependencyHashes?.renderScene !== resolved.renderScene.hash) {
            invalid("BUNDLE_HASH_MISMATCH", "The resolved render-scene dependency hash does not match the resource.");
        }
    } else if (resolved.dependencyHashes?.renderScene) {
        invalid("BUNDLE_INVALID", "A non-camera bundle must not declare a render-scene dependency hash.");
    }
    if (!Array.isArray(resolved.backendSelections) || resolved.backendSelections.length === 0) {
        invalid("BUNDLE_INVALID", "The resolved run is missing backend selections.");
    }
    const resolvedHash = computeResolvedRunHash(resolved);
    if (!bundle.resolvedHash || !resolved.resolvedHash
        || bundle.resolvedHash !== resolved.resolvedHash
        || bundle.resolvedHash !== resolvedHash) {
        invalid("BUNDLE_HASH_MISMATCH", "The run bundle resolved hash is invalid.", {
            expected: resolvedHash,
            bundle: bundle.resolvedHash ?? null,
            resolved: resolved.resolvedHash ?? null,
        });
    }
    const simulationSemanticHash = computeSimulationSemanticHash(resolved);
    if (!bundle.simulationSemanticHash || !resolved.simulationSemanticHash
        || bundle.simulationSemanticHash !== resolved.simulationSemanticHash
        || bundle.simulationSemanticHash !== simulationSemanticHash) {
        invalid("BUNDLE_HASH_MISMATCH", "The run bundle simulation semantic hash is invalid.", {
            expected: simulationSemanticHash,
            bundle: bundle.simulationSemanticHash ?? null,
            resolved: resolved.simulationSemanticHash ?? null,
        });
    }
    return {
        bundle,
        resolved,
        resolvedHash,
        simulationSemanticHash,
    };
}
