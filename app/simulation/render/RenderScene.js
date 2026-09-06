import {
    LIDAR_GEOMETRY_KIND,
    LIDAR_GEOMETRY_VERSION,
    assertLidarGeometryDescription,
    createLidarGeometry,
} from "../lidar/LidarGeometry.js";
import { canonicalizeSimulationValue, simulationSha256 } from "../kernel/SimulationHashes.js";
import { compareUtf8 } from "../world/WorldDescription.js";
import {
    bindCanonicalAnalyticRenderScene,
    renderSceneProviderRegistry,
} from "./RenderSceneProviderRegistry.js";

export const RENDER_SCENE_KIND = "cev-sim.render-scene";
export const RENDER_SCENE_VERSION = 1;
export const ANALYTIC_RENDER_SCENE_PROVIDER_ID = "canonical-analytic";
export const ANALYTIC_RENDER_SCENE_PROVIDER_VERSION = 1;

export class RenderSceneProvider {
    constructor({ id, version }) {
        if (new.target === RenderSceneProvider) throw new TypeError("RenderSceneProvider is an abstract boundary.");
        this.id = String(id);
        this.version = Number(version);
    }

    resolve() {
        throw new Error("RenderSceneProvider.resolve must be implemented.");
    }
}

function colorForSemanticId(semanticId) {
    const value = Number(semanticId) >>> 0;
    return [
        48 + ((value * 97) % 176),
        48 + ((value * 57 + 43) % 176),
        48 + ((value * 23 + 91) % 176),
        255,
    ];
}

export function createRenderScene(worldResource, vehicleDependencies = []) {
    const geometry = createLidarGeometry(worldResource, vehicleDependencies);
    const semanticIds = [...new Set([
        ...geometry.staticPrimitives.map((entry) => entry.semanticId),
        ...geometry.actors.flatMap((actor) => actor.primitives.map((entry) => entry.semanticId)),
    ])].sort((left, right) => left - right);
    return canonicalizeSimulationValue({
        kind: RENDER_SCENE_KIND,
        version: RENDER_SCENE_VERSION,
        provider: {
            id: ANALYTIC_RENDER_SCENE_PROVIDER_ID,
            version: ANALYTIC_RENDER_SCENE_PROVIDER_VERSION,
        },
        coordinateFrame: geometry.coordinateFrame,
        staticPrimitives: geometry.staticPrimitives,
        actors: geometry.actors,
        materials: semanticIds.map((semanticId) => ({
            id: `semantic-${semanticId}`,
            semanticId,
            colorRgba: colorForSemanticId(semanticId),
        })).sort((left, right) => compareUtf8(left.id, right.id)),
    });
}

export function assertCanonicalAnalyticRenderSceneDescription(description) {
    if (description?.kind !== RENDER_SCENE_KIND || Number(description.version) !== RENDER_SCENE_VERSION) {
        throw new TypeError(`Expected ${RENDER_SCENE_KIND} v${RENDER_SCENE_VERSION}.`);
    }
    if (description.provider?.id !== ANALYTIC_RENDER_SCENE_PROVIDER_ID
        || Number(description.provider?.version) !== ANALYTIC_RENDER_SCENE_PROVIDER_VERSION) {
        throw new TypeError("Unsupported render-scene provider.");
    }
    assertLidarGeometryDescription({
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: description.coordinateFrame,
        staticPrimitives: description.staticPrimitives,
        actors: description.actors,
    });
    if (!Array.isArray(description.materials)) throw new TypeError("Render scene requires a materials array.");
    const ids = description.materials.map((entry) => String(entry?.id || ""));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length
        || [...ids].sort(compareUtf8).some((id, index) => id !== ids[index])) {
        throw new TypeError("Render-scene material IDs must be unique and in canonical UTF-8 order.");
    }
    const rebuilt = canonicalizeSimulationValue({
        kind: RENDER_SCENE_KIND,
        version: RENDER_SCENE_VERSION,
        provider: description.provider,
        coordinateFrame: description.coordinateFrame,
        staticPrimitives: description.staticPrimitives,
        actors: description.actors,
        materials: description.materials,
    });
    if (simulationSha256(rebuilt) !== simulationSha256(description)) {
        throw new TypeError("Render scene contains non-canonical fields.");
    }
    return description;
}

export function hashCanonicalAnalyticRenderScene(description) {
    assertCanonicalAnalyticRenderSceneDescription(description);
    return simulationSha256(description);
}

function createCanonicalAnalyticRenderSceneResource(worldResource, vehicleDependencies = []) {
    const description = createRenderScene(worldResource, vehicleDependencies);
    return { description, hash: hashCanonicalAnalyticRenderScene(description) };
}

bindCanonicalAnalyticRenderScene({
    createResource: createCanonicalAnalyticRenderSceneResource,
    assertDescription: assertCanonicalAnalyticRenderSceneDescription,
});

export function assertRenderSceneDescription(description) {
    return renderSceneProviderRegistry.assertDescription(description);
}

export function hashRenderScene(description) {
    assertRenderSceneDescription(description);
    return simulationSha256(description);
}

export function createRenderSceneResource(worldResource, vehicleDependencies = [], selection) {
    return renderSceneProviderRegistry.resolveResource(worldResource, vehicleDependencies, selection);
}

export class CanonicalAnalyticRenderSceneProvider extends RenderSceneProvider {
    constructor() {
        super({
            id: ANALYTIC_RENDER_SCENE_PROVIDER_ID,
            version: ANALYTIC_RENDER_SCENE_PROVIDER_VERSION,
        });
    }

    resolve(worldResource, vehicleDependencies = []) {
        return createRenderSceneResource(worldResource, vehicleDependencies);
    }
}

export function assertRenderSceneResource(resource) {
    if (!resource?.description || !resource?.hash) throw new TypeError("Resolved render-scene resource is required.");
    const hash = hashRenderScene(resource.description);
    if (hash !== resource.hash) throw new Error(`Resolved render-scene hash mismatch: expected ${resource.hash}, computed ${hash}.`);
    return resource.description;
}
