import {
    adaptLegacyBakeRunConfigInput,
    bakeRecipeIdentity,
    hashBakeRunConfig,
    interpolateBakePathSample,
    normalizeBakeRunConfig,
    pathLengthMeters,
    planIntegerSampleDistances,
    rotationToQuaternion,
} from "../visual/BakeRunCatalog.js";
import { SeededRNG } from "../../../util/SeededRNG.js";
import {
    ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES,
    DEFAULT_ATLAS_CONSTRUCTION,
    DEFAULT_PROJECTED_CONSTRUCTION,
    PROJECTED_PERSISTENT_BAKE_OUTPUT_ROLES,
    isChunkAtlasConstruction,
    normalizeBakeConstruction,
    persistentRolesForConstruction,
} from "../visual/BakeConstructionPolicy.js";

/**
 * @typedef {Object} BuildingRecord
 * @property {string} buildingId
 * @property {{ x: number, y: number, z: number }[]} footprint
 * @property {number} height
 * @property {number} textureId
 * @property {string[]} tags
 * @property {string} meshName
 */

function eulerFromQuaternion(rotation) {
    const q = rotationToQuaternion(rotation, "rotation");
    const sinrCosp = 2 * (q.w * q.x + q.y * q.z);
    const cosrCosp = 1 - 2 * (q.x * q.x + q.y * q.y);
    const sinp = 2 * (q.w * q.y - q.z * q.x);
    const sinyCosp = 2 * (q.w * q.z + q.x * q.y);
    const cosyCosp = 1 - 2 * (q.y * q.y + q.z * q.z);
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
    return {
        x: Math.atan2(sinrCosp, cosrCosp),
        y: pitch,
        z: Math.atan2(sinyCosp, cosyCosp),
        order: "XYZ",
    };
}

function classView(view) {
    return {
        name: view.id,
        id: view.id,
        position: { ...view.pose.position },
        rotation: eulerFromQuaternion(view.pose.rotation),
        pose: {
            position: { ...view.pose.position },
            rotation: { ...view.pose.rotation },
        },
        camera: { ...view.camera, distortion: [...view.camera.distortion] },
        calibration: view.calibration,
        includeTags: [...view.includeTags],
        excludeTags: [...view.excludeTags],
        products: [...view.products],
        passes: view.passes.map((pass) => ({ ...pass, includeTags: [...pass.includeTags], excludeTags: [...pass.excludeTags], maskTags: [...pass.maskTags] })),
        masks: { ...view.masks },
    };
}

function classPathVertices(path) {
    return path.vertices.map((vertex) => ({
        position: { ...vertex.position },
        rotation: eulerFromQuaternion(vertex.rotation),
    }));
}

/**
 * Serializable bake-run configuration. Pixel-affecting fields live on the
 * versioned `cev-sim.bake-run-config@1` document; endpoints, timeouts, debug
 * logging, and raw-capture retention stay in `operational` and never enter
 * `recipeHash`.
 */
export class BakeRunConfig {
    /**
     * @param {Object} [options]
     */
    constructor(options = {}) {
        const document = normalizeBakeRunConfig(adaptLegacyBakeRunConfigInput(options));
        this._document = document;
        this.environmentId = document.environmentId;
        this.seed = document.seed;
        this.runId = document.operational.runId;
        this.host = document.operational.host;
        this.endpoint = document.operational.endpoint;
        this.deltaDistance = document.sampling.deltaDistance;
        this.maskMinPixels = document.views[0]?.masks.minPixels ?? 64;
        this.passPolicy = { ...document.passPolicy };
        this.modelSettings = { ...document.operational.modelSettings };
        this.buildings = document.buildings.map((building) => ({
            ...building,
            footprint: building.footprint.map((point) => ({ ...point })),
            tags: [...building.tags],
        }));
        this.views = document.views.map(classView);
        this.pathVertices = classPathVertices(document.paths[0] ?? { vertices: [] });
        this.paths = document.paths.map((path) => ({
            id: path.id,
            vertices: classPathVertices(path),
        }));
        this.createdAt = document.operational.createdAt;
        this.roundTrip = { ...document.operational.roundTrip };
        this.debug = { ...document.operational.debug };
        this.splat = {
            ...document.operational.splat,
            excludeTags: [...document.operational.splat.excludeTags],
            projectedTexture: { ...document.operational.splat.projectedTexture },
            updateSliver: { ...document.operational.splat.updateSliver },
        };
        this.provider = { ...document.provider };
        this.providerOptions = { ...document.providerOptions };
        this.outputRoles = [...document.outputRoles];
        this.sampling = { ...document.sampling };
        this.planner = { ...document.planner };
        this.cachePolicy = { ...document.cachePolicy };
        this.snapshotPolicy = { ...document.snapshotPolicy };
        this.kind = document.kind;
        this.version = document.version;
        this.construction = document.construction ?? null;
    }

    document() {
        return this._document;
    }

    recipeHash() {
        return hashBakeRunConfig(this._document);
    }

    recipeIdentity() {
        return bakeRecipeIdentity(this._document);
    }

    /**
     * @returns {SeededRNG}
     */
    rng() {
        return new SeededRNG(this.seed);
    }

    /**
     * @returns {Object[]}
     */
    static defaultViews() {
        return createDefaultBakeRunConfig().views;
    }

    /**
     * @param {BuildingRecord[]} records
     */
    setBuildings(records) {
        const buildings = (Array.isArray(records) ? records : []).map((record) => ({
            ...record,
            footprint: (record.footprint ?? []).map((point) => ({
                ...point,
                y: point.y ?? 0,
            })),
        }));
        const next = normalizeBakeRunConfig({
            ...this._document,
            buildings,
        });
        this._document = next;
        this.buildings = next.buildings.map((building) => ({
            ...building,
            footprint: building.footprint.map((point) => ({ ...point })),
            tags: [...building.tags],
        }));
    }

    /**
     * @returns {Object}
     */
    toManifest() {
        return this._document;
    }

    static fromManifest(manifest) {
        return new BakeRunConfig(manifest);
    }
}

/**
 * @param {Object} [overrides]
 * @returns {BakeRunConfig}
 */
export function createDefaultBakeRunConfig(overrides = {}) {
    return new BakeRunConfig(overrides);
}

export function createLegacyCompatibleBakeRunConfig(overrides = {}) {
    if (overrides?.kind === "cev-sim.bake-run-config") {
        return new BakeRunConfig({
            ...overrides,
            operational: {
                ...overrides.operational,
                roundTrip: {
                    useModel: true,
                    ...(overrides.operational?.roundTrip ?? {}),
                },
                debug: {
                    saveRawCaptures: true,
                    ...(overrides.operational?.debug ?? {}),
                },
            },
        });
    }
    return new BakeRunConfig({
        ...overrides,
        roundTrip: { useModel: true, ...(overrides.roundTrip ?? {}) },
        debug: { saveRawCaptures: true, ...(overrides.debug ?? {}) },
    });
}

export const PERSISTENT_BAKE_OUTPUT_ROLES = ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES;
export { PROJECTED_PERSISTENT_BAKE_OUTPUT_ROLES, ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES };

function withPersistentRoles(roles, construction) {
    const required = persistentRolesForConstruction(construction);
    const next = Array.isArray(roles) ? [...roles] : [...required];
    for (const role of required) {
        if (!next.includes(role)) next.push(role);
    }
    return next;
}

export function isLegacyModelBakeConfig(config) {
    if (!config) return false;
    if (config.roundTrip?.useModel === true) return true;
    if (config.operational?.roundTrip?.useModel === true) return true;
    if (typeof config.document === "function") return config.document()?.operational?.roundTrip?.useModel === true;
    return false;
}

export function createPersistentBakeRunConfig(overrides = {}) {
    const construction = normalizeBakeConstruction(
        overrides.construction
            ?? (overrides.version === 1 ? DEFAULT_PROJECTED_CONSTRUCTION : DEFAULT_ATLAS_CONSTRUCTION),
    );
    const version = overrides.version === 1 && !isChunkAtlasConstruction(construction) ? 1 : 2;
    const roles = withPersistentRoles(overrides.outputRoles, construction);
    const base = {
        ...overrides,
        version,
        construction: version === 2 ? construction : undefined,
        outputRoles: roles,
        views: (overrides.views ?? [{}]).map((view) => ({
            ...view,
            products: withPersistentRoles(view.products ?? roles, construction),
        })),
    };
    if (version === 1) delete base.construction;
    if (overrides?.kind === "cev-sim.bake-run-config") {
        return new BakeRunConfig({
            ...base,
            operational: {
                ...overrides.operational,
                roundTrip: {
                    useModel: false,
                    ...(overrides.operational?.roundTrip ?? {}),
                },
            },
        });
    }
    return new BakeRunConfig({
        ...base,
        roundTrip: { useModel: false, ...(overrides.roundTrip ?? {}) },
    });
}

export { interpolateBakePathSample, pathLengthMeters, planIntegerSampleDistances };
