import {
    RUN_BUNDLE_KIND,
    RUN_BUNDLE_VERSION,
    RUN_MANIFEST_KIND,
    canonicalStringify,
    computeResolvedRunHash,
} from "../../app/simulation/RunManifest.js";
import { IDENTITY_PROTOCOL_MINOR, simulationIdentityVersion } from "../../app/simulation/kernel/RunIdentity.js";
import {
    VISUAL_RENDER_PROVIDERS,
    assertVisualLayer,
    canonicalExactStringify,
    hashVisualLayer,
    parseExactJson,
    sha256ExactBytes,
} from "../../app/simulation/visual/VisualLayer.js";
import { computeSimulationSemanticHash } from "../../app/simulation/kernel/SimulationHashes.js";
import { HeadlessEpisodeError } from "../../app/simulation/headless/HeadlessErrors.js";
import { assertWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { assertLidarGeometryResource } from "../../app/simulation/lidar/LidarGeometry.js";
import { assertRenderSceneResource } from "../../app/simulation/render/RenderScene.js";
import {
    RenderSceneProviderError,
    renderSceneProviderRegistry,
} from "../../app/simulation/render/RenderSceneProviderRegistry.js";
import {
    assertPbrRunEvidence,
    hashPbrRunEvidence,
} from "../../app/simulation/render/PbrRenderScene.js";

function invalid(code, message, details = null) {
    throw new HeadlessEpisodeError(code, message, details);
}

/** Verify received immutable content before any authoring migration or execution. */
export function verifyRunBundleIntegrity(bundle) {
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
    if (resolved.kind !== RUN_MANIFEST_KIND || !Number.isInteger(resolved.version)
        || resolved.version < 1 || resolved.version > 11) {
        invalid("BUNDLE_INVALID", "Unsupported resolved run manifest version; expected 1–11.");
    }
    let identityVersion;
    try {
        identityVersion = simulationIdentityVersion(resolved);
        if (identityVersion === 2) canonicalExactStringify(bundle);
    } catch (error) {
        invalid("BUNDLE_INVALID", error.message);
    }
    const stringify = identityVersion === 2 ? canonicalExactStringify : canonicalStringify;
    if (!bundle.manifest || stringify(bundle.manifest) !== stringify(resolved.manifest)) {
        invalid("BUNDLE_INVALID", "The bundle manifest does not match the resolved manifest.");
    }
    const resolvedHash = computeResolvedRunHash(resolved);
    if (!bundle.resolvedHash || (resolved.version >= 10 && !resolved.resolvedHash)
        || (resolved.resolvedHash && bundle.resolvedHash !== resolved.resolvedHash)
        || bundle.resolvedHash !== resolvedHash) {
        invalid("BUNDLE_HASH_MISMATCH", "The run bundle resolved hash is invalid.", {
            expected: resolvedHash,
            bundle: bundle.resolvedHash ?? null,
            resolved: resolved.resolvedHash ?? null,
        });
    }
    const simulationSemanticHash = computeSimulationSemanticHash(resolved);
    if ((resolved.version >= 10 && (!bundle.simulationSemanticHash || !resolved.simulationSemanticHash))
        || (bundle.simulationSemanticHash && bundle.simulationSemanticHash !== simulationSemanticHash)
        || (resolved.simulationSemanticHash && resolved.simulationSemanticHash !== simulationSemanticHash)) {
        invalid("BUNDLE_HASH_MISMATCH", "The run bundle simulation semantic hash is invalid.", {
            expected: simulationSemanticHash,
            bundle: bundle.simulationSemanticHash ?? null,
            resolved: resolved.simulationSemanticHash ?? null,
        });
    }
    const verified = {
        bundle,
        resolved,
        resolvedHash,
        simulationSemanticHash,
        identityVersion,
        requiredProtocolMinor: identityVersion === 2 ? IDENTITY_PROTOCOL_MINOR : 0,
    };
    // Corrected v11 bundles authenticate every nested portable resource even
    // when the caller is performing inspection rather than execution.
    if (identityVersion === 2) verifyBundleStructure(verified, { requireRuntime: false });
    return verified;
}

function invalidRenderSelection(error) {
    if (!(error instanceof RenderSceneProviderError)) throw error;
    const capability = [
        "UNKNOWN_PROVIDER",
        "UNKNOWN_PROVIDER_VERSION",
        "PROVIDER_UNAVAILABLE",
        "UNKNOWN_PRODUCT_PROFILE",
        "UNSUPPORTED_RENDERED_PRODUCT",
    ].includes(error.code);
    invalid(capability ? "UNSUPPORTED_CAPABILITY" : "BUNDLE_INVALID", error.message, error.details);
}

function verifyBundleStructure(verified, { requireRuntime = false } = {}) {
    const { resolved } = verified;
    if (resolved.manifest?.kind !== RUN_MANIFEST_KIND || resolved.manifest.version !== resolved.version) {
        invalid("BUNDLE_INVALID", "Resolved and authored manifest versions must agree.");
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
    const sensors = resolved.manifest.sensorRig?.sensors ?? [];
    const requestsLidar = sensors.some((sensor) => sensor.enabled !== false && sensor.type === "lidar3d");
    if (requestsLidar && !resolved.lidarGeometry) {
        invalid("BUNDLE_INVALID", "This LiDAR run bundle predates persisted geometry twins; re-resolve and export the run manifest.");
    }
    if (resolved.lidarGeometry) {
        if (!requestsLidar) invalid("BUNDLE_INVALID", "A non-LiDAR bundle must not persist LiDAR geometry twins.");
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

    const requestsCamera = sensors.some((sensor) => sensor.enabled !== false && sensor.type === "camera");
    if (requestsCamera && !resolved.renderScene) {
        invalid("BUNDLE_INVALID", "This camera run bundle predates persisted render scenes; re-resolve and export the run manifest.");
    }
    let selection = null;
    if (resolved.renderScene) {
        if (!requestsCamera) invalid("BUNDLE_INVALID", "A non-camera bundle must not persist a render scene.");
        try {
            selection = renderSceneProviderRegistry.assertMatchesScene(sensors, resolved.renderScene, {
                requireAvailable: requireRuntime,
                target: "headless",
            });
        } catch (error) {
            invalidRenderSelection(error);
        }
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

    const pbrSelected = selection?.provider?.id === VISUAL_RENDER_PROVIDERS.pbrMesh.id
        && selection.provider.version === VISUAL_RENDER_PROVIDERS.pbrMesh.version;
    if (pbrSelected) {
        if (!resolved.visualLayer?.description || !resolved.visualLayer?.hash) {
            invalid("BUNDLE_INVALID", "A pbr-mesh@1 bundle requires an immutable visual-layer resource.");
        }
        try {
            assertVisualLayer(resolved.visualLayer.description);
            if (hashVisualLayer(resolved.visualLayer.description) !== resolved.visualLayer.hash) {
                throw new Error("Resolved visual-layer hash does not match its exact description.");
            }
            if (resolved.visualLayer.description.sourceWorldHash !== resolved.world.hash) {
                throw new Error("Resolved visual layer is bound to a different world.");
            }
        } catch (error) {
            invalid("BUNDLE_HASH_MISMATCH", error.message);
        }
        if (resolved.dependencyHashes?.visualLayer !== resolved.visualLayer.hash) {
            invalid("BUNDLE_HASH_MISMATCH", "The visual-layer dependency hash does not match the resource.");
        }
        if (resolved.renderScene.description.worldHash !== resolved.world.hash
            || resolved.renderScene.description.visualLayerHash !== resolved.visualLayer.hash) {
            invalid("BUNDLE_HASH_MISMATCH", "The PBR render scene does not bind the resolved world and visual layer.");
        }
        if (!resolved.evidence) invalid("BUNDLE_INVALID", "A pbr-mesh@1 bundle requires visual asset evidence.");
        try {
            assertPbrRunEvidence(resolved.evidence, {
                visualLayer: resolved.visualLayer,
                renderScene: resolved.renderScene,
            });
        } catch (error) {
            invalid("BUNDLE_HASH_MISMATCH", error.message);
        }
        const evidenceHash = hashPbrRunEvidence(resolved.evidence);
        if (resolved.dependencyHashes?.evidence !== evidenceHash) {
            invalid("BUNDLE_HASH_MISMATCH", "The visual evidence dependency hash does not match the exact evidence document.");
        }
    } else if (resolved.visualLayer || resolved.dependencyHashes?.visualLayer
        || resolved.evidence || resolved.dependencyHashes?.evidence) {
        invalid("BUNDLE_INVALID", "Only a selected pbr-mesh@1 camera may persist visual-layer run resources or evidence.");
    }
    if (!Array.isArray(resolved.backendSelections) || resolved.backendSelections.length === 0) {
        invalid("BUNDLE_INVALID", "The resolved run is missing backend selections.");
    }
}

/** Execution accepts only implemented immutable versions; no normalization here. */
export function verifyRunBundle(bundle) {
    const verified = verifyRunBundleIntegrity(bundle);
    const { resolved } = verified;
    if (![10, 11].includes(resolved.version)) {
        invalid("UNSUPPORTED_CAPABILITY", "Historical bundles require authoring import and re-resolution before execution.");
    }
    verifyBundleStructure(verified, { requireRuntime: true });
    return verified;
}

const receivedBytes = new WeakMap();

export function canonicalRunBundleStringify(bundle) {
    return simulationIdentityVersion(bundle.resolved) === 2
        ? canonicalExactStringify(bundle) : canonicalStringify(bundle);
}

/** Original bytes are operational metadata and are never inserted into the document. */
export function runBundleBytes(bundle) {
    const received = receivedBytes.get(bundle);
    const canonical = canonicalRunBundleStringify(bundle);
    if (received && received.canonical !== canonical) {
        invalid("BUNDLE_INVALID", "Received immutable bundle content changed; create an explicit new serialization.");
    }
    return new Uint8Array(received?.bytes ?? new TextEncoder().encode(canonical));
}

export function verifyRunBundleBytes(input, { expectedBundleBytesHash, execution = true } = {}) {
    if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
        invalid("BUNDLE_INVALID", "Run bundle byte verification requires an ArrayBuffer or typed-array view.");
    }
    const bytes = new Uint8Array(input instanceof ArrayBuffer
        ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    const bundleBytesHash = sha256ExactBytes(bytes);
    if (expectedBundleBytesHash !== undefined && expectedBundleBytesHash !== bundleBytesHash) {
        invalid("BUNDLE_HASH_MISMATCH", "The exact run bundle byte digest does not match.");
    }
    let bundle;
    try {
        bundle = parseExactJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch (error) {
        invalid("BUNDLE_INVALID", `Invalid run bundle JSON: ${error.message}`);
    }
    const verified = execution ? verifyRunBundle(bundle) : verifyRunBundleIntegrity(bundle);
    receivedBytes.set(bundle, { bytes, canonical: canonicalRunBundleStringify(bundle) });
    return { ...verified, bundleBytes: new Uint8Array(bytes), bundleBytesHash };
}

export function cloneRunBundle(bundle) {
    const clone = structuredClone(bundle);
    if (receivedBytes.has(bundle)) {
        receivedBytes.set(clone, { bytes: runBundleBytes(bundle), canonical: canonicalRunBundleStringify(bundle) });
    }
    return clone;
}
