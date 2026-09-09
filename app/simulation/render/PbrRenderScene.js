import {
    VISUAL_KTX2_TRANSCODER_PATH,
    VISUAL_RENDER_PROVIDERS,
    assertVisualAssetReference,
    assertVisualAssetUse,
    assertVisualLayer,
    assertVisualLayerAccess,
    assertVisualLayerAccessMatches,
    canonicalExactStringify,
    defaultVisualLodPolicy,
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualAssetReference,
    normalizeVisualLodPolicy,
    sha256ExactUtf8,
} from "../visual/VisualLayer.js";
import {
    assertLidarGeometryResource,
    createLidarGeometryResource,
} from "../lidar/LidarGeometry.js";
import { compareUtf8 } from "../world/WorldDescription.js";

export const PBR_RENDER_RECIPE_KIND = "cev-sim.pbr-render-recipe";
export const PBR_RENDER_RECIPE_VERSION = 1;
export const PBR_RENDER_SCENE_KIND = "cev-sim.render-scene";
export const PBR_RENDER_SCENE_VERSION = 1;
export const PBR_ASSET_CLOSURE_KIND = "cev-sim.visual-asset-closure";
export const PBR_ASSET_CLOSURE_VERSION = 1;
export const PBR_RUN_EVIDENCE_KIND = "cev-sim.visual-run-evidence";
export const PBR_RUN_EVIDENCE_VERSION = 1;
export const PBR_MEASURED_ASSET_OPERATIONS = Object.freeze(["display", "machine-interpretation"]);

const SHA256 = /^[a-f0-9]{64}$/;
const ACTOR_MODES = Object.freeze(["canonical-primitives", "visual-asset"]);
const ALPHA_MODES = Object.freeze(["MASK", "OPAQUE"]);
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function fail(path, message) {
    throw new TypeError(`${path}: ${message}`);
}

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        fail(path, "expected an object");
    }
    return value;
}

function keys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) fail(`${path}.${unknown}`, "unknown field");
}

function text(value, path) {
    if (typeof value !== "string" || !value || value !== value.normalize("NFC")) {
        fail(path, "expected non-empty NFC text");
    }
    return value;
}

function digest(value, path) {
    if (typeof value !== "string" || !SHA256.test(value)) fail(path, "expected a lowercase SHA-256 digest");
    return value;
}

function number(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    return Object.is(value, -0) ? 0 : value;
}

function nonNegative(value, path) {
    const result = number(value, path);
    if (result < 0) fail(path, "expected a non-negative number");
    return result;
}

function bounded(value, minimum, maximum, path) {
    const result = number(value, path);
    if (result < minimum || result > maximum) fail(path, `expected a number in [${minimum}, ${maximum}]`);
    return result;
}

function bool(value, path) {
    if (typeof value !== "boolean") fail(path, "expected a boolean");
    return value;
}

function enumValue(value, allowed, path) {
    const result = text(value, path);
    if (!allowed.includes(result)) fail(path, `unsupported value ${JSON.stringify(result)}`);
    return result;
}

function vector(value, length, path, fallback) {
    const source = value === undefined ? fallback : value;
    if (!Array.isArray(source) || source.length !== length || Object.keys(source).length !== length) {
        fail(path, `expected a dense ${length}-element array`);
    }
    return source.map((entry, index) => number(entry, `${path}.${index}`));
}

function color(value, length, path, fallback) {
    return vector(value, length, path, fallback)
        .map((entry, index) => bounded(entry, 0, 1, `${path}.${index}`));
}

function matrix(value, path) {
    const result = vector(value, 16, path, IDENTITY_MATRIX);
    if (result[3] !== 0 || result[7] !== 0 || result[11] !== 0 || result[15] !== 1) {
        fail(path, "expected a column-major affine matrix");
    }
    const determinant = result[0] * (result[5] * result[10] - result[9] * result[6])
        - result[4] * (result[1] * result[10] - result[9] * result[2])
        + result[8] * (result[1] * result[6] - result[5] * result[2]);
    if (determinant === 0) fail(path, "matrix must be nonsingular");
    return result;
}

function sortedUnique(values, path, normalize, key = (entry) => entry.id) {
    if (!Array.isArray(values) || Object.keys(values).length !== values.length) fail(path, "expected a dense array");
    const result = values.map((entry, index) => normalize(entry, `${path}.${index}`));
    const identities = result.map(key);
    if (new Set(identities).size !== identities.length) fail(path, "contains duplicate entries");
    return result.sort((left, right) => compareUtf8(key(left), key(right)));
}

function exact(value, normalized, path) {
    if (canonicalExactStringify(value) !== canonicalExactStringify(normalized)) {
        fail(path, "immutable value is not in canonical normalized form");
    }
    return value;
}

function normalizeAssetUse(value, path, { role = null } = {}) {
    const source = object(value, path);
    keys(source, ["asset", "useHash"], path);
    const asset = normalizeVisualAssetReference(source.asset, `${path}.asset`);
    if (role && asset.role !== role) fail(`${path}.asset.role`, `expected ${role}`);
    return { asset, useHash: digest(source.useHash, `${path}.useHash`) };
}

function normalizeActorMaterial(value, path) {
    const source = object(value ?? {}, path);
    keys(source, [
        "baseColorFactor", "metallicFactor", "roughnessFactor", "emissiveFactor",
        "alphaMode", "alphaCutoff", "doubleSided",
    ], path);
    return {
        baseColorFactor: color(source.baseColorFactor, 4, `${path}.baseColorFactor`, [1, 1, 1, 1]),
        metallicFactor: bounded(source.metallicFactor ?? 1, 0, 1, `${path}.metallicFactor`),
        roughnessFactor: bounded(source.roughnessFactor ?? 1, 0, 1, `${path}.roughnessFactor`),
        emissiveFactor: color(source.emissiveFactor, 3, `${path}.emissiveFactor`, [0, 0, 0]),
        alphaMode: enumValue(source.alphaMode ?? "OPAQUE", ALPHA_MODES, `${path}.alphaMode`),
        alphaCutoff: bounded(source.alphaCutoff ?? 0.5, 0, 1, `${path}.alphaCutoff`),
        doubleSided: bool(source.doubleSided ?? false, `${path}.doubleSided`),
    };
}

function normalizeActorOverride(value, path) {
    const source = object(value, path);
    keys(source, ["actorId", "mode", "transform", "asset", "material"], path);
    const mode = enumValue(source.mode ?? "canonical-primitives", ACTOR_MODES, `${path}.mode`);
    const result = {
        actorId: text(source.actorId, `${path}.actorId`),
        mode,
        transform: matrix(source.transform, `${path}.transform`),
    };
    if (mode === "visual-asset") {
        result.asset = normalizeAssetUse(source.asset, `${path}.asset`, { role: "actor" });
        result.material = normalizeActorMaterial(source.material, `${path}.material`);
    } else if (source.asset !== undefined || source.material !== undefined) {
        fail(path, "canonical-primitives actors cannot declare asset or material overrides");
    }
    return result;
}

function normalizeEnvironmentMap(value, path) {
    if (value === null || value === undefined) return null;
    const source = object(value, path);
    keys(source, ["asset", "useHash", "intensity", "rotationRadians"], path);
    const assetUse = normalizeAssetUse({ asset: source.asset, useHash: source.useHash }, path, {
        role: "environment-map",
    });
    if (!["image/jpeg", "image/ktx2", "image/png"].includes(assetUse.asset.mediaType)) {
        fail(`${path}.asset.mediaType`, "environment maps must use PNG, JPEG, or KTX2");
    }
    return {
        ...assetUse,
        intensity: nonNegative(source.intensity ?? 1, `${path}.intensity`),
        rotationRadians: number(source.rotationRadians ?? 0, `${path}.rotationRadians`),
    };
}

export function defaultPbrRenderRecipe() {
    return normalizePbrRenderRecipe({});
}

/** Normalize optional authored measured-appearance input into a frozen recipe. */
export function normalizePbrRenderRecipe(value = {}) {
    const source = object(value, "renderRecipe");
    keys(source, [
        "kind", "version", "background", "lighting", "shadows", "colorPipeline",
        "rasterization", "lodPolicy", "decoders", "actors",
    ], "renderRecipe");
    const background = object(source.background ?? {}, "renderRecipe.background");
    keys(background, ["colorRgba", "environmentMap"], "renderRecipe.background");
    const lighting = object(source.lighting ?? {}, "renderRecipe.lighting");
    keys(lighting, ["ambient"], "renderRecipe.lighting");
    const ambient = object(lighting.ambient ?? {}, "renderRecipe.lighting.ambient");
    keys(ambient, ["colorRgb", "intensity"], "renderRecipe.lighting.ambient");
    const shadows = object(source.shadows ?? {}, "renderRecipe.shadows");
    keys(shadows, ["enabled", "algorithm"], "renderRecipe.shadows");
    const colorPipeline = object(source.colorPipeline ?? {}, "renderRecipe.colorPipeline");
    keys(colorPipeline, ["workingColorSpace", "outputColorSpace", "toneMapping", "exposure"], "renderRecipe.colorPipeline");
    const rasterization = object(source.rasterization ?? {}, "renderRecipe.rasterization");
    keys(rasterization, [
        "antialiasing", "dithering", "alphaPolicy", "samplerPolicy", "transparentOrdering",
        "frontFace", "culling", "depthTest", "precision", "readback",
    ], "renderRecipe.rasterization");
    const decoders = object(source.decoders ?? {}, "renderRecipe.decoders");
    keys(decoders, ["gltf", "ktx2TranscoderPath", "ktx2FormatPolicy"], "renderRecipe.decoders");
    const result = {
        kind: source.kind ?? PBR_RENDER_RECIPE_KIND,
        version: source.version ?? PBR_RENDER_RECIPE_VERSION,
        background: {
            colorRgba: color(background.colorRgba, 4, "renderRecipe.background.colorRgba", [0, 0, 0, 1]),
            environmentMap: normalizeEnvironmentMap(background.environmentMap, "renderRecipe.background.environmentMap"),
        },
        lighting: {
            ambient: {
                colorRgb: color(ambient.colorRgb, 3, "renderRecipe.lighting.ambient.colorRgb", [1, 1, 1]),
                intensity: nonNegative(ambient.intensity ?? 1, "renderRecipe.lighting.ambient.intensity"),
            },
        },
        shadows: {
            enabled: bool(shadows.enabled ?? false, "renderRecipe.shadows.enabled"),
            algorithm: enumValue(shadows.algorithm ?? "none", ["none"], "renderRecipe.shadows.algorithm"),
        },
        colorPipeline: {
            workingColorSpace: enumValue(colorPipeline.workingColorSpace ?? "linear-srgb", ["linear-srgb"], "renderRecipe.colorPipeline.workingColorSpace"),
            outputColorSpace: enumValue(colorPipeline.outputColorSpace ?? "srgb", ["srgb"], "renderRecipe.colorPipeline.outputColorSpace"),
            toneMapping: enumValue(colorPipeline.toneMapping ?? "none", ["none"], "renderRecipe.colorPipeline.toneMapping"),
            exposure: nonNegative(colorPipeline.exposure ?? 1, "renderRecipe.colorPipeline.exposure"),
        },
        rasterization: {
            antialiasing: bool(rasterization.antialiasing ?? false, "renderRecipe.rasterization.antialiasing"),
            dithering: bool(rasterization.dithering ?? false, "renderRecipe.rasterization.dithering"),
            alphaPolicy: enumValue(rasterization.alphaPolicy ?? "opaque-mask-only@1", ["opaque-mask-only@1"], "renderRecipe.rasterization.alphaPolicy"),
            samplerPolicy: enumValue(rasterization.samplerPolicy ?? "gltf-declared-or-linear-repeat@1", ["gltf-declared-or-linear-repeat@1"], "renderRecipe.rasterization.samplerPolicy"),
            transparentOrdering: enumValue(rasterization.transparentOrdering ?? "stable-utf8-id@1", ["stable-utf8-id@1"], "renderRecipe.rasterization.transparentOrdering"),
            frontFace: enumValue(rasterization.frontFace ?? "counter-clockwise", ["counter-clockwise"], "renderRecipe.rasterization.frontFace"),
            culling: enumValue(rasterization.culling ?? "material-double-sided@1", ["material-double-sided@1"], "renderRecipe.rasterization.culling"),
            depthTest: enumValue(rasterization.depthTest ?? "less-equal@1", ["less-equal@1"], "renderRecipe.rasterization.depthTest"),
            precision: enumValue(rasterization.precision ?? "highp", ["highp"], "renderRecipe.rasterization.precision"),
            readback: enumValue(rasterization.readback ?? "rgba8-top-left-srgb@1", ["rgba8-top-left-srgb@1"], "renderRecipe.rasterization.readback"),
        },
        lodPolicy: normalizeVisualLodPolicy(source.lodPolicy ?? defaultVisualLodPolicy()),
        decoders: {
            gltf: enumValue(decoders.gltf ?? "three-gltfloader-static-profile@1", ["three-gltfloader-static-profile@1"], "renderRecipe.decoders.gltf"),
            ktx2TranscoderPath: enumValue(decoders.ktx2TranscoderPath ?? VISUAL_KTX2_TRANSCODER_PATH, [VISUAL_KTX2_TRANSCODER_PATH], "renderRecipe.decoders.ktx2TranscoderPath"),
            ktx2FormatPolicy: enumValue(decoders.ktx2FormatPolicy ?? "basis-pinned-runtime@1", ["basis-pinned-runtime@1"], "renderRecipe.decoders.ktx2FormatPolicy"),
        },
        actors: sortedUnique(source.actors ?? [], "renderRecipe.actors", normalizeActorOverride, (entry) => entry.actorId),
    };
    if (result.kind !== PBR_RENDER_RECIPE_KIND || result.version !== PBR_RENDER_RECIPE_VERSION) {
        fail("renderRecipe", `expected ${PBR_RENDER_RECIPE_KIND} version ${PBR_RENDER_RECIPE_VERSION}`);
    }
    if (result.shadows.enabled) fail("renderRecipe.shadows.enabled", "pbr-mesh@1 supports only disabled shadows");
    return result;
}

export function assertPbrRenderRecipe(value) {
    return exact(value, normalizePbrRenderRecipe(value), "renderRecipe");
}

export function pbrRenderRecipeAssetRoots(recipe) {
    const normalized = normalizePbrRenderRecipe(recipe);
    const roots = [];
    const environmentMap = normalized.background.environmentMap;
    if (environmentMap) {
        roots.push({ scope: "environment-map", asset: environmentMap.asset, useHash: environmentMap.useHash });
    }
    for (const actor of normalized.actors) {
        if (actor.mode === "visual-asset") {
            roots.push({ scope: `actor:${actor.actorId}`, asset: actor.asset.asset, useHash: actor.asset.useHash });
        }
    }
    return roots.sort((left, right) => compareUtf8(
        `${left.scope}:${left.asset.sha256}:${left.useHash}`,
        `${right.scope}:${right.asset.sha256}:${right.useHash}`,
    ));
}

function pixelRecipe(recipe) {
    const normalized = normalizePbrRenderRecipe(recipe);
    return {
        ...normalized,
        background: {
            ...normalized.background,
            environmentMap: normalized.background.environmentMap
                ? {
                    asset: normalized.background.environmentMap.asset,
                    intensity: normalized.background.environmentMap.intensity,
                    rotationRadians: normalized.background.environmentMap.rotationRadians,
                }
                : null,
        },
        actors: normalized.actors.map((actor) => (
            actor.mode === "visual-asset"
                ? { ...actor, asset: actor.asset.asset }
                : actor
        )),
    };
}

function normalizePbrPixelRecipe(value) {
    const source = object(value, "renderScene.recipe");
    const expanded = structuredClone(source);
    if (expanded.background?.environmentMap) {
        expanded.background.environmentMap = {
            ...expanded.background.environmentMap,
            useHash: "0".repeat(64),
        };
    }
    expanded.actors = (expanded.actors ?? []).map((actor) => (
        actor.mode === "visual-asset"
            ? { ...actor, asset: { asset: actor.asset, useHash: "0".repeat(64) } }
            : actor
    ));
    return pixelRecipe(normalizePbrRenderRecipe(expanded));
}

export function normalizePbrAssetClosure(value) {
    const source = object(value, "assetClosure");
    keys(source, ["kind", "version", "assets"], "assetClosure");
    const assets = sortedUnique(source.assets ?? [], "assetClosure.assets", normalizeVisualAssetReference, (entry) => entry.sha256);
    const result = {
        kind: source.kind ?? PBR_ASSET_CLOSURE_KIND,
        version: source.version ?? PBR_ASSET_CLOSURE_VERSION,
        assets,
    };
    if (result.kind !== PBR_ASSET_CLOSURE_KIND || result.version !== PBR_ASSET_CLOSURE_VERSION) {
        fail("assetClosure", `expected ${PBR_ASSET_CLOSURE_KIND} version ${PBR_ASSET_CLOSURE_VERSION}`);
    }
    return result;
}

export function hashPbrAssetClosure(value) {
    const normalized = normalizePbrAssetClosure(value);
    return sha256ExactUtf8(canonicalExactStringify(normalized));
}

function resolvedActors(recipe, analyticTruth) {
    const overrides = new Map(recipe.actors.map((entry) => [entry.actorId, entry]));
    const actorIds = analyticTruth.description.actors.map((entry) => entry.actorId);
    for (const actorId of overrides.keys()) {
        if (!actorIds.includes(actorId)) fail("renderRecipe.actors", `references unknown actor ${actorId}`);
    }
    return actorIds.map((actorId) => {
        const override = overrides.get(actorId);
        if (!override || override.mode === "canonical-primitives") {
            return {
                actorId,
                mode: "canonical-primitives",
                transform: override?.transform ?? [...IDENTITY_MATRIX],
                source: { kind: "analytic-truth-primitives", version: 1 },
            };
        }
        return {
            actorId,
            mode: "visual-asset",
            transform: override.transform,
            source: {
                kind: "visual-asset",
                version: 1,
                asset: override.asset.asset,
                material: override.material,
            },
        };
    }).sort((left, right) => compareUtf8(left.actorId, right.actorId));
}

function resolvedActorsFromPixelRecipe(recipe, analyticTruth) {
    const overrides = new Map(recipe.actors.map((entry) => [entry.actorId, entry]));
    const actorIds = analyticTruth.description.actors.map((entry) => entry.actorId);
    for (const actorId of overrides.keys()) {
        if (!actorIds.includes(actorId)) fail("renderScene.recipe.actors", `references unknown actor ${actorId}`);
    }
    return actorIds.map((actorId) => {
        const override = overrides.get(actorId);
        if (!override || override.mode === "canonical-primitives") {
            return {
                actorId,
                mode: "canonical-primitives",
                transform: override?.transform ?? [...IDENTITY_MATRIX],
                source: { kind: "analytic-truth-primitives", version: 1 },
            };
        }
        return {
            actorId,
            mode: "visual-asset",
            transform: override.transform,
            source: {
                kind: "visual-asset",
                version: 1,
                asset: override.asset,
                material: override.material,
            },
        };
    }).sort((left, right) => compareUtf8(left.actorId, right.actorId));
}

function pixelRecipeAssets(recipe) {
    const assets = [];
    if (recipe.background.environmentMap) {
        assets.push({ scope: "environment-map", asset: recipe.background.environmentMap.asset });
    }
    for (const actor of recipe.actors) {
        if (actor.mode === "visual-asset") assets.push({ scope: `actor:${actor.actorId}`, asset: actor.asset });
    }
    return assets.sort((left, right) => compareUtf8(
        `${left.scope}:${left.asset.sha256}`,
        `${right.scope}:${right.asset.sha256}`,
    ));
}

export function createPbrRenderSceneResource({
    worldResource,
    vehicleDependencies = [],
    selection,
    visualLayerResource,
    renderRecipe,
    assetClosure,
} = {}) {
    if (!worldResource?.description || !worldResource?.hash) fail("world", "resolved world resource is required");
    assertVisualLayer(visualLayerResource?.description);
    if (hashVisualLayer(visualLayerResource.description) !== visualLayerResource.hash) {
        fail("visualLayer.hash", "does not match the visual-layer description");
    }
    if (visualLayerResource.description.sourceWorldHash !== worldResource.hash) {
        fail("visualLayer.sourceWorldHash", "does not match the resolved world");
    }
    const recipe = normalizePbrRenderRecipe(renderRecipe ?? {});
    const closure = normalizePbrAssetClosure(assetClosure);
    const analyticTruth = createLidarGeometryResource(worldResource, vehicleDependencies);
    const description = {
        kind: PBR_RENDER_SCENE_KIND,
        version: PBR_RENDER_SCENE_VERSION,
        provider: { ...VISUAL_RENDER_PROVIDERS.pbrMesh },
        productProfile: {
            id: text(selection?.productProfile?.id, "selection.productProfile.id"),
            version: selection?.productProfile?.version,
        },
        coordinateFrame: analyticTruth.description.coordinateFrame,
        worldHash: digest(worldResource.hash, "world.hash"),
        visualLayerHash: digest(visualLayerResource.hash, "visualLayer.hash"),
        recipe: pixelRecipe(recipe),
        recipeHash: sha256ExactUtf8(canonicalExactStringify(pixelRecipe(recipe))),
        assetClosure: closure,
        assetClosureHash: hashPbrAssetClosure(closure),
        analyticTruth,
        dynamicTransforms: {
            source: "simulation-actor-pose@1",
            frame: "world",
            composition: "world-pose-times-visual-to-actor@1",
        },
        actors: resolvedActors(recipe, analyticTruth),
    };
    assertPbrRenderSceneDescription(description);
    return { description, hash: hashPbrRenderScene(description) };
}

export function assertPbrRenderSceneDescription(value) {
    const source = object(value, "renderScene");
    keys(source, [
        "kind", "version", "provider", "productProfile", "coordinateFrame", "worldHash",
        "visualLayerHash", "recipe", "recipeHash", "assetClosure", "assetClosureHash",
        "analyticTruth", "dynamicTransforms", "actors",
    ], "renderScene");
    if (source.kind !== PBR_RENDER_SCENE_KIND || source.version !== PBR_RENDER_SCENE_VERSION) {
        fail("renderScene", `expected ${PBR_RENDER_SCENE_KIND} version ${PBR_RENDER_SCENE_VERSION}`);
    }
    if (source.provider?.id !== VISUAL_RENDER_PROVIDERS.pbrMesh.id
        || source.provider?.version !== VISUAL_RENDER_PROVIDERS.pbrMesh.version) {
        fail("renderScene.provider", "expected pbr-mesh@1");
    }
    const profile = object(source.productProfile, "renderScene.productProfile");
    keys(profile, ["id", "version"], "renderScene.productProfile");
    text(profile.id, "renderScene.productProfile.id");
    if (!Number.isSafeInteger(profile.version) || profile.version < 1) fail("renderScene.productProfile.version", "expected a positive safe integer");
    object(source.coordinateFrame, "renderScene.coordinateFrame");
    digest(source.worldHash, "renderScene.worldHash");
    digest(source.visualLayerHash, "renderScene.visualLayerHash");
    const expectedPixelRecipe = normalizePbrPixelRecipe(source.recipe);
    exact(source.recipe, expectedPixelRecipe, "renderScene.recipe");
    if (digest(source.recipeHash, "renderScene.recipeHash") !== sha256ExactUtf8(canonicalExactStringify(source.recipe))) {
        fail("renderScene.recipeHash", "does not match the exact recipe");
    }
    const closure = normalizePbrAssetClosure(source.assetClosure);
    exact(source.assetClosure, closure, "renderScene.assetClosure");
    if (digest(source.assetClosureHash, "renderScene.assetClosureHash") !== hashPbrAssetClosure(closure)) {
        fail("renderScene.assetClosureHash", "does not match the exact asset closure");
    }
    assertLidarGeometryResource(source.analyticTruth);
    exact(
        source.coordinateFrame,
        source.analyticTruth.description.coordinateFrame,
        "renderScene.coordinateFrame",
    );
    const dynamicTransforms = object(source.dynamicTransforms, "renderScene.dynamicTransforms");
    keys(dynamicTransforms, ["source", "frame", "composition"], "renderScene.dynamicTransforms");
    if (canonicalExactStringify(dynamicTransforms) !== canonicalExactStringify({
        source: "simulation-actor-pose@1",
        frame: "world",
        composition: "world-pose-times-visual-to-actor@1",
    })) fail("renderScene.dynamicTransforms", "unsupported transform contract");
    const truthActorIds = new Set(source.analyticTruth.description.actors.map((entry) => entry.actorId));
    const actors = sortedUnique(source.actors, "renderScene.actors", (entry, path) => {
        const actor = object(entry, path);
        keys(actor, ["actorId", "mode", "transform", "source"], path);
        const actorId = text(actor.actorId, `${path}.actorId`);
        if (!truthActorIds.has(actorId)) fail(`${path}.actorId`, "does not exist in analytic truth");
        const mode = enumValue(actor.mode, ACTOR_MODES, `${path}.mode`);
        const sourceValue = object(actor.source, `${path}.source`);
        if (mode === "canonical-primitives") {
            keys(sourceValue, ["kind", "version"], `${path}.source`);
            if (sourceValue.kind !== "analytic-truth-primitives" || sourceValue.version !== 1) {
                fail(`${path}.source`, "unsupported canonical actor source");
            }
        } else {
            keys(sourceValue, ["kind", "version", "asset", "material"], `${path}.source`);
            if (sourceValue.kind !== "visual-asset" || sourceValue.version !== 1) {
                fail(`${path}.source`, "unsupported visual actor source");
            }
            assertVisualAssetReference(sourceValue.asset, `${path}.source.asset`);
            if (sourceValue.asset.role !== "actor") fail(`${path}.source.asset.role`, "expected actor");
            exact(sourceValue.material, normalizeActorMaterial(sourceValue.material, `${path}.source.material`), `${path}.source.material`);
        }
        return { actorId, mode, transform: matrix(actor.transform, `${path}.transform`), source: sourceValue };
    }, (entry) => entry.actorId);
    exact(source.actors, actors, "renderScene.actors");
    if (actors.length !== truthActorIds.size) fail("renderScene.actors", "must cover every analytic actor exactly once");
    exact(
        actors,
        resolvedActorsFromPixelRecipe(expectedPixelRecipe, source.analyticTruth),
        "renderScene.actors",
    );
    const closureAssets = new Map(closure.assets.map((asset) => [asset.sha256, asset]));
    for (const binding of pixelRecipeAssets(expectedPixelRecipe)) {
        const closed = closureAssets.get(binding.asset.sha256);
        if (!closed || canonicalExactStringify(closed) !== canonicalExactStringify(binding.asset)) {
            fail("renderScene.assetClosure", `does not contain exact ${binding.scope} asset ${binding.asset.sha256}`);
        }
    }
    return value;
}

export function hashPbrRenderScene(value) {
    assertPbrRenderSceneDescription(value);
    return sha256ExactUtf8(canonicalExactStringify(value));
}

function normalizeEvidenceRoot(value, path) {
    const source = object(value, path);
    keys(source, ["scope", "sha256", "useHash"], path);
    return {
        scope: text(source.scope, `${path}.scope`),
        sha256: digest(source.sha256, `${path}.sha256`),
        useHash: digest(source.useHash, `${path}.useHash`),
    };
}

function normalizeObligations(value, path) {
    const source = object(value ?? {}, path);
    keys(source, ["attribution", "requirements", "retentionUntil"], path);
    const strings = (values, itemPath) => sortedUnique(values ?? [], itemPath, (entry, pathEntry) => text(entry, pathEntry), (entry) => entry);
    return {
        attribution: strings(source.attribution, `${path}.attribution`),
        requirements: strings(source.requirements, `${path}.requirements`),
        retentionUntil: source.retentionUntil === null || source.retentionUntil === undefined
            ? null : text(source.retentionUntil, `${path}.retentionUntil`),
    };
}

export function normalizePbrRunEvidence(value) {
    const source = object(value, "evidence");
    keys(source, ["kind", "version", "visualAssets", "correspondence"], "evidence");
    const visualAssets = object(source.visualAssets, "evidence.visualAssets");
    keys(visualAssets, [
        "descriptorHash", "accessHash", "access", "roots", "uses", "assetClosureHash", "permissions",
    ], "evidence.visualAssets");
    const uses = sortedUnique(visualAssets.uses ?? [], "evidence.visualAssets.uses", (entry, path) => {
        const record = object(entry, path);
        keys(record, ["useHash", "use"], path);
        assertVisualAssetUse(record.use);
        const useHash = digest(record.useHash, `${path}.useHash`);
        if (hashVisualAssetUse(record.use) !== useHash) fail(`${path}.useHash`, "does not match the exact use record");
        return { useHash, use: record.use };
    }, (entry) => entry.useHash);
    const permissions = object(visualAssets.permissions, "evidence.visualAssets.permissions");
    keys(permissions, ["operations", "evaluatedSourceIds", "obligations"], "evidence.visualAssets.permissions");
    const correspondence = source.correspondence === null || source.correspondence === undefined
        ? null
        : (() => {
            const record = object(source.correspondence, "evidence.correspondence");
            keys(record, ["reportHash", "status"], "evidence.correspondence");
            if (record.status !== "unverified-reference") fail("evidence.correspondence.status", "expected unverified-reference");
            return { reportHash: digest(record.reportHash, "evidence.correspondence.reportHash"), status: record.status };
        })();
    const result = {
        kind: source.kind ?? PBR_RUN_EVIDENCE_KIND,
        version: source.version ?? PBR_RUN_EVIDENCE_VERSION,
        visualAssets: {
            descriptorHash: digest(visualAssets.descriptorHash, "evidence.visualAssets.descriptorHash"),
            accessHash: digest(visualAssets.accessHash, "evidence.visualAssets.accessHash"),
            access: visualAssets.access,
            roots: sortedUnique(visualAssets.roots ?? [], "evidence.visualAssets.roots", normalizeEvidenceRoot,
                (entry) => `${entry.scope}:${entry.sha256}:${entry.useHash}`),
            uses,
            assetClosureHash: digest(visualAssets.assetClosureHash, "evidence.visualAssets.assetClosureHash"),
            permissions: {
                operations: sortedUnique(permissions.operations ?? [], "evidence.visualAssets.permissions.operations",
                    (entry, path) => enumValue(entry, PBR_MEASURED_ASSET_OPERATIONS, path), (entry) => entry),
                evaluatedSourceIds: sortedUnique(permissions.evaluatedSourceIds ?? [], "evidence.visualAssets.permissions.evaluatedSourceIds",
                    (entry, path) => text(entry, path), (entry) => entry),
                obligations: normalizeObligations(permissions.obligations, "evidence.visualAssets.permissions.obligations"),
            },
        },
        correspondence,
    };
    if (result.kind !== PBR_RUN_EVIDENCE_KIND || result.version !== PBR_RUN_EVIDENCE_VERSION) {
        fail("evidence", `expected ${PBR_RUN_EVIDENCE_KIND} version ${PBR_RUN_EVIDENCE_VERSION}`);
    }
    return result;
}

function closureFromUseRecords(uses) {
    const byDigest = new Map();
    for (const { use } of uses) {
        const prior = byDigest.get(use.asset.sha256);
        if (prior && canonicalExactStringify(prior) !== canonicalExactStringify(use.asset)) {
            fail("evidence.visualAssets.uses", `conflicting metadata for asset ${use.asset.sha256}`);
        }
        byDigest.set(use.asset.sha256, use.asset);
    }
    return normalizePbrAssetClosure({ assets: [...byDigest.values()] });
}

export function assertPbrRunEvidence(value, { visualLayer, renderScene } = {}) {
    const normalized = normalizePbrRunEvidence(value);
    exact(value, normalized, "evidence");
    const assets = normalized.visualAssets;
    assertVisualLayerAccess(assets.access);
    if (hashVisualLayerAccess(assets.access) !== assets.accessHash) fail("evidence.visualAssets.accessHash", "does not match access sidecar");
    if (assets.access.descriptorHash !== assets.descriptorHash) fail("evidence.visualAssets.access", "descriptor hash mismatch");
    const useMap = new Map(assets.uses.map((entry) => [entry.useHash, entry.use]));
    for (const root of assets.roots) {
        const use = useMap.get(root.useHash);
        if (!use || use.asset.sha256 !== root.sha256) fail("evidence.visualAssets.roots", `missing matching use ${root.useHash}`);
    }
    const visited = new Set();
    const visit = (useHash) => {
        if (visited.has(useHash)) return;
        const use = useMap.get(useHash);
        if (!use) fail("evidence.visualAssets.uses", `missing transitive use ${useHash}`);
        visited.add(useHash);
        for (const dependency of Object.values(use.dependencies)) visit(dependency);
    };
    assets.roots.forEach((root) => visit(root.useHash));
    if (visited.size !== useMap.size) fail("evidence.visualAssets.uses", "contains records outside the selected closure");
    const closure = closureFromUseRecords(assets.uses);
    if (hashPbrAssetClosure(closure) !== assets.assetClosureHash) fail("evidence.visualAssets.assetClosureHash", "does not match use closure");
    if (canonicalExactStringify(assets.permissions.operations) !== canonicalExactStringify([...PBR_MEASURED_ASSET_OPERATIONS])) {
        fail("evidence.visualAssets.permissions.operations", "must bind measured display and machine-interpretation operations");
    }
    const evaluatedSources = new Set(assets.permissions.evaluatedSourceIds);
    for (const { use } of assets.uses) {
        for (const sourceId of use.sourceIds) {
            if (!evaluatedSources.has(sourceId)) {
                fail("evidence.visualAssets.permissions.evaluatedSourceIds", `does not cover source ${sourceId}`);
            }
        }
    }
    if (visualLayer) {
        assertVisualLayer(visualLayer.description);
        if (hashVisualLayer(visualLayer.description) !== assets.descriptorHash || visualLayer.hash !== assets.descriptorHash) {
            fail("evidence.visualAssets.descriptorHash", "does not match the resolved visual layer");
        }
        assertVisualLayerAccessMatches(assets.access, visualLayer.description, useMap);
        const expectedLayerRoots = assets.access.assets.map((entry) => `visual-layer:${entry.sha256}:${entry.useHash}`).sort(compareUtf8);
        const layerRoots = assets.roots.filter((entry) => entry.scope === "visual-layer")
            .map((entry) => `${entry.scope}:${entry.sha256}:${entry.useHash}`).sort(compareUtf8);
        if (canonicalExactStringify(layerRoots) !== canonicalExactStringify(expectedLayerRoots)) {
            fail("evidence.visualAssets.roots", "visual-layer roots do not match the access sidecar");
        }
    }
    if (renderScene) {
        assertPbrRenderSceneDescription(renderScene.description);
        if (renderScene.description.assetClosureHash !== assets.assetClosureHash
            || canonicalExactStringify(renderScene.description.assetClosure) !== canonicalExactStringify(closure)) {
            fail("evidence.visualAssets", "does not match the render-scene asset closure");
        }
        const expectedRecipeAssets = pixelRecipeAssets(renderScene.description.recipe);
        const recipeRoots = assets.roots.filter((entry) => entry.scope !== "visual-layer");
        const expectedKeys = expectedRecipeAssets.map((entry) => `${entry.scope}:${entry.asset.sha256}`);
        const actualKeys = recipeRoots.map((entry) => `${entry.scope}:${entry.sha256}`);
        if (canonicalExactStringify(actualKeys) !== canonicalExactStringify(expectedKeys)) {
            fail("evidence.visualAssets.roots", "render-recipe roots do not match the selected actor and environment assets");
        }
        for (const [index, expected] of expectedRecipeAssets.entries()) {
            const use = useMap.get(recipeRoots[index].useHash);
            if (canonicalExactStringify(use.asset) !== canonicalExactStringify(expected.asset)) {
                fail("evidence.visualAssets.roots", `use metadata does not match ${expected.scope}`);
            }
        }
    }
    return value;
}

export function hashPbrRunEvidence(value) {
    assertPbrRunEvidence(value);
    return sha256ExactUtf8(canonicalExactStringify(value));
}
