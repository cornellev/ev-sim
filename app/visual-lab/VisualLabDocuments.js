import {
    canonicalExactStringify,
    sha256ExactUtf8,
} from "../simulation/visual/VisualLayer.js";
import { experimentZeroCaseInput } from "./ExperimentZeroCase.js";
import { EXPERIMENT_ZERO_MEDIA_HASHES } from "./ExperimentZeroMediaManifest.js";
import { experimentOneCaseInput } from "./ExperimentOneCase.js";
import { EXPERIMENT_ONE_ASSET_MANIFEST } from "./ExperimentOneAssetManifest.js";
import { EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST } from "./ExperimentOneBrowserMediaManifest.js";
import { EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST } from "./ExperimentOneCyclesMediaManifest.js";

export const VISUAL_LAB_CASE_KIND = "cev-sim.visual-lab-case";
export const VISUAL_LAB_CANDIDATE_KIND = "cev-sim.visual-lab-candidate";
export const VISUAL_LAB_REVIEW_KIND = "cev-sim.visual-lab-review";
export const VISUAL_LAB_EXPORT_KIND = "cev-sim.visual-lab-review-pack";
export const VISUAL_LAB_VERSION = 1;

export const VISUAL_LAB_OUTPUT_STAGES = Object.freeze([
    "source-render",
    "generated-image",
    "baked-scene-render",
    "measured-camera-capture",
    "reference-renderer-photograph",
]);

export const VISUAL_LAB_STAGE_LABELS = Object.freeze({
    "source-render": "Source render",
    "generated-image": "Generated image",
    "baked-scene-render": "Baked-scene render",
    "measured-camera-capture": "Measured-camera capture",
    "reference-renderer-photograph": "Reference renderer / photograph",
});

export const VISUAL_LAB_DEFECT_CATEGORIES = Object.freeze([
    "geometry-identity",
    "seams",
    "missing-coverage",
    "texture-scale",
    "contact-shadows",
    "reflections-relighting",
    "temporal-instability",
    "color-aliasing",
]);

export const VISUAL_LAB_DEFECT_SEVERITIES = Object.freeze(["note", "minor", "major", "blocking"]);
export const VISUAL_LAB_DEFECT_STATUSES = Object.freeze(["open", "resolved"]);

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;

function fail(path, message) {
    const error = new TypeError(`${path}: ${message}`);
    error.code = "VISUAL_LAB_DOCUMENT_INVALID";
    throw error;
}

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
    return value;
}

function string(value, path, { identifier = false, nullable = false } = {}) {
    if (nullable && value == null) return null;
    if (typeof value !== "string" || !value.trim()) fail(path, "expected non-empty text");
    const result = value.normalize("NFC").trim();
    if (identifier && !IDENTIFIER.test(result)) fail(path, "expected a lowercase identifier");
    return result;
}

function number(value, path, { integer = false, min = -Infinity } = {}) {
    if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min) {
        fail(path, `expected ${integer ? "an integer" : "a number"} >= ${min}`);
    }
    return Object.is(value, -0) ? 0 : value;
}

function bool(value, path) {
    if (typeof value !== "boolean") fail(path, "expected a boolean");
    return value;
}

function oneOf(value, values, path) {
    const result = string(value, path);
    if (!values.includes(result)) fail(path, `unsupported value ${JSON.stringify(result)}`);
    return result;
}

function array(value, path, normalize, { min = 0 } = {}) {
    if (!Array.isArray(value) || value.length < min) fail(path, `expected an array with at least ${min} entries`);
    return value.map((entry, index) => normalize(entry, `${path}.${index}`));
}

function vector(value, size, path) {
    if (!Array.isArray(value) || value.length !== size) fail(path, `expected ${size} numbers`);
    return value.map((entry, index) => number(entry, `${path}.${index}`));
}

function unique(values, path, key = (value) => value.id) {
    const seen = new Set();
    for (const value of values) {
        const id = key(value);
        if (seen.has(id)) fail(path, `contains duplicate ${JSON.stringify(id)}`);
        seen.add(id);
    }
    return values;
}

function json(value, path) {
    try {
        return JSON.parse(JSON.stringify(value ?? null));
    } catch {
        fail(path, "must be JSON serializable");
    }
}

function normalizePose(value, path) {
    const source = object(value, path);
    return {
        position: vector(source.position, 3, `${path}.position`),
        target: vector(source.target, 3, `${path}.target`),
    };
}

function normalizeCaseSample(value, path) {
    const source = object(value, path);
    return {
        sampleIndex: number(source.sampleIndex, `${path}.sampleIndex`, { integer: true, min: 0 }),
        captureTimeNs: number(source.captureTimeNs, `${path}.captureTimeNs`, { integer: true, min: 0 }),
        pose: normalizePose(source.pose, `${path}.pose`),
    };
}

function normalizeCalibration(value, path) {
    const source = object(value, path);
    const image = object(source.image, `${path}.image`);
    const intrinsics = object(source.intrinsics, `${path}.intrinsics`);
    const distortion = object(source.distortion, `${path}.distortion`);
    return {
        id: string(source.id, `${path}.id`, { identifier: true }),
        image: {
            width: number(image.width, `${path}.image.width`, { integer: true, min: 1 }),
            height: number(image.height, `${path}.image.height`, { integer: true, min: 1 }),
        },
        intrinsics: {
            fx: number(intrinsics.fx, `${path}.intrinsics.fx`, { min: Number.EPSILON }),
            fy: number(intrinsics.fy, `${path}.intrinsics.fy`, { min: Number.EPSILON }),
            cx: number(intrinsics.cx, `${path}.intrinsics.cx`),
            cy: number(intrinsics.cy, `${path}.intrinsics.cy`),
        },
        near: number(source.near, `${path}.near`, { min: Number.EPSILON }),
        far: number(source.far, `${path}.far`, { min: Number.EPSILON }),
        distortion: {
            model: string(distortion.model, `${path}.distortion.model`),
            coefficients: array(distortion.coefficients ?? [], `${path}.distortion.coefficients`, (entry, itemPath) => number(entry, itemPath)),
        },
        projectionContract: string(source.projectionContract, `${path}.projectionContract`),
    };
}

export function normalizeVisualLabCase(value) {
    const source = object(value, "visualLabCase");
    if (source.kind !== VISUAL_LAB_CASE_KIND || source.version !== VISUAL_LAB_VERSION) {
        fail("visualLabCase", `expected ${VISUAL_LAB_CASE_KIND}@${VISUAL_LAB_VERSION}`);
    }
    const environment = object(source.sourceEnvironment, "visualLabCase.sourceEnvironment");
    const scene = object(source.scene, "visualLabCase.scene");
    const measured = object(source.measuredCapture, "visualLabCase.measuredCapture");
    const result = {
        kind: VISUAL_LAB_CASE_KIND,
        version: VISUAL_LAB_VERSION,
        id: string(source.id, "visualLabCase.id", { identifier: true }),
        name: string(source.name, "visualLabCase.name"),
        description: string(source.description, "visualLabCase.description"),
        sourceEnvironment: {
            id: string(environment.id, "visualLabCase.sourceEnvironment.id", { identifier: true }),
            revision: number(environment.revision, "visualLabCase.sourceEnvironment.revision", { integer: true, min: 0 }),
            worldHash: environment.worldHash == null ? null : string(environment.worldHash, "visualLabCase.sourceEnvironment.worldHash"),
            visualOnly: bool(environment.visualOnly, "visualLabCase.sourceEnvironment.visualOnly"),
        },
        scene: json(scene, "visualLabCase.scene"),
        calibrations: unique(array(source.calibrations, "visualLabCase.calibrations", normalizeCalibration, { min: 1 }), "visualLabCase.calibrations"),
        viewpoints: unique(array(source.viewpoints, "visualLabCase.viewpoints", (entry, path) => {
            const view = object(entry, path);
            return {
                id: string(view.id, `${path}.id`, { identifier: true }),
                name: string(view.name, `${path}.name`),
                generationInput: bool(view.generationInput, `${path}.generationInput`),
                withheld: bool(view.withheld, `${path}.withheld`),
                pose: normalizePose(view.pose, `${path}.pose`),
            };
        }, { min: 1 }), "visualLabCase.viewpoints"),
        paths: unique(array(source.paths, "visualLabCase.paths", (entry, path) => {
            const item = object(entry, path);
            const samples = array(item.samples, `${path}.samples`, normalizeCaseSample, { min: 2 });
            samples.forEach((sample, index) => {
                if (sample.sampleIndex !== index) fail(`${path}.samples.${index}.sampleIndex`, "must be contiguous and zero-based");
                if (index > 0 && sample.captureTimeNs <= samples[index - 1].captureTimeNs) {
                    fail(`${path}.samples.${index}.captureTimeNs`, "must increase monotonically");
                }
            });
            return {
                id: string(item.id, `${path}.id`, { identifier: true }),
                name: string(item.name, `${path}.name`),
                durationNs: number(item.durationNs, `${path}.durationNs`, { integer: true, min: 1 }),
                nominalFps: number(item.nominalFps, `${path}.nominalFps`, { min: Number.EPSILON }),
                generationInput: bool(item.generationInput, `${path}.generationInput`),
                withheld: bool(item.withheld, `${path}.withheld`),
                captureDirection: string(item.captureDirection, `${path}.captureDirection`),
                samples,
            };
        }, { min: 1 }), "visualLabCase.paths"),
        conditions: unique(array(source.conditions, "visualLabCase.conditions", (entry, path) => {
            const item = object(entry, path);
            return {
                id: string(item.id, `${path}.id`, { identifier: true }),
                name: string(item.name, `${path}.name`),
                rendererSupport: oneOf(item.rendererSupport, ["measured-and-reference", "reference-only"], `${path}.rendererSupport`),
                recipe: json(item.recipe, `${path}.recipe`),
            };
        }, { min: 1 }), "visualLabCase.conditions"),
        editVariants: unique(array(source.editVariants, "visualLabCase.editVariants", (entry, path) => {
            const item = object(entry, path);
            const normalized = {
                id: string(item.id, `${path}.id`, { identifier: true }),
                name: string(item.name, `${path}.name`),
                transforms: json(item.transforms ?? [], `${path}.transforms`),
            };
            if (item.lights !== undefined) normalized.lights = json(item.lights, `${path}.lights`);
            return normalized;
        }, { min: 1 }), "visualLabCase.editVariants"),
        comparisonVariables: unique(array(source.comparisonVariables, "visualLabCase.comparisonVariables", (entry, path) => {
            const item = object(entry, path);
            const normalized = {
                id: string(item.id, `${path}.id`, { identifier: true }),
                values: unique(array(item.values, `${path}.values`, (value, itemPath) => string(value, itemPath), { min: 1 }), `${path}.values`, (entry) => entry),
            };
            if (item.affects !== undefined) {
                normalized.affects = unique(array(item.affects, `${path}.affects`, (value, itemPath) => string(value, itemPath), { min: 1 }), `${path}.affects`, (entry) => entry);
            }
            return normalized;
        }), "visualLabCase.comparisonVariables"),
        referenceBoard: json(source.referenceBoard ?? [], "visualLabCase.referenceBoard"),
        measuredCapture: {
            status: string(measured.status, "visualLabCase.measuredCapture.status"),
            missingObjectIds: array(measured.missingObjectIds ?? [], "visualLabCase.measuredCapture.missingObjectIds", (entry, path) => string(entry, path, { identifier: true })),
            message: string(measured.message, "visualLabCase.measuredCapture.message"),
            ...(measured.worldHash === undefined ? {} : { worldHash: string(measured.worldHash, "visualLabCase.measuredCapture.worldHash") }),
        },
    };
    return result;
}

function normalizeMedia(value, path) {
    const source = object(value, path);
    const hasUse = source.useHash != null;
    const hasUrl = source.url != null;
    if (hasUse === hasUrl) fail(path, "requires exactly one of useHash or url");
    const result = {
        useHash: hasUse ? string(source.useHash, `${path}.useHash`) : null,
        url: hasUrl ? string(source.url, `${path}.url`) : null,
        sha256: source.sha256 == null ? null : string(source.sha256, `${path}.sha256`),
        width: number(source.width, `${path}.width`, { integer: true, min: 1 }),
        height: number(source.height, `${path}.height`, { integer: true, min: 1 }),
    };
    if (result.useHash && !SHA256.test(result.useHash)) fail(`${path}.useHash`, "expected a lowercase SHA-256 use hash");
    if (result.sha256 && !SHA256.test(result.sha256)) fail(`${path}.sha256`, "expected a lowercase SHA-256 digest");
    if (result.url && !result.url.startsWith("/")) fail(`${path}.url`, "only same-origin media URLs are supported");
    return result;
}

function normalizeCandidateSample(value, path) {
    const source = object(value, path);
    if ((source.viewpointId == null) === (source.pathId == null)) {
        fail(path, "requires exactly one of viewpointId or pathId");
    }
    return {
        viewpointId: source.viewpointId == null ? null : string(source.viewpointId, `${path}.viewpointId`, { identifier: true }),
        pathId: source.pathId == null ? null : string(source.pathId, `${path}.pathId`, { identifier: true }),
        sampleIndex: number(source.sampleIndex, `${path}.sampleIndex`, { integer: true, min: 0 }),
        captureTimeNs: number(source.captureTimeNs, `${path}.captureTimeNs`, { integer: true, min: 0 }),
        media: normalizeMedia(source.media, `${path}.media`),
    };
}

function normalizeOutput(value, path) {
    const source = object(value, path);
    const stage = oneOf(source.stage, VISUAL_LAB_OUTPUT_STAGES, `${path}.stage`);
    const provenance = object(source.provenance, `${path}.provenance`);
    if (stage === "measured-camera-capture" && provenance.captureContract !== "cev-sim.visual-camera-calibration@1") {
        fail(`${path}.provenance.captureContract`, "measured captures require the calibrated sensor capture contract");
    }
    if (stage === "baked-scene-render" && !provenance.sceneArtifactHash) {
        fail(`${path}.provenance.sceneArtifactHash`, "baked-scene renders require a retained scene artifact hash");
    }
    if (stage === "generated-image" && !provenance.model) {
        fail(`${path}.provenance.model`, "generated images require model provenance");
    }
    return {
        id: string(source.id, `${path}.id`, { identifier: true }),
        name: string(source.name, `${path}.name`),
        stage,
        rendererId: string(source.rendererId, `${path}.rendererId`),
        calibrationId: string(source.calibrationId, `${path}.calibrationId`, { identifier: true }),
        conditionId: string(source.conditionId, `${path}.conditionId`, { identifier: true }),
        editVariantId: string(source.editVariantId, `${path}.editVariantId`, { identifier: true }),
        product: string(source.product ?? "beauty", `${path}.product`, { identifier: true }),
        provenance: json(provenance, `${path}.provenance`),
        samples: array(source.samples ?? [], `${path}.samples`, normalizeCandidateSample),
    };
}

export function normalizeVisualLabCandidate(value) {
    const source = object(value, "visualLabCandidate");
    if (source.kind !== VISUAL_LAB_CANDIDATE_KIND || source.version !== VISUAL_LAB_VERSION) {
        fail("visualLabCandidate", `expected ${VISUAL_LAB_CANDIDATE_KIND}@${VISUAL_LAB_VERSION}`);
    }
    return {
        kind: VISUAL_LAB_CANDIDATE_KIND,
        version: VISUAL_LAB_VERSION,
        id: string(source.id, "visualLabCandidate.id", { identifier: true }),
        caseId: string(source.caseId, "visualLabCandidate.caseId", { identifier: true }),
        name: string(source.name, "visualLabCandidate.name"),
        description: string(source.description, "visualLabCandidate.description"),
        status: oneOf(source.status, ["complete", "incomplete", "failed"], "visualLabCandidate.status"),
        attempt: number(source.attempt, "visualLabCandidate.attempt", { integer: true, min: 1 }),
        variables: json(source.variables ?? {}, "visualLabCandidate.variables"),
        scene: json(source.scene, "visualLabCandidate.scene"),
        outputs: unique(array(source.outputs ?? [], "visualLabCandidate.outputs", normalizeOutput), "visualLabCandidate.outputs"),
        limitations: array(source.limitations ?? [], "visualLabCandidate.limitations", (entry, path) => string(entry, path)),
    };
}

function normalizeRect(value, path) {
    const source = object(value, path);
    const result = {
        x: number(source.x, `${path}.x`, { min: 0 }),
        y: number(source.y, `${path}.y`, { min: 0 }),
        width: number(source.width, `${path}.width`, { min: Number.EPSILON }),
        height: number(source.height, `${path}.height`, { min: Number.EPSILON }),
    };
    if (result.x + result.width > 1 || result.y + result.height > 1) fail(path, "must fit within normalized image bounds");
    return result;
}

function normalizeReviewTarget(value, path) {
    const source = object(value, path);
    return {
        candidateId: string(source.candidateId, `${path}.candidateId`, { identifier: true }),
        outputId: string(source.outputId, `${path}.outputId`, { identifier: true }),
        viewpointId: source.viewpointId == null ? null : string(source.viewpointId, `${path}.viewpointId`, { identifier: true }),
        pathId: source.pathId == null ? null : string(source.pathId, `${path}.pathId`, { identifier: true }),
        sampleIndex: number(source.sampleIndex ?? 0, `${path}.sampleIndex`, { integer: true, min: 0 }),
    };
}

export function normalizeVisualLabReview(value) {
    const source = object(value, "visualLabReview");
    if (source.kind !== VISUAL_LAB_REVIEW_KIND || source.version !== VISUAL_LAB_VERSION) {
        fail("visualLabReview", `expected ${VISUAL_LAB_REVIEW_KIND}@${VISUAL_LAB_VERSION}`);
    }
    const comparison = object(source.comparison, "visualLabReview.comparison");
    return {
        kind: VISUAL_LAB_REVIEW_KIND,
        version: VISUAL_LAB_VERSION,
        id: string(source.id, "visualLabReview.id", { identifier: true }),
        caseId: string(source.caseId, "visualLabReview.caseId", { identifier: true }),
        name: string(source.name, "visualLabReview.name"),
        comparison: {
            a: normalizeReviewTarget(comparison.a, "visualLabReview.comparison.a"),
            b: normalizeReviewTarget(comparison.b, "visualLabReview.comparison.b"),
            mode: oneOf(comparison.mode ?? "wipe", ["wipe", "side-by-side", "a", "b", "live"], "visualLabReview.comparison.mode"),
        },
        closeups: unique(array(source.closeups ?? [], "visualLabReview.closeups", (entry, path) => {
            const item = object(entry, path);
            return {
                id: string(item.id, `${path}.id`, { identifier: true }),
                name: string(item.name, `${path}.name`),
                target: normalizeReviewTarget(item.target, `${path}.target`),
                rectangle: normalizeRect(item.rectangle, `${path}.rectangle`),
            };
        }), "visualLabReview.closeups"),
        defects: unique(array(source.defects ?? [], "visualLabReview.defects", (entry, path) => {
            const item = object(entry, path);
            return {
                id: string(item.id, `${path}.id`, { identifier: true }),
                target: normalizeReviewTarget(item.target, `${path}.target`),
                objectId: item.objectId == null ? null : string(item.objectId, `${path}.objectId`, { identifier: true }),
                rectangle: item.rectangle == null ? null : normalizeRect(item.rectangle, `${path}.rectangle`),
                category: oneOf(item.category, VISUAL_LAB_DEFECT_CATEGORIES, `${path}.category`),
                severity: oneOf(item.severity, VISUAL_LAB_DEFECT_SEVERITIES, `${path}.severity`),
                status: oneOf(item.status, VISUAL_LAB_DEFECT_STATUSES, `${path}.status`),
                text: string(item.text, `${path}.text`),
                createdAt: string(item.createdAt, `${path}.createdAt`),
                resolvedAt: item.resolvedAt == null ? null : string(item.resolvedAt, `${path}.resolvedAt`),
            };
        }), "visualLabReview.defects"),
        arrangement: json(source.arrangement ?? { revision: 0, transforms: [] }, "visualLabReview.arrangement"),
        disposition: oneOf(source.disposition ?? "reviewing", ["reviewing", "accepted", "rejected"], "visualLabReview.disposition"),
    };
}

export function visualLabDocumentHash(value) {
    return sha256ExactUtf8(canonicalExactStringify(value));
}

export function createExperimentZeroCase() {
    return normalizeVisualLabCase(experimentZeroCaseInput());
}

export function createExperimentOneCase() {
    return normalizeVisualLabCase(experimentOneCaseInput());
}

function mediaUrl(candidateId, group, sampleId) {
    return `/visual-lab/experiment-0/${candidateId}/${group}/${sampleId}.png`;
}

function fixtureMedia(candidateId, group, sampleId) {
    const url = mediaUrl(candidateId, group, sampleId);
    return {
        useHash: null,
        url,
        sha256: EXPERIMENT_ZERO_MEDIA_HASHES[url] ?? null,
        width: 1280,
        height: 720,
    };
}

function candidateSamples(caseDocument, candidateId) {
    const stills = caseDocument.viewpoints.map((viewpoint) => ({
        viewpointId: viewpoint.id,
        pathId: null,
        sampleIndex: 0,
        captureTimeNs: 0,
        media: fixtureMedia(candidateId, "stills", viewpoint.id),
    }));
    const clips = caseDocument.paths.flatMap((path) => path.samples.map((sample) => ({
        viewpointId: null,
        pathId: path.id,
        sampleIndex: sample.sampleIndex,
        captureTimeNs: sample.captureTimeNs,
        media: fixtureMedia(candidateId, path.id, String(sample.sampleIndex).padStart(4, "0")),
    })));
    return { stills, clips };
}

function fixtureProvenance(sceneArtifactHash) {
    return {
        sceneArtifactHash,
        generatedBy: "scripts/generate-visual-lab-fixtures.mjs",
        mediaManifestUrl: "/visual-lab/experiment-0/manifest.json",
        rendererSettings: {
            renderer: "three-webgl",
            version: "0.182.0",
            colorSpace: "srgb",
            toneMapping: "none",
            exposure: 1,
            shadows: false,
            lighting: "hemisphere plus two unshadowed directional lights",
        },
    };
}

export function createExperimentZeroCandidates(caseDocument = createExperimentZeroCase()) {
    const base = candidateSamples(caseDocument, "b0-simple");
    const detailed = candidateSamples(caseDocument, "b1-detailed");
    const sceneHash = visualLabDocumentHash(caseDocument.scene);
    return [
        normalizeVisualLabCandidate({
            kind: VISUAL_LAB_CANDIDATE_KIND,
            version: VISUAL_LAB_VERSION,
            id: "b0-simple",
            caseId: caseDocument.id,
            name: "B0 / Simple incumbent",
            description: "Simple compatible room rendered before appearance generation.",
            status: "complete",
            attempt: 1,
            variables: { "asset-detail": "simple", "appearance-method": "incumbent" },
            scene: { fixtureId: caseDocument.scene.fixtureId, detail: "simple", artifactHash: sceneHash },
            outputs: [
                {
                    id: "source-stills",
                    name: "Source stills",
                    stage: "source-render",
                    rendererId: "cev-sim.visual-lab-fixture@1",
                    calibrationId: "review-camera-1280x720",
                    conditionId: "ordinary-environment",
                    editVariantId: "base",
                    product: "beauty",
                    provenance: fixtureProvenance(sceneHash),
                    samples: base.stills,
                },
                {
                    id: "source-clips",
                    name: "Source clip sequences",
                    stage: "source-render",
                    rendererId: "cev-sim.visual-lab-fixture@1",
                    calibrationId: "review-camera-1280x720",
                    conditionId: "ordinary-environment",
                    editVariantId: "base",
                    product: "beauty",
                    provenance: fixtureProvenance(sceneHash),
                    samples: base.clips,
                },
            ],
            limitations: ["Visual-only fixture: measured-camera output is blocked by partial metric bindings."],
        }),
        normalizeVisualLabCandidate({
            kind: VISUAL_LAB_CANDIDATE_KIND,
            version: VISUAL_LAB_VERSION,
            id: "b1-detailed",
            caseId: caseDocument.id,
            name: "B1 / Detailed retained scene",
            description: "Fresh renders of the detailed retained room scene, including thin geometry, seams, bevels, and undersides.",
            status: "complete",
            attempt: 1,
            variables: { "asset-detail": "detailed", "appearance-method": "incumbent" },
            scene: { fixtureId: caseDocument.scene.fixtureId, detail: "detailed", artifactHash: sceneHash },
            outputs: [
                {
                    id: "baked-stills",
                    name: "Baked-scene stills",
                    stage: "baked-scene-render",
                    rendererId: "cev-sim.visual-lab-fixture@1",
                    calibrationId: "review-camera-1280x720",
                    conditionId: "ordinary-environment",
                    editVariantId: "base",
                    product: "beauty",
                    provenance: fixtureProvenance(sceneHash),
                    samples: detailed.stills,
                },
                {
                    id: "baked-clips",
                    name: "Baked-scene clip sequences",
                    stage: "baked-scene-render",
                    rendererId: "cev-sim.visual-lab-fixture@1",
                    calibrationId: "review-camera-1280x720",
                    conditionId: "ordinary-environment",
                    editVariantId: "base",
                    product: "beauty",
                    provenance: fixtureProvenance(sceneHash),
                    samples: detailed.clips,
                },
            ],
            limitations: ["Directional shadows and tone mapping are reference-renderer concerns in the current measured profile."],
        }),
    ];
}

function experimentOneMedia(url) {
    return {
        useHash: null,
        url,
        sha256: EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files[url] ?? null,
        width: EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.image.width,
        height: EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.image.height,
    };
}

function experimentOneOutputSamples(caseDocument, record) {
    const root = `/visual-lab/experiment-1/browser/${record.candidateId}/${record.id}`;
    const stills = caseDocument.viewpoints.flatMap((viewpoint) => {
        const url = `${root}/stills/${viewpoint.id}.png`;
        return EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files[url] ? [{
            viewpointId: viewpoint.id,
            pathId: null,
            sampleIndex: 0,
            captureTimeNs: 0,
            media: experimentOneMedia(url),
        }] : [];
    });
    const paths = caseDocument.paths.flatMap((pathDocument) => pathDocument.samples.flatMap((sample) => {
        const url = `${root}/${pathDocument.id}/${String(sample.sampleIndex).padStart(4, "0")}.png`;
        return EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.files[url] ? [{
            viewpointId: null,
            pathId: pathDocument.id,
            sampleIndex: sample.sampleIndex,
            captureTimeNs: sample.captureTimeNs,
            media: experimentOneMedia(url),
        }] : [];
    }));
    return [...stills, ...paths];
}

function experimentOneMatch(caseDocument, candidate, record) {
    const calibration = caseDocument.calibrations.find((entry) => entry.id === "review-camera-1280x720");
    const glb = EXPERIMENT_ONE_ASSET_MANIFEST.files.find((entry) => entry.path.endsWith(".glb"));
    const detailed = candidate !== "b0";
    return {
        calibrationHash: visualLabDocumentHash(calibration),
        scheduleHash: visualLabDocumentHash({ viewpoints: caseDocument.viewpoints, paths: caseDocument.paths }),
        geometryHash: visualLabDocumentHash({ fixtureId: caseDocument.scene.fixtureId, detail: detailed ? "detailed" : "simple", glb: detailed ? glb?.sha256 : null }),
        materialHash: visualLabDocumentHash({ appearance: candidate === "b0" ? "incumbent" : "compatible", glb: detailed ? glb?.sha256 : null }),
        rendererProfileHash: visualLabDocumentHash({ rendererId: record.rendererId, recipeVersion: record.rendererSettings.version, runtime: EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.renderer }),
        rasterizationHash: visualLabDocumentHash({
            rasterization: record.rendererSettings.rasterization,
            lodPolicy: record.rendererSettings.lodPolicy,
            decoders: record.rendererSettings.decoders,
            actors: record.rendererSettings.actors,
        }),
        backgroundHash: visualLabDocumentHash(record.rendererSettings.background),
        lightingHash: visualLabDocumentHash(record.lightingSettings ?? { lighting: record.rendererSettings.lighting, shadows: record.rendererSettings.shadows }),
        colorPipelineHash: visualLabDocumentHash(record.rendererSettings.colorPipeline),
    };
}

function experimentOneBrowserOutput(caseDocument, candidateKey, record) {
    const correctionLabel = record.correction === "none" ? "baseline" : record.correction;
    return {
        id: record.id,
        name: `${record.conditionId} / ${record.editVariantId} / ${correctionLabel}`,
        stage: "measured-camera-capture",
        rendererId: record.rendererId,
        calibrationId: "review-camera-1280x720",
        conditionId: record.conditionId,
        editVariantId: record.editVariantId,
        product: "beauty",
        provenance: {
            captureContract: "cev-sim.visual-camera-calibration@1",
            generatedBy: "scripts/generate-experiment-one-browser.mjs",
            mediaManifestUrl: "/visual-lab/experiment-1/browser/manifest.json",
            assetManifestUrl: "/visual-lab/experiment-1/assets/manifest.json",
            assetDerivation: candidateKey === "b0"
                ? { geometry: "Repository-owned simple fixture geometry.", materials: "Incumbent browser materials." }
                : EXPERIMENT_ONE_ASSET_MANIFEST.rendererDerivations.browser,
            sceneArtifactHash: candidateKey === "b0"
                ? visualLabDocumentHash({ fixtureId: caseDocument.scene.fixtureId, detail: "simple" })
                : EXPERIMENT_ONE_ASSET_MANIFEST.files.find((entry) => entry.path.endsWith(".glb"))?.sha256,
            worldHash: caseDocument.sourceEnvironment.worldHash,
            rendererRuntime: EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.renderer,
            rendererSettings: record.rendererSettings,
            lightingSettings: record.lightingSettings ?? { lighting: record.rendererSettings.lighting, shadows: record.rendererSettings.shadows },
            capturePerformance: record.capturePerformance,
            match: experimentOneMatch(caseDocument, candidateKey, record),
        },
        samples: experimentOneOutputSamples(caseDocument, record),
    };
}

/** Built-in retained browser captures for B0, B1, and the isolated/combined B4 corrections. */
export function createExperimentOneBrowserCandidates(caseDocument = createExperimentOneCase()) {
    const records = EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.outputs;
    const definitions = [
        {
            id: "experiment-1-b0",
            key: "b0",
            name: "B0 / Simple incumbent measured",
            description: "Simple room with incumbent materials through the calibrated pbr-mesh@1 beauty pipeline.",
            source: (record) => record.candidateId === "b0-browser",
            variables: { "asset-detail": "simple", "appearance-method": "incumbent", "renderer-revision": "pbr-mesh@1", "controlled-correction": "none" },
        },
        {
            id: "experiment-1-b1",
            key: "b1",
            name: "B1 / Prepared assets measured",
            description: "Prepared Blender-derived room and compatible materials through the calibrated pbr-mesh@1 beauty pipeline.",
            source: (record) => record.candidateId === "b1-browser",
            variables: { "asset-detail": "detailed", "appearance-method": "compatible", "renderer-revision": "pbr-mesh@1", "controlled-correction": "none" },
        },
        ...["lighting", "shadows", "color", "combined"].map((correction) => ({
            id: `experiment-1-b4-${correction}`,
            key: "b4",
            name: `B4 / ${correction[0].toUpperCase()}${correction.slice(1)}`,
            description: `Prepared assets through pbr-mesh@2 with the ${correction} correction.`,
            source: (record) => record.candidateId === "b4-browser" && record.correction === correction,
            variables: { "asset-detail": "detailed", "appearance-method": "compatible", "renderer-revision": "pbr-mesh@2", "controlled-correction": correction },
        })),
    ];
    return definitions.map((definition) => {
        const outputs = records.filter(definition.source)
            .map((record) => experimentOneBrowserOutput(caseDocument, definition.key, record));
        const complete = EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST.completeMotionSchedules
            && outputs.some((output) => output.samples.some((sample) => sample.pathId));
        return normalizeVisualLabCandidate({
            kind: VISUAL_LAB_CANDIDATE_KIND,
            version: VISUAL_LAB_VERSION,
            id: definition.id,
            caseId: caseDocument.id,
            name: definition.name,
            description: definition.description,
            status: complete ? "complete" : "incomplete",
            attempt: 1,
            variables: definition.variables,
            scene: {
                fixtureId: caseDocument.scene.fixtureId,
                detail: definition.key === "b0" ? "simple" : "detailed",
                materialProfile: definition.key === "b0" ? "incumbent" : "physical",
                frozen: true,
                artifactHash: outputs[0]?.provenance.sceneArtifactHash,
                fixtureArtifactHash: visualLabDocumentHash(caseDocument.scene),
            },
            outputs,
            limitations: [
                ...(!complete ? ["The retained still matrix is complete; full 24 fps path capture remains to be generated."] : []),
                ...(definition.key === "b0" || definition.key === "b1"
                    ? ["The pbr-mesh@1 directional condition can reduce ambient illumination but cannot declare the independent directional and point lights introduced by pbr-mesh@2."]
                    : []),
            ],
        });
    });
}

function experimentOneReferenceSamples(caseDocument, record) {
    const retained = new Set(record.displayFiles);
    const root = `/visual-lab/experiment-1/reference/${record.candidateId}/${record.id}`;
    const media = (url) => ({
        useHash: null,
        url,
        sha256: EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.files[url] ?? null,
        width: EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.image.width,
        height: EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.image.height,
    });
    return [
        ...caseDocument.viewpoints.flatMap((viewpoint) => {
            const url = `${root}/stills/${viewpoint.id}.png`;
            return retained.has(url) ? [{ viewpointId: viewpoint.id, pathId: null, sampleIndex: 0, captureTimeNs: 0, media: media(url) }] : [];
        }),
        ...caseDocument.paths.flatMap((pathDocument) => pathDocument.samples.flatMap((sample) => {
            const url = `${root}/${pathDocument.id}/${String(sample.sampleIndex).padStart(4, "0")}.png`;
            return retained.has(url) ? [{ viewpointId: null, pathId: pathDocument.id, sampleIndex: sample.sampleIndex, captureTimeNs: sample.captureTimeNs, media: media(url) }] : [];
        })),
    ];
}

/** Pinned Cycles B2/B3 references. Partial manifests remain explicitly incomplete. */
export function createExperimentOneCyclesCandidates(caseDocument = createExperimentOneCase()) {
    const glb = EXPERIMENT_ONE_ASSET_MANIFEST.files.find((entry) => entry.path.endsWith(".glb"));
    return [
        { id: "experiment-1-b2", sourceId: "b2-cycles", detail: "simple", name: "B2 / Simple Cycles reference" },
        { id: "experiment-1-b3", sourceId: "b3-cycles", detail: "detailed", name: "B3 / Detailed Cycles reference" },
    ].map((definition) => {
        const records = EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.outputs
            .filter((record) => record.candidateId === definition.sourceId);
        const outputs = records.map((record) => ({
            id: record.id,
            name: `${record.conditionId} / ${record.editVariantId}`,
            stage: "reference-renderer-photograph",
            rendererId: "cycles@4.5.4-b3efe983cc58",
            calibrationId: "review-camera-1280x720",
            conditionId: record.conditionId,
            editVariantId: record.editVariantId,
            product: "beauty",
            provenance: {
                generatedBy: "scripts/generate-experiment-one-cycles.mjs",
                mediaManifestUrl: "/visual-lab/experiment-1/reference/manifest.json",
                assetManifestUrl: "/visual-lab/experiment-1/assets/manifest.json",
                assetDerivation: EXPERIMENT_ONE_ASSET_MANIFEST.rendererDerivations.cycles,
                sceneArtifactHash: glb?.sha256,
                blender: EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.blender,
                rendererSettings: record.rendererSettings,
                lightingSettings: record.lightingSettings ?? { conditionId: record.conditionId, editVariantId: record.editVariantId },
                linearArtifacts: record.linearFiles.map((url) => ({
                    url,
                    sha256: EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.files[url],
                })),
                match: {
                    calibrationHash: visualLabDocumentHash(caseDocument.calibrations[0]),
                    scheduleHash: visualLabDocumentHash({ viewpoints: caseDocument.viewpoints, paths: caseDocument.paths }),
                    geometryHash: visualLabDocumentHash({ fixtureId: caseDocument.scene.fixtureId, detail: definition.detail, glb: glb?.sha256 }),
                    materialHash: visualLabDocumentHash({ appearance: "physical-reference", glb: glb?.sha256 }),
                    rendererProfileHash: visualLabDocumentHash({ renderer: EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.renderer, blender: EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.blender }),
                    rasterizationHash: visualLabDocumentHash(record.rendererSettings),
                    backgroundHash: visualLabDocumentHash((record.lightingSettings ?? {}).world ?? { conditionId: record.conditionId }),
                    lightingHash: visualLabDocumentHash(record.lightingSettings ?? { conditionId: record.conditionId, editVariantId: record.editVariantId }),
                    colorPipelineHash: visualLabDocumentHash({ viewTransform: record.rendererSettings.viewTransform, look: record.rendererSettings.look }),
                },
            },
            samples: experimentOneReferenceSamples(caseDocument, record),
        }));
        const complete = EXPERIMENT_ONE_CYCLES_MEDIA_MANIFEST.completeMotionSchedules
            && records.length === caseDocument.conditions.length * caseDocument.editVariants.length;
        return normalizeVisualLabCandidate({
            kind: VISUAL_LAB_CANDIDATE_KIND,
            version: VISUAL_LAB_VERSION,
            id: definition.id,
            caseId: caseDocument.id,
            name: definition.name,
            description: `${definition.detail === "detailed" ? "Prepared detailed" : "Simple"} geometry with improved physical materials in the pinned Cycles reference.`,
            status: complete ? "complete" : "incomplete",
            attempt: 1,
            variables: { "asset-detail": definition.detail, "appearance-method": "physical-reference", "renderer-revision": "cycles@4.5.4", "controlled-correction": "none" },
            scene: {
                fixtureId: caseDocument.scene.fixtureId,
                detail: definition.detail,
                materialProfile: "physical",
                frozen: true,
                artifactHash: glb?.sha256,
                fixtureArtifactHash: visualLabDocumentHash(caseDocument.scene),
            },
            outputs,
            limitations: complete ? [] : ["The pinned still/reference subset is retained; the complete edit and 24 fps path matrix remains to be rendered."],
        });
    });
}

export function defaultVisualLabReview(caseDocument, candidates) {
    const first = candidates[0];
    const second = candidates[1] ?? candidates[0];
    return normalizeVisualLabReview({
        kind: VISUAL_LAB_REVIEW_KIND,
        version: VISUAL_LAB_VERSION,
        id: `${caseDocument.id}-review`,
        caseId: caseDocument.id,
        name: `${caseDocument.name} review`,
        comparison: {
            a: { candidateId: first.id, outputId: first.outputs[0].id, viewpointId: caseDocument.viewpoints[0].id, pathId: null, sampleIndex: 0 },
            b: { candidateId: second.id, outputId: second.outputs[0].id, viewpointId: caseDocument.viewpoints[0].id, pathId: null, sampleIndex: 0 },
            mode: "wipe",
        },
        closeups: [],
        defects: [],
        arrangement: { revision: 0, transforms: [] },
        disposition: "reviewing",
    });
}

export function findVisualLabSample(candidate, target) {
    const output = candidate?.outputs?.find((entry) => entry.id === target?.outputId) ?? null;
    if (!output) return { output: null, sample: null };
    const sample = output.samples.find((entry) => (
        entry.sampleIndex === target.sampleIndex
        && entry.viewpointId === (target.viewpointId ?? null)
        && entry.pathId === (target.pathId ?? null)
    )) ?? null;
    return { output, sample };
}

export function compareVisualLabTargets(caseDocument, candidateA, targetA, candidateB, targetB) {
    const left = findVisualLabSample(candidateA, targetA);
    const right = findVisualLabSample(candidateB, targetB);
    const differences = [];
    if (!left.output || !left.sample || !right.output || !right.sample) {
        return { matched: false, differences: ["media-sample-missing"] };
    }
    for (const [label, a, b] of [
        ["case", candidateA.caseId, candidateB.caseId],
        ["calibration", left.output.calibrationId, right.output.calibrationId],
        ["condition", left.output.conditionId, right.output.conditionId],
        ["edit-variant", left.output.editVariantId, right.output.editVariantId],
        ["viewpoint", left.sample.viewpointId, right.sample.viewpointId],
        ["path", left.sample.pathId, right.sample.pathId],
        ["sample-index", left.sample.sampleIndex, right.sample.sampleIndex],
        ["capture-time", left.sample.captureTimeNs, right.sample.captureTimeNs],
    ]) {
        if (a !== b) differences.push(label);
    }
    const variableDefinitions = new Map(
        caseDocument?.comparisonVariables?.map((entry) => [entry.id, entry]) ?? [],
    );
    const declaredVariables = new Set(variableDefinitions.keys());
    const declaredDifferences = [];
    const allowedMatchFields = new Set();
    for (const key of new Set([...Object.keys(candidateA.variables ?? {}), ...Object.keys(candidateB.variables ?? {})])) {
        if (candidateA.variables?.[key] !== candidateB.variables?.[key] && !declaredVariables.has(key)) {
            differences.push(`undeclared-variable:${key}`);
        } else if (candidateA.variables?.[key] !== candidateB.variables?.[key]) {
            declaredDifferences.push(key);
            for (const field of variableDefinitions.get(key)?.affects ?? []) allowedMatchFields.add(field);
        }
    }
    const metadataA = left.output.provenance?.match ?? null;
    const metadataB = right.output.provenance?.match ?? null;
    if (metadataA || metadataB) {
        if (!metadataA || !metadataB) differences.push("match-metadata-missing");
        else {
            for (const field of new Set([...Object.keys(metadataA), ...Object.keys(metadataB)])) {
                if (canonicalExactStringify(metadataA[field]) !== canonicalExactStringify(metadataB[field])
                    && !allowedMatchFields.has(field)) {
                    differences.push(`metadata:${field}`);
                }
            }
        }
    }
    return {
        matched: differences.length === 0,
        differences,
        declaredDifferences: declaredDifferences.sort(),
    };
}

export function assertVisualLabCandidateMatchesCase(caseDocument, candidateDocument) {
    const caseValue = normalizeVisualLabCase(caseDocument);
    const candidate = normalizeVisualLabCandidate(candidateDocument);
    if (candidate.caseId !== caseValue.id) {
        fail("visualLabCandidate.caseId", `expected ${JSON.stringify(caseValue.id)}`);
    }
    const calibrationIds = new Set(caseValue.calibrations.map((entry) => entry.id));
    const conditionIds = new Set(caseValue.conditions.map((entry) => entry.id));
    const editVariantIds = new Set(caseValue.editVariants.map((entry) => entry.id));
    const viewpoints = new Map(caseValue.viewpoints.map((entry) => [entry.id, entry]));
    const paths = new Map(caseValue.paths.map((entry) => [entry.id, entry]));
    for (const output of candidate.outputs) {
        if (!calibrationIds.has(output.calibrationId)) {
            fail(`visualLabCandidate.outputs.${output.id}.calibrationId`, "is not declared by the case");
        }
        if (!conditionIds.has(output.conditionId)) {
            fail(`visualLabCandidate.outputs.${output.id}.conditionId`, "is not declared by the case");
        }
        if (!editVariantIds.has(output.editVariantId)) {
            fail(`visualLabCandidate.outputs.${output.id}.editVariantId`, "is not declared by the case");
        }
        for (const sample of output.samples) {
            if (sample.viewpointId) {
                if (!viewpoints.has(sample.viewpointId) || sample.sampleIndex !== 0 || sample.captureTimeNs !== 0) {
                    fail(`visualLabCandidate.outputs.${output.id}.samples`, "contains an undeclared still sample");
                }
                continue;
            }
            const expected = paths.get(sample.pathId)?.samples?.[sample.sampleIndex];
            if (!expected || expected.captureTimeNs !== sample.captureTimeNs) {
                fail(`visualLabCandidate.outputs.${output.id}.samples`, "does not match the frozen path schedule");
            }
        }
    }
    return candidate;
}

export function assertVisualLabReviewMatchesCase({ caseDocument, candidates, review }) {
    const caseValue = normalizeVisualLabCase(caseDocument);
    const candidateValues = candidates.map((entry) => assertVisualLabCandidateMatchesCase(caseValue, entry));
    const reviewValue = normalizeVisualLabReview(review);
    if (reviewValue.caseId !== caseValue.id) {
        fail("visualLabReview.caseId", `expected ${JSON.stringify(caseValue.id)}`);
    }
    const candidateById = new Map(candidateValues.map((entry) => [entry.id, entry]));
    const targets = [
        reviewValue.comparison.a,
        reviewValue.comparison.b,
        ...reviewValue.closeups.map((entry) => entry.target),
        ...reviewValue.defects.map((entry) => entry.target),
    ];
    for (const target of targets) {
        const candidate = candidateById.get(target.candidateId);
        if (!candidate || !findVisualLabSample(candidate, target).sample) {
            fail("visualLabReview.target", "references media that is not registered for this case");
        }
    }
    const objectIds = new Set(caseValue.scene?.objects?.map((entry) => entry.id) ?? []);
    for (const defect of reviewValue.defects) {
        if (defect.objectId && !objectIds.has(defect.objectId)) {
            fail(`visualLabReview.defects.${defect.id}.objectId`, "is not part of the frozen scene");
        }
    }
    return reviewValue;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function reportTarget(candidate, target) {
    const { output, sample } = findVisualLabSample(candidate, target);
    if (!output || !sample) return "<div class=\"missing\">Media missing</div>";
    const source = sample.media.url || `/api/storage/visual-assets/uses/sha256/${sample.media.useHash}/content`;
    return `<figure><div class="stage">${escapeHtml(VISUAL_LAB_STAGE_LABELS[output.stage])}</div><img src="${escapeHtml(source)}" alt="${escapeHtml(output.name)}"><figcaption>${escapeHtml(candidate.name)} · ${escapeHtml(output.rendererId)}</figcaption></figure>`;
}

export function createVisualLabHtmlReport({ caseDocument, candidates, review, comparison }) {
    const candidateById = new Map(candidates.map((entry) => [entry.id, entry]));
    const defects = review.defects.map((defect) => `<tr><td>${escapeHtml(defect.severity)}</td><td>${escapeHtml(defect.category)}</td><td>${escapeHtml(defect.status)}</td><td>${escapeHtml(defect.text)}</td></tr>`).join("");
    const closeups = review.closeups.map((closeup) => `<li>${escapeHtml(closeup.name)}: x ${closeup.rectangle.x.toFixed(3)}, y ${closeup.rectangle.y.toFixed(3)}, w ${closeup.rectangle.width.toFixed(3)}, h ${closeup.rectangle.height.toFixed(3)}</li>`).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(review.name)}</title><style>body{margin:0;padding:32px;background:#111417;color:#e8edf2;font:14px/1.5 system-ui,sans-serif}h1{font-size:24px}h2{font-size:15px;margin-top:32px}.meta{color:#9da8b3}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}figure{margin:0;background:#171b20;border:1px solid #303740;padding:10px}img{display:block;width:100%;background:#0a0c0e}.stage{display:inline-block;margin-bottom:8px;padding:3px 6px;background:#f2a93b;color:#18130a;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}figcaption{margin-top:8px;color:#aeb8c2}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #303740;padding:8px}.missing{padding:40px;background:#171b20;color:#f0a15c}</style></head><body><h1>${escapeHtml(review.name)}</h1><p class="meta">Case ${escapeHtml(caseDocument.id)} · ${comparison.matched ? "Matched comparison" : `Unmatched: ${escapeHtml(comparison.differences.join(", "))}`}</p><div class="comparison">${reportTarget(candidateById.get(review.comparison.a.candidateId), review.comparison.a)}${reportTarget(candidateById.get(review.comparison.b.candidateId), review.comparison.b)}</div><h2>Close-ups</h2><ul>${closeups || "<li>None recorded</li>"}</ul><h2>Defect notes</h2><table><thead><tr><th>Severity</th><th>Category</th><th>Status</th><th>Note</th></tr></thead><tbody>${defects || "<tr><td colspan=\"4\">No defect notes</td></tr>"}</tbody></table></body></html>`;
}

export function createVisualLabReviewPack({ caseDocument, candidates, review }) {
    const normalizedCase = normalizeVisualLabCase(caseDocument);
    const normalizedCandidates = candidates.map(normalizeVisualLabCandidate);
    const normalizedReview = normalizeVisualLabReview(review);
    const media = normalizedCandidates.flatMap((candidate) => candidate.outputs.flatMap((output) => output.samples.map((sample) => ({
        candidateId: candidate.id,
        outputId: output.id,
        stage: output.stage,
        rendererId: output.rendererId,
        viewpointId: sample.viewpointId,
        pathId: sample.pathId,
        sampleIndex: sample.sampleIndex,
        captureTimeNs: sample.captureTimeNs,
        media: sample.media,
    }))));
    const comparison = compareVisualLabTargets(
        normalizedCase,
        normalizedCandidates.find((entry) => entry.id === normalizedReview.comparison.a.candidateId),
        normalizedReview.comparison.a,
        normalizedCandidates.find((entry) => entry.id === normalizedReview.comparison.b.candidateId),
        normalizedReview.comparison.b,
    );
    const pack = {
        kind: VISUAL_LAB_EXPORT_KIND,
        version: VISUAL_LAB_VERSION,
        exportedAt: new Date().toISOString(),
        case: normalizedCase,
        candidates: normalizedCandidates,
        review: normalizedReview,
        comparison,
        media,
    };
    pack.htmlReport = createVisualLabHtmlReport({
        caseDocument: normalizedCase,
        candidates: normalizedCandidates,
        review: normalizedReview,
        comparison,
    });
    return { ...pack, packHash: visualLabDocumentHash(pack) };
}
