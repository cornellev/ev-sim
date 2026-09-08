import {
    assertSha256Digest,
    canonicalExactStringify,
    normalizeVisualAssetReference,
    parseExactJson,
    sha256ExactBytes,
    sha256ExactUtf8,
} from "../simulation/visual/VisualLayer.js";
import { assertVisualCameraCalibration } from "../3d/environment/visual/VisualCapturePipeline.js";

export const VISUAL_EVALUATION_INPUT_KIND = "cev-sim.visual-evaluation-input";
export const VISUAL_EVALUATION_INPUT_VERSION = 1;
export const VISUAL_CORRESPONDENCE_REPORT_KIND = "cev-sim.visual-correspondence-report";
export const VISUAL_CORRESPONDENCE_REPORT_VERSION = 1;
export const VISUAL_THRESHOLD_PROFILE_KIND = "cev-sim.visual-threshold-profile";
export const VISUAL_THRESHOLD_PROFILE_VERSION = 1;

export const VISUAL_CORRESPONDENCE_METRICS = Object.freeze([
    "depth-residual",
    "instance-alignment",
    "joint-coverage",
    "photometric-difference",
    "semantic-alignment",
    "silhouette-reprojection",
]);

export const VISUAL_ADMISSION_MODES = Object.freeze({
    diagnostic: "diagnostic",
    managed: "managed",
});

export const VISUAL_ADMISSION_FAILURE_CODES = Object.freeze({
    INVALID_REQUEST: "VISUAL_EVIDENCE_INVALID_REQUEST",
    MALFORMED_REPORT: "VISUAL_EVIDENCE_MALFORMED_REPORT",
    REPORT_TAMPERED: "VISUAL_EVIDENCE_REPORT_TAMPERED",
    INPUT_MISMATCH: "VISUAL_EVIDENCE_INPUT_MISMATCH",
    UNTRUSTED_VALIDATOR: "VISUAL_EVIDENCE_UNTRUSTED_VALIDATOR",
    UNSUPPORTED_PROFILE: "VISUAL_EVIDENCE_UNSUPPORTED_PROFILE",
    INSUFFICIENT_COVERAGE: "VISUAL_EVIDENCE_INSUFFICIENT_COVERAGE",
    THRESHOLD_FAILED: "VISUAL_EVIDENCE_THRESHOLD_FAILED",
    ASSET_INVALID: "VISUAL_EVIDENCE_ASSET_INVALID",
    RIGHTS_DENIED: "VISUAL_EVIDENCE_RIGHTS_DENIED",
    CAPABILITY_UNAVAILABLE: "VISUAL_EVIDENCE_CAPABILITY_UNAVAILABLE",
});

const METRICS = new Set(VISUAL_CORRESPONDENCE_METRICS);
const OPERATORS = new Set(["max", "min"]);
const PROFILE_PURPOSES = new Set(["synthetic", "production"]);
const ARTIFACT_FAMILIES = new Set(["visual", "analytic"]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(path, message) {
    throw new TypeError(`${path}: ${message}`);
}

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
    return value;
}

function text(value, path) {
    if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
        fail(path, "expected a non-empty NFC string");
    }
    return value;
}

function digest(value, path) {
    try {
        return assertSha256Digest(value, path);
    } catch (error) {
        fail(path, error.message);
    }
}

function integer(value, path, { min = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < min) fail(path, `expected an integer >= ${min}`);
    return value;
}

function finite(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    return value;
}

function ratio(value, path) {
    const result = finite(value, path);
    if (result < 0 || result > 1) fail(path, "expected a ratio in [0, 1]");
    return result;
}

function boolean(value, path) {
    if (typeof value !== "boolean") fail(path, "expected a boolean");
    return value;
}

function array(value, path, { min = 0 } = {}) {
    if (!Array.isArray(value) || value.length < min) fail(path, `expected an array with at least ${min} entries`);
    return value;
}

function nullableDigest(value, path) {
    return value === null ? null : digest(value, path);
}

function profileRef(value, path) {
    const source = object(value, path);
    return {
        id: text(source.id, `${path}.id`),
        version: integer(source.version, `${path}.version`, { min: 1 }),
        configHash: digest(source.configHash, `${path}.configHash`),
    };
}

function sortedUnique(values, path, key) {
    const seen = new Set();
    let previous = null;
    for (const [index, value] of values.entries()) {
        const current = key(value);
        if (seen.has(current)) fail(`${path}.${index}`, `duplicate key ${current}`);
        if (previous !== null && compareUtf8(previous, current) >= 0) {
            fail(path, "entries must be in ascending UTF-8-compatible key order");
        }
        seen.add(current);
        previous = current;
    }
    return values;
}

function compareUtf8(left, right) {
    const leftBytes = textEncoder.encode(left);
    const rightBytes = textEncoder.encode(right);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
    }
    return leftBytes.length - rightBytes.length;
}

function exactAssert(value, normalize, label) {
    const normalized = normalize(value);
    if (canonicalExactStringify(value) !== canonicalExactStringify(normalized)) {
        fail(label, "missing defaults, unknown fields, or noncanonical ordering");
    }
    return normalized;
}

function bytes(value, path) {
    if (typeof value === "string") return textEncoder.encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    fail(path, "expected UTF-8 bytes or a string");
}

function parseBytes(value, path) {
    try {
        const encoded = bytes(value, path);
        const parsed = parseExactJson(textDecoder.decode(encoded));
        return { encoded, parsed };
    } catch (error) {
        fail(path, error.message);
    }
}

export function normalizeVisualEvaluationInput(value) {
    const source = object(value, "evaluationInput");
    const assets = array(source.assets, "evaluationInput.assets").map((entry, index) => {
        const record = object(entry, `evaluationInput.assets.${index}`);
        return {
            ...normalizeVisualAssetReference({
                sha256: record.sha256,
                mediaType: record.mediaType,
                sizeBytes: record.sizeBytes,
                role: record.role,
            }),
            useHash: digest(record.useHash, `evaluationInput.assets.${index}.useHash`),
        };
    });
    sortedUnique(assets, "evaluationInput.assets", (entry) => `${entry.sha256}:${entry.useHash}`);
    const cameras = array(source.cameras, "evaluationInput.cameras", { min: 1 }).map((entry, index) => {
        const record = object(entry, `evaluationInput.cameras.${index}`);
        let calibration;
        try {
            calibration = assertVisualCameraCalibration(record.calibration);
        } catch (error) {
            fail(`evaluationInput.cameras.${index}.calibration`, error.message);
        }
        const calibrationHash = digest(
            record.calibrationHash,
            `evaluationInput.cameras.${index}.calibrationHash`,
        );
        if (calibrationHash !== sha256ExactUtf8(canonicalExactStringify(calibration))) {
            fail(`evaluationInput.cameras.${index}.calibrationHash`, "does not match the exact calibration body");
        }
        return {
            id: text(record.id, `evaluationInput.cameras.${index}.id`),
            calibration,
            calibrationHash,
        };
    });
    sortedUnique(cameras, "evaluationInput.cameras", (entry) => entry.id);
    const samples = array(source.samples, "evaluationInput.samples", { min: 1 }).map((entry, index) => {
        const record = object(entry, `evaluationInput.samples.${index}`);
        const captureInputs = object(record.captureInputHashes, `evaluationInput.samples.${index}.captureInputHashes`);
        return {
            id: text(record.id, `evaluationInput.samples.${index}.id`),
            cameraId: text(record.cameraId, `evaluationInput.samples.${index}.cameraId`),
            captureTimeNs: integer(record.captureTimeNs, `evaluationInput.samples.${index}.captureTimeNs`),
            poseHash: digest(record.poseHash, `evaluationInput.samples.${index}.poseHash`),
            dynamicStateHash: nullableDigest(record.dynamicStateHash, `evaluationInput.samples.${index}.dynamicStateHash`),
            captureInputHashes: {
                visual: digest(captureInputs.visual, `evaluationInput.samples.${index}.captureInputHashes.visual`),
                analytic: digest(captureInputs.analytic, `evaluationInput.samples.${index}.captureInputHashes.analytic`),
            },
        };
    });
    const sampleIds = new Set();
    const cameraIds = new Set(cameras.map((entry) => entry.id));
    for (const [index, sample] of samples.entries()) {
        if (sampleIds.has(sample.id)) fail(`evaluationInput.samples.${index}.id`, "duplicate sample id");
        if (!cameraIds.has(sample.cameraId)) fail(`evaluationInput.samples.${index}.cameraId`, "unknown camera");
        sampleIds.add(sample.id);
    }
    const aoiSource = object(source.aoi, "evaluationInput.aoi");
    const regions = array(aoiSource.regions, "evaluationInput.aoi.regions", { min: 1 })
        .map((entry, index) => text(entry, `evaluationInput.aoi.regions.${index}`));
    sortedUnique(regions, "evaluationInput.aoi.regions", (entry) => entry);
    const policySource = object(source.policies, "evaluationInput.policies");
    const metrics = array(policySource.metrics, "evaluationInput.policies.metrics", { min: 1 })
        .map((entry, index) => profileRef(entry, `evaluationInput.policies.metrics.${index}`));
    for (const [index, metric] of metrics.entries()) {
        if (!METRICS.has(metric.id)) fail(`evaluationInput.policies.metrics.${index}.id`, "unsupported metric");
    }
    sortedUnique(metrics, "evaluationInput.policies.metrics", (entry) => `${entry.id}:${entry.version}`);
    const threshold = object(policySource.thresholdProfile, "evaluationInput.policies.thresholdProfile");
    return {
        kind: text(source.kind, "evaluationInput.kind"),
        version: integer(source.version, "evaluationInput.version", { min: 1 }),
        worldHash: digest(source.worldHash, "evaluationInput.worldHash"),
        visualLayerHash: digest(source.visualLayerHash, "evaluationInput.visualLayerHash"),
        renderSceneHash: digest(source.renderSceneHash, "evaluationInput.renderSceneHash"),
        provider: profileRef(source.provider, "evaluationInput.provider"),
        assets,
        assetClosureHash: digest(source.assetClosureHash, "evaluationInput.assetClosureHash"),
        cameras,
        calibrationBundleHash: digest(source.calibrationBundleHash, "evaluationInput.calibrationBundleHash"),
        captureRecipeHash: digest(source.captureRecipeHash, "evaluationInput.captureRecipeHash"),
        capturePolicy: profileRef(source.capturePolicy, "evaluationInput.capturePolicy"),
        samples,
        aoi: { hash: digest(aoiSource.hash, "evaluationInput.aoi.hash"), regions },
        seed: integer(source.seed, "evaluationInput.seed"),
        actionTapeHash: nullableDigest(source.actionTapeHash, "evaluationInput.actionTapeHash"),
        policies: {
            sampleSelection: profileRef(policySource.sampleSelection, "evaluationInput.policies.sampleSelection"),
            metrics,
            confidence: profileRef(policySource.confidence, "evaluationInput.policies.confidence"),
            aggregation: profileRef(policySource.aggregation, "evaluationInput.policies.aggregation"),
            thresholdProfile: {
                id: text(threshold.id, "evaluationInput.policies.thresholdProfile.id"),
                version: integer(threshold.version, "evaluationInput.policies.thresholdProfile.version", { min: 1 }),
                hash: digest(threshold.hash, "evaluationInput.policies.thresholdProfile.hash"),
            },
        },
    };
}

export function assertVisualEvaluationInput(value) {
    const normalized = exactAssert(value, normalizeVisualEvaluationInput, "evaluationInput");
    if (normalized.kind !== VISUAL_EVALUATION_INPUT_KIND || normalized.version !== VISUAL_EVALUATION_INPUT_VERSION) {
        fail("evaluationInput", "unsupported kind or version");
    }
    return normalized;
}

export function serializeVisualEvaluationInput(value) {
    return canonicalExactStringify(assertVisualEvaluationInput(value));
}

export function parseVisualEvaluationInput(value) {
    return assertVisualEvaluationInput(parseBytes(value, "evaluationInputBytes").parsed);
}

export function hashVisualEvaluationInput(value) {
    return sha256ExactUtf8(serializeVisualEvaluationInput(value));
}

export function normalizeVisualThresholdProfile(value) {
    const source = object(value, "thresholdProfile");
    const bands = array(source.distanceBands, "thresholdProfile.distanceBands", { min: 1 }).map((entry, index) => {
        const record = object(entry, `thresholdProfile.distanceBands.${index}`);
        const minMeters = finite(record.minMeters, `thresholdProfile.distanceBands.${index}.minMeters`);
        const maxMeters = finite(record.maxMeters, `thresholdProfile.distanceBands.${index}.maxMeters`);
        if (minMeters < 0 || maxMeters <= minMeters) fail(`thresholdProfile.distanceBands.${index}`, "invalid distance interval");
        return { id: text(record.id, `thresholdProfile.distanceBands.${index}.id`), minMeters, maxMeters };
    });
    sortedUnique(bands, "thresholdProfile.distanceBands", (entry) => entry.id);
    const bandsByDistance = [...bands].sort((left, right) => left.minMeters - right.minMeters);
    for (let index = 1; index < bandsByDistance.length; index += 1) {
        if (bandsByDistance[index].minMeters < bandsByDistance[index - 1].maxMeters) {
            fail("thresholdProfile.distanceBands", "distance intervals overlap");
        }
    }
    const metrics = array(source.metrics, "thresholdProfile.metrics", { min: 1 }).map((entry, index) => {
        const path = `thresholdProfile.metrics.${index}`;
        const record = object(entry, path);
        const id = text(record.id, `${path}.id`);
        if (!METRICS.has(id)) fail(`${path}.id`, "unsupported metric");
        const operator = text(record.operator, `${path}.operator`);
        if (!OPERATORS.has(operator)) fail(`${path}.operator`, "expected max or min");
        return {
            id,
            version: integer(record.version, `${path}.version`, { min: 1 }),
            operator,
            limit: finite(record.limit, `${path}.limit`),
            worstRegionLimit: finite(record.worstRegionLimit, `${path}.worstRegionLimit`),
        };
    });
    sortedUnique(metrics, "thresholdProfile.metrics", (entry) => `${entry.id}:${entry.version}`);
    const regions = array(source.requiredRegions, "thresholdProfile.requiredRegions", { min: 1 })
        .map((entry, index) => text(entry, `thresholdProfile.requiredRegions.${index}`));
    sortedUnique(regions, "thresholdProfile.requiredRegions", (entry) => entry);
    const requirements = object(source.requirements, "thresholdProfile.requirements");
    const purpose = text(source.purpose, "thresholdProfile.purpose");
    if (!PROFILE_PURPOSES.has(purpose)) fail("thresholdProfile.purpose", "unsupported purpose");
    return {
        kind: text(source.kind, "thresholdProfile.kind"),
        version: integer(source.version, "thresholdProfile.version", { min: 1 }),
        id: text(source.id, "thresholdProfile.id"),
        purpose,
        distanceBands: bands,
        requiredRegions: regions,
        requirements: {
            minimumExpectedSamples: integer(requirements.minimumExpectedSamples, "thresholdProfile.requirements.minimumExpectedSamples", { min: 1 }),
            minimumJointValidSamples: integer(requirements.minimumJointValidSamples, "thresholdProfile.requirements.minimumJointValidSamples", { min: 1 }),
            minimumCoverageRatio: ratio(requirements.minimumCoverageRatio, "thresholdProfile.requirements.minimumCoverageRatio"),
            maximumMissingRatio: ratio(requirements.maximumMissingRatio, "thresholdProfile.requirements.maximumMissingRatio"),
            maximumLowConfidenceRatio: ratio(requirements.maximumLowConfidenceRatio, "thresholdProfile.requirements.maximumLowConfidenceRatio"),
        },
        metrics,
    };
}

export function assertVisualThresholdProfile(value) {
    const normalized = exactAssert(value, normalizeVisualThresholdProfile, "thresholdProfile");
    if (normalized.kind !== VISUAL_THRESHOLD_PROFILE_KIND || normalized.version !== VISUAL_THRESHOLD_PROFILE_VERSION) {
        fail("thresholdProfile", "unsupported kind or version");
    }
    return normalized;
}

export function serializeVisualThresholdProfile(value) {
    return canonicalExactStringify(assertVisualThresholdProfile(value));
}

export function parseVisualThresholdProfile(value) {
    return assertVisualThresholdProfile(parseBytes(value, "thresholdProfileBytes").parsed);
}

export function hashVisualThresholdProfile(value) {
    return sha256ExactUtf8(serializeVisualThresholdProfile(value));
}

function normalizeMetricCell(value, path) {
    const source = object(value, path);
    const expectedSamples = integer(source.expectedSamples, `${path}.expectedSamples`, { min: 1 });
    const jointValidSamples = integer(source.jointValidSamples, `${path}.jointValidSamples`);
    const missingVisualSamples = integer(source.missingVisualSamples, `${path}.missingVisualSamples`);
    const missingAnalyticSamples = integer(source.missingAnalyticSamples, `${path}.missingAnalyticSamples`);
    const lowConfidenceSamples = integer(source.lowConfidenceSamples, `${path}.lowConfidenceSamples`);
    for (const [name, count] of Object.entries({
        jointValidSamples, missingVisualSamples, missingAnalyticSamples, lowConfidenceSamples,
    })) {
        if (count > expectedSamples) fail(`${path}.${name}`, "count exceeds expectedSamples");
    }
    if (jointValidSamples + missingVisualSamples > expectedSamples
        || jointValidSamples + missingAnalyticSamples > expectedSamples) {
        fail(path, "joint-valid and missing-hit counts exceed expectedSamples");
    }
    if (lowConfidenceSamples > jointValidSamples) {
        fail(`${path}.lowConfidenceSamples`, "count exceeds jointValidSamples");
    }
    const coverageRatio = ratio(source.coverageRatio, `${path}.coverageRatio`);
    if (Math.abs(coverageRatio - jointValidSamples / expectedSamples) > 1e-12) {
        fail(`${path}.coverageRatio`, "does not equal jointValidSamples / expectedSamples");
    }
    return {
        cameraId: text(source.cameraId, `${path}.cameraId`),
        regionId: text(source.regionId, `${path}.regionId`),
        distanceBandId: text(source.distanceBandId, `${path}.distanceBandId`),
        expectedSamples,
        jointValidSamples,
        missingVisualSamples,
        missingAnalyticSamples,
        lowConfidenceSamples,
        coverageRatio,
        value: finite(source.value, `${path}.value`),
        worstValue: finite(source.worstValue, `${path}.worstValue`),
    };
}

export function normalizeVisualCorrespondenceReport(value) {
    const source = object(value, "report");
    const threshold = object(source.thresholdProfile, "report.thresholdProfile");
    const validator = object(source.validator, "report.validator");
    const provenance = object(source.provenance, "report.provenance");
    const gpu = object(provenance.gpu, "report.provenance.gpu");
    const artifacts = array(source.artifacts, "report.artifacts", { min: 1 }).map((entry, index) => {
        const path = `report.artifacts.${index}`;
        const record = object(entry, path);
        const family = text(record.family, `${path}.family`);
        if (!ARTIFACT_FAMILIES.has(family)) fail(`${path}.family`, "unsupported capture family");
        return {
            sampleId: text(record.sampleId, `${path}.sampleId`),
            cameraId: text(record.cameraId, `${path}.cameraId`),
            family,
            product: text(record.product, `${path}.product`),
            inputHash: digest(record.inputHash, `${path}.inputHash`),
            outputHash: digest(record.outputHash, `${path}.outputHash`),
            sizeBytes: integer(record.sizeBytes, `${path}.sizeBytes`, { min: 1 }),
        };
    });
    sortedUnique(artifacts, "report.artifacts", (entry) => `${entry.sampleId}:${entry.family}:${entry.product}`);
    const metrics = array(source.metrics, "report.metrics", { min: 1 }).map((entry, index) => {
        const path = `report.metrics.${index}`;
        const record = object(entry, path);
        const id = text(record.id, `${path}.id`);
        if (!METRICS.has(id)) fail(`${path}.id`, "unsupported metric");
        const cells = array(record.cells, `${path}.cells`, { min: 1 })
            .map((cell, cellIndex) => normalizeMetricCell(cell, `${path}.cells.${cellIndex}`));
        sortedUnique(cells, `${path}.cells`, (cell) => `${cell.cameraId}:${cell.regionId}:${cell.distanceBandId}`);
        return { id, version: integer(record.version, `${path}.version`, { min: 1 }), cells };
    });
    sortedUnique(metrics, "report.metrics", (entry) => `${entry.id}:${entry.version}`);
    const decoders = array(provenance.decoders, "report.provenance.decoders", { min: 1 })
        .map((entry, index) => profileRef(entry, `report.provenance.decoders.${index}`));
    sortedUnique(decoders, "report.provenance.decoders", (entry) => `${entry.id}:${entry.version}`);
    return {
        kind: text(source.kind, "report.kind"),
        version: integer(source.version, "report.version", { min: 1 }),
        evaluationInputHash: digest(source.evaluationInputHash, "report.evaluationInputHash"),
        thresholdProfile: {
            id: text(threshold.id, "report.thresholdProfile.id"),
            version: integer(threshold.version, "report.thresholdProfile.version", { min: 1 }),
            hash: digest(threshold.hash, "report.thresholdProfile.hash"),
        },
        validator: {
            id: text(validator.id, "report.validator.id"),
            version: text(validator.version, "report.validator.version"),
            buildHash: digest(validator.buildHash, "report.validator.buildHash"),
        },
        artifacts,
        metrics,
        declaredPassed: boolean(source.declaredPassed, "report.declaredPassed"),
        provenance: {
            runtime: profileRef(provenance.runtime, "report.provenance.runtime"),
            gpu: {
                vendor: text(gpu.vendor, "report.provenance.gpu.vendor"),
                renderer: text(gpu.renderer, "report.provenance.gpu.renderer"),
                driver: text(gpu.driver, "report.provenance.gpu.driver"),
            },
            decoders,
        },
    };
}

export function assertVisualCorrespondenceReport(value) {
    const normalized = exactAssert(value, normalizeVisualCorrespondenceReport, "report");
    if (normalized.kind !== VISUAL_CORRESPONDENCE_REPORT_KIND
        || normalized.version !== VISUAL_CORRESPONDENCE_REPORT_VERSION) {
        fail("report", "unsupported kind or version");
    }
    return normalized;
}

export function serializeVisualCorrespondenceReport(value) {
    return canonicalExactStringify(assertVisualCorrespondenceReport(value));
}

export function parseVisualCorrespondenceReport(value) {
    return assertVisualCorrespondenceReport(parseBytes(value, "reportBytes").parsed);
}

export function hashVisualCorrespondenceReport(value) {
    return sha256ExactUtf8(serializeVisualCorrespondenceReport(value));
}

export function evaluateVisualCorrespondence({ report, evaluationInput, thresholdProfile }) {
    const checkedReport = assertVisualCorrespondenceReport(report);
    const checkedInput = assertVisualEvaluationInput(evaluationInput);
    const checkedProfile = assertVisualThresholdProfile(thresholdProfile);
    const failures = [];
    const inputHash = hashVisualEvaluationInput(checkedInput);
    const profileHash = hashVisualThresholdProfile(checkedProfile);
    if (checkedReport.evaluationInputHash !== inputHash) {
        failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH, path: "evaluationInputHash" });
    }
    if (checkedReport.thresholdProfile.id !== checkedProfile.id
        || checkedReport.thresholdProfile.version !== checkedProfile.version
        || checkedReport.thresholdProfile.hash !== profileHash) {
        failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.UNSUPPORTED_PROFILE, path: "thresholdProfile" });
    }
    if (checkedInput.policies.thresholdProfile.id !== checkedProfile.id
        || checkedInput.policies.thresholdProfile.version !== checkedProfile.version
        || checkedInput.policies.thresholdProfile.hash !== profileHash) {
        failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH, path: "policies.thresholdProfile" });
    }
    const sampleMap = new Map(checkedInput.samples.map((sample) => [sample.id, sample]));
    const artifactFamilies = new Map();
    for (const artifact of checkedReport.artifacts) {
        const sample = sampleMap.get(artifact.sampleId);
        if (!sample || sample.cameraId !== artifact.cameraId) {
            failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH, path: `artifacts.${artifact.sampleId}` });
            continue;
        }
        if (artifact.inputHash !== sample.captureInputHashes[artifact.family]) {
            failures.push({
                code: VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH,
                path: `artifacts.${artifact.sampleId}.${artifact.family}.inputHash`,
            });
        }
        const key = `${artifact.sampleId}:${artifact.family}`;
        artifactFamilies.set(key, true);
    }
    for (const sample of checkedInput.samples) {
        for (const family of ARTIFACT_FAMILIES) {
            if (!artifactFamilies.has(`${sample.id}:${family}`)) {
                failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INSUFFICIENT_COVERAGE, path: `artifacts.${sample.id}.${family}` });
            }
        }
    }
    const allowedRegions = new Set(checkedInput.aoi.regions);
    for (const region of checkedProfile.requiredRegions) {
        if (!allowedRegions.has(region)) {
            failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH, path: `requiredRegions.${region}` });
        }
    }
    const cameras = checkedInput.cameras.map((entry) => entry.id);
    const inputMetrics = new Set(checkedInput.policies.metrics.map((entry) => `${entry.id}:${entry.version}`));
    const profileMetrics = new Set(checkedProfile.metrics.map((entry) => `${entry.id}:${entry.version}`));
    if (inputMetrics.size !== profileMetrics.size
        || [...profileMetrics].some((metric) => !inputMetrics.has(metric))) {
        failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH, path: "policies.metrics" });
    }
    const reportsByMetric = new Map(checkedReport.metrics.map((entry) => [`${entry.id}:${entry.version}`, entry]));
    for (const rule of checkedProfile.metrics) {
        const metric = reportsByMetric.get(`${rule.id}:${rule.version}`);
        if (!metric) {
            failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INSUFFICIENT_COVERAGE, path: `metrics.${rule.id}` });
            continue;
        }
        const cells = new Map(metric.cells.map((cell) => [
            `${cell.cameraId}:${cell.regionId}:${cell.distanceBandId}`,
            cell,
        ]));
        for (const camera of cameras) {
            for (const region of checkedProfile.requiredRegions) {
                for (const band of checkedProfile.distanceBands) {
                    const key = `${camera}:${region}:${band.id}`;
                    const cell = cells.get(key);
                    if (!cell) {
                        failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INSUFFICIENT_COVERAGE, path: `metrics.${rule.id}.${key}` });
                        continue;
                    }
                    checkCell(cell, rule, checkedProfile.requirements, `metrics.${rule.id}.${key}`, failures);
                    cells.delete(key);
                }
            }
        }
        if (cells.size > 0) {
            failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH, path: `metrics.${rule.id}.extraCells` });
        }
    }
    const configuredMetrics = new Set(checkedProfile.metrics.map((entry) => `${entry.id}:${entry.version}`));
    if (checkedReport.metrics.some((entry) => !configuredMetrics.has(`${entry.id}:${entry.version}`))) {
        failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.UNSUPPORTED_PROFILE, path: "metrics.extra" });
    }
    return { ok: failures.length === 0, failures, inputHash, profileHash };
}

function checkCell(cell, rule, requirements, path, failures) {
    const missingRatio = Math.max(cell.missingVisualSamples, cell.missingAnalyticSamples) / cell.expectedSamples;
    const lowConfidenceRatio = cell.lowConfidenceSamples / cell.expectedSamples;
    if (cell.expectedSamples < requirements.minimumExpectedSamples
        || cell.jointValidSamples < requirements.minimumJointValidSamples
        || cell.coverageRatio < requirements.minimumCoverageRatio
        || missingRatio > requirements.maximumMissingRatio
        || lowConfidenceRatio > requirements.maximumLowConfidenceRatio) {
        failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.INSUFFICIENT_COVERAGE, path });
    }
    const passes = rule.operator === "max"
        ? cell.value <= rule.limit && cell.worstValue <= rule.worstRegionLimit
        : cell.value >= rule.limit && cell.worstValue >= rule.worstRegionLimit;
    if (!passes) failures.push({ code: VISUAL_ADMISSION_FAILURE_CODES.THRESHOLD_FAILED, path });
}

export async function checkVisualCorrespondenceAdmission({
    mode,
    reportBytes = null,
    reportSha256 = null,
    expectedInput,
    approvedProfiles = new Map(),
    trustedLocalValidations = new Map(),
    rightsDecision,
    assetDecision,
    capabilityDecision,
} = {}) {
    if (!Object.values(VISUAL_ADMISSION_MODES).includes(mode)) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.INVALID_REQUEST, "Unknown visual evidence admission mode.");
    }
    let input;
    try {
        input = assertVisualEvaluationInput(expectedInput);
    } catch (error) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.INVALID_REQUEST, error.message);
    }
    if (rightsDecision?.allowed !== true) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.RIGHTS_DENIED, "Current source rights deny visual evidence use.");
    }
    if (assetDecision?.valid !== true) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.ASSET_INVALID, "Current asset validation denies visual evidence use.");
    }
    if (capabilityDecision?.available !== true) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.CAPABILITY_UNAVAILABLE, "Required validation capability is unavailable.");
    }
    if (mode === VISUAL_ADMISSION_MODES.diagnostic && reportBytes == null) {
        return { ok: true, mode, managedEligible: false, evaluationInputHash: hashVisualEvaluationInput(input) };
    }
    let encoded;
    let report;
    try {
        const parsed = parseBytes(reportBytes, "reportBytes");
        encoded = parsed.encoded;
        report = assertVisualCorrespondenceReport(parsed.parsed);
    } catch (error) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.MALFORMED_REPORT, error.message);
    }
    const exactReportHash = sha256ExactBytes(encoded);
    if (reportSha256 !== exactReportHash) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.REPORT_TAMPERED, "Exact report bytes do not match the evidence digest.");
    }
    const profile = await lookup(approvedProfiles, report.thresholdProfile.hash);
    if (!profile) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.UNSUPPORTED_PROFILE, "Threshold profile is not approved.");
    }
    let evaluation;
    try {
        evaluation = evaluateVisualCorrespondence({ report, evaluationInput: input, thresholdProfile: profile });
    } catch (error) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.MALFORMED_REPORT, error.message);
    }
    if (!evaluation.ok) {
        const priority = evaluation.failures.find((failure) => failure.code === VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH)
            ?? evaluation.failures.find((failure) => failure.code === VISUAL_ADMISSION_FAILURE_CODES.UNSUPPORTED_PROFILE)
            ?? evaluation.failures.find((failure) => failure.code === VISUAL_ADMISSION_FAILURE_CODES.INSUFFICIENT_COVERAGE)
            ?? evaluation.failures[0];
        return { ...denied(priority.code, "Visual correspondence report is ineligible."), failures: evaluation.failures };
    }
    if (mode === VISUAL_ADMISSION_MODES.diagnostic) {
        return { ok: true, mode, managedEligible: false, reportHash: exactReportHash, ...evaluation };
    }
    if (profile.purpose !== "production") {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.UNSUPPORTED_PROFILE, "Synthetic threshold profiles cannot authorize managed execution.");
    }
    const trust = await lookup(trustedLocalValidations, exactReportHash);
    if (!trust
        || trust.locallyValidated !== true
        || trust.validatorEligible !== true
        || trust.reportHash !== exactReportHash
        || trust.evaluationInputHash !== evaluation.inputHash
        || trust.thresholdProfileHash !== evaluation.profileHash
        || trust.validatorId !== report.validator.id
        || trust.validatorVersion !== report.validator.version
        || trust.validatorBuildHash !== report.validator.buildHash) {
        return denied(VISUAL_ADMISSION_FAILURE_CODES.UNTRUSTED_VALIDATOR, "Report lacks matching trusted local validation.");
    }
    return { ok: true, mode, managedEligible: true, reportHash: exactReportHash, ...evaluation };
}

async function lookup(registry, key) {
    if (typeof registry === "function") return registry(key);
    if (registry instanceof Map) return registry.get(key);
    if (registry && typeof registry === "object") return registry[key];
    return null;
}

function denied(code, message) {
    return { ok: false, code, message, managedEligible: false };
}
