import {
    VISUAL_CAMERA_PRODUCT_PROFILE,
    VISUAL_RENDER_PROVIDERS,
} from "../visual/VisualLayer.js";

export const CAMERA_RENDER_PRODUCT_KEYS = Object.freeze([
    "rgb",
    "cameraInfo",
    "depth",
    "semantic",
    "instance",
]);
export const CAMERA_SEPARATE_PRODUCT_KEYS = Object.freeze([
    "detections2d",
    "detections3d",
    "lanes",
    "trafficControls",
    "diagnostics",
]);
export const CAMERA_PRODUCT_KEYS = Object.freeze([
    ...CAMERA_RENDER_PRODUCT_KEYS,
    ...CAMERA_SEPARATE_PRODUCT_KEYS,
]);

const PRODUCT_NAME_ALIASES = Object.freeze({
    rgba: "rgb",
    "camera-info": "cameraInfo",
    rgb: "rgb",
    cameraInfo: "cameraInfo",
    depth: "depth",
    semantic: "semantic",
    instance: "instance",
});

export const DEFAULT_CAMERA_RENDER_SELECTION = Object.freeze({
    provider: Object.freeze({
        id: VISUAL_RENDER_PROVIDERS.legacyAnalytic.id,
        version: VISUAL_RENDER_PROVIDERS.legacyAnalytic.version,
    }),
    productProfile: Object.freeze({
        id: VISUAL_CAMERA_PRODUCT_PROFILE.id,
        version: VISUAL_CAMERA_PRODUCT_PROFILE.version,
    }),
});

function cloneSelection(selection) {
    return {
        provider: { id: selection.provider.id, version: selection.provider.version },
        productProfile: { id: selection.productProfile.id, version: selection.productProfile.version },
    };
}

export function defaultCameraRenderSelection() {
    return cloneSelection(DEFAULT_CAMERA_RENDER_SELECTION);
}

export class RenderSceneProviderError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "RenderSceneProviderError";
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details = null) {
    throw new RenderSceneProviderError(code, message, details);
}

function plainObject(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("MALFORMED_RENDER_SELECTION", `${path}: expected an object`);
    }
    return value;
}

function assertKeys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) fail("MALFORMED_RENDER_SELECTION", `${path}.${unknown}: unknown field`);
}

function identifier(value, path) {
    if (typeof value !== "string" || !value.trim()) {
        fail("MALFORMED_RENDER_SELECTION", `${path}: expected a non-empty string`);
    }
    return value.trim();
}

function positiveInteger(value, path) {
    if (!Number.isInteger(value) || value < 1) {
        fail("MALFORMED_RENDER_SELECTION", `${path}: expected a positive integer version`);
    }
    return value;
}

function productKey(value, path) {
    const name = identifier(value, path);
    const mapped = PRODUCT_NAME_ALIASES[name];
    if (!mapped) fail("MALFORMED_PROVIDER", `${path}: unsupported product ${JSON.stringify(name)}`);
    return mapped;
}

export function providerKey(provider) {
    return `${provider.id}@${provider.version}`;
}

export function selectionsEqual(left, right) {
    return left?.provider?.id === right?.provider?.id
        && left?.provider?.version === right?.provider?.version
        && left?.productProfile?.id === right?.productProfile?.id
        && left?.productProfile?.version === right?.productProfile?.version;
}

export function isLegacyAnalyticSelection(selection) {
    return selectionsEqual(selection, DEFAULT_CAMERA_RENDER_SELECTION);
}

function normalizeProviderRef(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["id", "version"], path);
    return {
        id: identifier(source.id, `${path}.id`),
        version: positiveInteger(source.version, `${path}.version`),
    };
}

function normalizeProfileRef(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["id", "version"], path);
    return {
        id: identifier(source.id, `${path}.id`),
        version: positiveInteger(source.version, `${path}.version`),
    };
}

export function normalizeCameraRenderSelection(value, { required = false } = {}) {
    if (value === undefined) {
        if (required) fail("MALFORMED_RENDER_SELECTION", "render: camera render selection is required");
        return undefined;
    }
    const source = plainObject(value, "render");
    assertKeys(source, ["provider", "productProfile"], "render");
    return {
        provider: normalizeProviderRef(source.provider, "render.provider"),
        productProfile: normalizeProfileRef(source.productProfile, "render.productProfile"),
    };
}

export function effectiveCameraRenderSelection(sensor) {
    const normalized = normalizeCameraRenderSelection(sensor?.render);
    return normalized ? cloneSelection(normalized) : defaultCameraRenderSelection();
}

function uniqueProducts(values, path) {
    if (!Array.isArray(values)) fail("MALFORMED_PROVIDER", `${path}: expected an array`);
    const result = values.map((entry, index) => productKey(entry, `${path}.${index}`));
    if (new Set(result).size !== result.length) {
        fail("DUPLICATE_PRODUCT", `${path}: contains duplicate products`);
    }
    return result;
}

function normalizeProfileDeclaration(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["id", "version", "measured", "optionalOracle", "requireMeasured"], path);
    const measured = uniqueProducts(source.measured ?? [], `${path}.measured`);
    const optionalOracle = uniqueProducts(source.optionalOracle ?? [], `${path}.optionalOracle`);
    const combined = [...measured, ...optionalOracle];
    if (new Set(combined).size !== combined.length) {
        fail("DUPLICATE_PRODUCT", `${path}: measured and optional oracle products must be unique`);
    }
    return Object.freeze({
        id: identifier(source.id, `${path}.id`),
        version: positiveInteger(source.version, `${path}.version`),
        measured: Object.freeze(measured),
        optionalOracle: Object.freeze(optionalOracle),
        requireMeasured: source.requireMeasured === true,
        products: Object.freeze(combined),
    });
}

export class RenderSceneProviderRegistry {
    constructor() {
        this.providers = new Map();
        this.analyticImplementation = null;
    }

    register(declaration) {
        const source = plainObject(declaration, "provider");
        assertKeys(source, [
            "id", "version", "available", "unavailableReason", "productProfiles",
            "resolve", "assert",
        ], "provider");
        const id = identifier(source.id, "provider.id");
        const version = positiveInteger(source.version, "provider.version");
        const versions = this.providers.get(id) ?? new Map();
        if (versions.has(version)) {
            fail("DUPLICATE_PROVIDER", `Duplicate render-scene provider ${id}@${version}`);
        }
        const profiles = Array.isArray(source.productProfiles) ? source.productProfiles : [];
        if (profiles.length === 0) fail("MALFORMED_PROVIDER", "provider.productProfiles: expected a non-empty array");
        const productProfiles = profiles.map((entry, index) => (
            normalizeProfileDeclaration(entry, `provider.productProfiles.${index}`)
        ));
        const profileKeys = new Set(productProfiles.map((entry) => providerKey(entry)));
        if (profileKeys.size !== productProfiles.length) {
            fail("DUPLICATE_PROVIDER", `Duplicate product profile declarations for ${id}@${version}`);
        }
        const available = source.available === true;
        const entry = {
            id,
            version,
            available,
            unavailableReason: available
                ? ""
                : String(source.unavailableReason || `${id}@${version} is known but unavailable`),
            productProfiles,
            resolve: typeof source.resolve === "function" ? source.resolve : null,
            assert: typeof source.assert === "function" ? source.assert : null,
        };
        versions.set(version, entry);
        this.providers.set(id, versions);
        return entry;
    }

    bindAnalyticImplementation(implementation) {
        this.analyticImplementation = implementation;
        const entry = this.lookup(VISUAL_RENDER_PROVIDERS.legacyAnalytic, { requireAvailable: false });
        entry.resolve = (worldResource, vehicleDependencies = []) => (
            implementation.createResource(worldResource, vehicleDependencies)
        );
        entry.assert = (description) => implementation.assertDescription(description);
        return entry;
    }

    lookup(provider, { requireAvailable = false } = {}) {
        const id = identifier(provider?.id, "provider.id");
        const version = positiveInteger(provider?.version, "provider.version");
        const versions = this.providers.get(id);
        if (!versions) {
            fail("UNKNOWN_PROVIDER", `Unknown render-scene provider id ${JSON.stringify(id)}`, { id, version });
        }
        const entry = versions.get(version);
        if (!entry) {
            fail(
                "UNKNOWN_PROVIDER_VERSION",
                `Unknown render-scene provider version ${id}@${version}`,
                { id, version },
            );
        }
        if (requireAvailable && !entry.available) {
            fail("PROVIDER_UNAVAILABLE", entry.unavailableReason, { id, version });
        }
        return entry;
    }

    lookupProfile(provider, profile) {
        const entry = this.lookup(provider, { requireAvailable: false });
        const normalized = normalizeProfileRef(profile, "productProfile");
        const declared = entry.productProfiles.find((candidate) => (
            candidate.id === normalized.id && candidate.version === normalized.version
        ));
        if (!declared) {
            fail(
                "UNKNOWN_PRODUCT_PROFILE",
                `Unknown product profile ${normalized.id}@${normalized.version} for ${providerKey(entry)}`,
                normalized,
            );
        }
        return declared;
    }

    normalizeAuthoredSelection(value) {
        return normalizeCameraRenderSelection(value);
    }

    assertCameraProductFlags(products, path = "calibration.products") {
        if (products === undefined) return;
        const source = plainObject(products, path);
        for (const [key, value] of Object.entries(source)) {
            if (!CAMERA_PRODUCT_KEYS.includes(key)) {
                fail("UNKNOWN_CAMERA_PRODUCT", `${path}.${key}: unknown camera product`);
            }
            if (typeof value !== "boolean") {
                fail("NON_BOOLEAN_CAMERA_PRODUCT", `${path}.${key}: expected a boolean`);
            }
        }
    }

    validateCameraRender(sensor) {
        const issues = [];
        const push = (error) => issues.push({
            path: error.details?.path || (error.code?.includes("PRODUCT") ? "calibration.products" : "render"),
            message: error.message,
            code: error.code,
        });
        try {
            if (sensor?.type !== "camera") {
                if (sensor?.render !== undefined) {
                    fail("MALFORMED_RENDER_SELECTION", "Render selection is only valid on camera sensors");
                }
                return issues;
            }
            this.assertCameraProductFlags(sensor.calibration?.products);
            const selection = normalizeCameraRenderSelection(sensor.render);
            if (!selection) return issues;
            const profile = this.lookupProfile(selection.provider, selection.productProfile);
            const products = sensor.calibration?.products ?? {};
            for (const key of CAMERA_RENDER_PRODUCT_KEYS) {
                if (products[key] === true && !profile.products.includes(key)) {
                    fail(
                        "UNSUPPORTED_RENDERED_PRODUCT",
                        `Rendered camera product "${key}" is not advertised by ${profile.id}@${profile.version}`,
                    );
                }
            }
            if (sensor.enabled !== false && profile.requireMeasured) {
                for (const key of profile.measured) {
                    if (products[key] !== true) {
                        fail(
                            "UNSUPPORTED_RENDERED_PRODUCT",
                            `Product profile ${profile.id}@${profile.version} requires measured product "${key}"`,
                        );
                    }
                }
            }
        } catch (error) {
            if (error instanceof RenderSceneProviderError) push(error);
            else throw error;
        }
        return issues;
    }

    resolveEnabledCameraSelection(sensors = [], { requireAvailable = false } = {}) {
        const cameras = (Array.isArray(sensors) ? sensors : [])
            .filter((sensor) => sensor?.type === "camera" && sensor.enabled !== false);
        if (cameras.length === 0) return null;
        let selected = null;
        for (const camera of cameras) {
            const selection = effectiveCameraRenderSelection(camera);
            this.lookup(selection.provider, { requireAvailable });
            this.lookupProfile(selection.provider, selection.productProfile);
            const productIssues = this.validateCameraRender(camera);
            if (productIssues.length > 0) {
                fail(productIssues[0].code || "MALFORMED_RENDER_SELECTION", productIssues[0].message);
            }
            if (!selected) selected = selection;
            else if (!selectionsEqual(selected, selection)) {
                fail(
                    "MIXED_RENDER_SELECTION",
                    "Enabled cameras must share one render provider and product profile; omitted selections alias to canonical-analytic@1",
                    { expected: selected, received: selection, sensorId: camera.id },
                );
            }
        }
        return selected;
    }

    resolveResource(worldResource, vehicleDependencies = [], selection) {
        const normalized = selection === undefined
            ? defaultCameraRenderSelection()
            : cloneSelection(normalizeCameraRenderSelection(selection, { required: true }));
        const entry = this.lookup(normalized.provider, { requireAvailable: true });
        this.lookupProfile(normalized.provider, normalized.productProfile);
        if (typeof entry.resolve !== "function") {
            fail("PROVIDER_UNAVAILABLE", entry.unavailableReason, normalized.provider);
        }
        return entry.resolve(worldResource, vehicleDependencies, normalized);
    }

    assertDescription(description) {
        const provider = description?.provider;
        const entry = this.lookup({
            id: provider?.id,
            version: Number.isInteger(provider?.version) ? provider.version : provider?.version,
        }, { requireAvailable: true });
        if (typeof entry.assert !== "function") {
            fail("PROVIDER_UNAVAILABLE", entry.unavailableReason, entry);
        }
        return entry.assert(description);
    }

    assertMatchesScene(sensors, renderScene, { requireAvailable = true } = {}) {
        const selection = this.resolveEnabledCameraSelection(sensors, { requireAvailable });
        if (!selection) return null;
        const sceneProvider = renderScene?.description?.provider;
        if (sceneProvider?.id !== selection.provider.id
            || Number(sceneProvider?.version) !== selection.provider.version) {
            fail(
                "RENDER_SCENE_PROVIDER_MISMATCH",
                `Enabled camera render selection ${providerKey(selection.provider)} does not match persisted render-scene provider ${sceneProvider?.id}@${sceneProvider?.version}; explicit selections never fall back`,
                { selection: selection.provider, scene: sceneProvider ?? null },
            );
        }
        return selection;
    }

    runtimeCapabilities() {
        return [...this.providers.entries()]
            .flatMap(([id, versions]) => [...versions.values()].map((entry) => ({
                id,
                version: entry.version,
                available: entry.available,
                unavailableReason: entry.unavailableReason,
                productProfiles: entry.productProfiles.map((profile) => ({
                    id: profile.id,
                    version: profile.version,
                })),
            })))
            .sort((left, right) => providerKey(left).localeCompare(providerKey(right)));
    }
}

function defaultProductProfile({ requireMeasured = false } = {}) {
    return {
        id: VISUAL_CAMERA_PRODUCT_PROFILE.id,
        version: VISUAL_CAMERA_PRODUCT_PROFILE.version,
        measured: [...VISUAL_CAMERA_PRODUCT_PROFILE.measured],
        optionalOracle: [...VISUAL_CAMERA_PRODUCT_PROFILE.optionalOracle],
        requireMeasured,
    };
}

export function createDefaultRenderSceneProviderRegistry() {
    const registry = new RenderSceneProviderRegistry();
    registry.register({
        id: VISUAL_RENDER_PROVIDERS.legacyAnalytic.id,
        version: VISUAL_RENDER_PROVIDERS.legacyAnalytic.version,
        available: true,
        productProfiles: [defaultProductProfile()],
    });
    registry.register({
        id: VISUAL_RENDER_PROVIDERS.correctedAnalytic.id,
        version: VISUAL_RENDER_PROVIDERS.correctedAnalytic.version,
        available: false,
        unavailableReason: "canonical-analytic@2 is known but unavailable until corrected analytic rendering is implemented",
        productProfiles: [defaultProductProfile()],
    });
    registry.register({
        id: VISUAL_RENDER_PROVIDERS.pbrMesh.id,
        version: VISUAL_RENDER_PROVIDERS.pbrMesh.version,
        available: false,
        unavailableReason: "pbr-mesh@1 is known but unavailable until PBR materialization and camera integration land",
        productProfiles: [defaultProductProfile({ requireMeasured: true })],
    });
    return registry;
}

export const renderSceneProviderRegistry = createDefaultRenderSceneProviderRegistry();

export function bindCanonicalAnalyticRenderScene(implementation) {
    return renderSceneProviderRegistry.bindAnalyticImplementation(implementation);
}

export function resolveEnabledCameraRenderSelection(sensors, options) {
    return renderSceneProviderRegistry.resolveEnabledCameraSelection(sensors, options);
}

export function validateCameraRenderDeclaration(sensor) {
    return renderSceneProviderRegistry.validateCameraRender(sensor);
}

export function assertEnabledCameraRenderRuntime(sensors, renderScene) {
    return renderSceneProviderRegistry.assertMatchesScene(sensors, renderScene, { requireAvailable: true });
}
