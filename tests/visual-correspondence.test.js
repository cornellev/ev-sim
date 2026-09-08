import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    VISUAL_ADMISSION_FAILURE_CODES,
    VISUAL_ADMISSION_MODES,
    assertVisualCorrespondenceReport,
    assertVisualEvaluationInput,
    assertVisualThresholdProfile,
    checkVisualCorrespondenceAdmission,
    evaluateVisualCorrespondence,
    hashVisualEvaluationInput,
    hashVisualThresholdProfile,
    parseVisualCorrespondenceReport,
    parseVisualEvaluationInput,
    parseVisualThresholdProfile,
    serializeVisualCorrespondenceReport,
    serializeVisualEvaluationInput,
    serializeVisualThresholdProfile,
} from "../app/validation/VisualCorrespondence.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";

const fixture = JSON.parse(await readFile(
    new URL("./fixtures/visual-layer/correspondence.synthetic.v1.json", import.meta.url),
    "utf8",
));

function clone(value) {
    return structuredClone(value);
}

function productionCase() {
    const profile = clone(fixture.profile);
    profile.purpose = "production";
    const profileHash = hashVisualThresholdProfile(profile);
    const input = clone(fixture.input);
    input.policies.thresholdProfile.hash = profileHash;
    const inputHash = hashVisualEvaluationInput(input);
    const report = clone(fixture.report);
    report.thresholdProfile.hash = profileHash;
    report.evaluationInputHash = inputHash;
    return { profile, profileHash, input, inputHash, report };
}

test("VIS-16a contracts use strict exact JSON and committed synthetic vectors", () => {
    assertVisualThresholdProfile(fixture.profile);
    assertVisualEvaluationInput(fixture.input);
    assertVisualCorrespondenceReport(fixture.report);
    assert.equal(hashVisualThresholdProfile(fixture.profile), fixture.input.policies.thresholdProfile.hash);
    assert.equal(hashVisualEvaluationInput(fixture.input), fixture.report.evaluationInputHash);
    assert.deepEqual(parseVisualThresholdProfile(serializeVisualThresholdProfile(fixture.profile)), fixture.profile);
    assert.deepEqual(parseVisualEvaluationInput(serializeVisualEvaluationInput(fixture.input)), fixture.input);
    assert.deepEqual(parseVisualCorrespondenceReport(serializeVisualCorrespondenceReport(fixture.report)), fixture.report);
    assert.throws(
        () => parseVisualCorrespondenceReport('{"kind":"x","kind":"y"}'),
        /Duplicate JSON object key/,
    );
    assert.throws(() => assertVisualEvaluationInput({ ...fixture.input, reportHash: "f".repeat(64) }), /unknown fields/);
    assert.throws(() => assertVisualEvaluationInput({ ...fixture.input, resolvedHash: "f".repeat(64) }), /unknown fields/);
    assert.throws(() => assertVisualCorrespondenceReport({ ...fixture.report, locallyTrusted: true }), /unknown fields/);
    const changedCalibration = clone(fixture.input);
    changedCalibration.cameras[0].calibration.intrinsics.fx += 1;
    assert.throws(() => assertVisualEvaluationInput(changedCalibration), /does not match the exact calibration body/);
    const nonFinite = clone(fixture.report);
    nonFinite.metrics[0].cells[0].value = Number.NaN;
    assert.throws(() => assertVisualCorrespondenceReport(nonFinite), /finite number/);
    const impossibleCounts = clone(fixture.report);
    impossibleCounts.metrics[0].cells[0].missingVisualSamples = 2;
    assert.throws(() => assertVisualCorrespondenceReport(impossibleCounts), /counts exceed expectedSamples/);
    const utf8Ordered = clone(fixture.profile);
    utf8Ordered.requiredRegions = ["z", "ä"];
    assertVisualThresholdProfile(utf8Ordered);
    utf8Ordered.requiredRegions.reverse();
    assert.throws(() => assertVisualThresholdProfile(utf8Ordered), /UTF-8-compatible key order/);
});

test("synthetic threshold boundaries pass independently of declaredPassed", () => {
    const evaluated = evaluateVisualCorrespondence({
        report: fixture.report,
        evaluationInput: fixture.input,
        thresholdProfile: fixture.profile,
    });
    assert.equal(evaluated.ok, true);
    assert.equal(fixture.report.declaredPassed, false);

    const thresholdFailure = clone(fixture.report);
    thresholdFailure.metrics[0].cells[0].value += 0.0001;
    assert.equal(
        evaluateVisualCorrespondence({
            report: thresholdFailure,
            evaluationInput: fixture.input,
            thresholdProfile: fixture.profile,
        }).failures.some((entry) => entry.code === VISUAL_ADMISSION_FAILURE_CODES.THRESHOLD_FAILED),
        true,
    );

    const blank = clone(fixture.report);
    for (const metric of blank.metrics) {
        metric.cells[0].jointValidSamples = 0;
        metric.cells[0].missingVisualSamples = 10;
        metric.cells[0].missingAnalyticSamples = 10;
        metric.cells[0].lowConfidenceSamples = 0;
        metric.cells[0].coverageRatio = 0;
    }
    assert.equal(
        evaluateVisualCorrespondence({ report: blank, evaluationInput: fixture.input, thresholdProfile: fixture.profile })
            .failures.some((entry) => entry.code === VISUAL_ADMISSION_FAILURE_CODES.INSUFFICIENT_COVERAGE),
        true,
    );

    const lowConfidence = clone(fixture.report);
    for (const metric of lowConfidence.metrics) metric.cells[0].lowConfidenceSamples = 9;
    assert.equal(
        evaluateVisualCorrespondence({
            report: lowConfidence,
            evaluationInput: fixture.input,
            thresholdProfile: fixture.profile,
        }).failures.some((entry) => entry.code === VISUAL_ADMISSION_FAILURE_CODES.INSUFFICIENT_COVERAGE),
        true,
    );

    const profileWithOmittedRegion = clone(fixture.profile);
    profileWithOmittedRegion.requiredRegions = ["center", "edge"];
    const inputWithOmittedRegion = clone(fixture.input);
    inputWithOmittedRegion.aoi.regions = ["center", "edge"];
    inputWithOmittedRegion.policies.thresholdProfile.hash = hashVisualThresholdProfile(profileWithOmittedRegion);
    const reportWithOmittedRegion = clone(fixture.report);
    reportWithOmittedRegion.evaluationInputHash = hashVisualEvaluationInput(inputWithOmittedRegion);
    reportWithOmittedRegion.thresholdProfile.hash = inputWithOmittedRegion.policies.thresholdProfile.hash;
    assert.equal(
        evaluateVisualCorrespondence({
            report: reportWithOmittedRegion,
            evaluationInput: inputWithOmittedRegion,
            thresholdProfile: profileWithOmittedRegion,
        }).failures.some((entry) => entry.path.includes(":edge:")),
        true,
    );

    const omitted = clone(fixture.report);
    omitted.metrics[0].cells = [];
    assert.throws(() => assertVisualCorrespondenceReport(omitted), /at least 1/);
});

test("diagnostic admission is bounded and can create evidence without prior evidence", async () => {
    const admitted = await checkVisualCorrespondenceAdmission({
        mode: VISUAL_ADMISSION_MODES.diagnostic,
        expectedInput: fixture.input,
        rightsDecision: { allowed: true },
        assetDecision: { valid: true },
        capabilityDecision: { available: true },
    });
    assert.deepEqual(admitted, {
        ok: true,
        mode: "diagnostic",
        managedEligible: false,
        evaluationInputHash: fixture.report.evaluationInputHash,
    });
    const denied = await checkVisualCorrespondenceAdmission({
        mode: VISUAL_ADMISSION_MODES.diagnostic,
        expectedInput: fixture.input,
        rightsDecision: { allowed: false },
    });
    assert.equal(denied.code, VISUAL_ADMISSION_FAILURE_CODES.RIGHTS_DENIED);
    const invalidAsset = await checkVisualCorrespondenceAdmission({
        mode: VISUAL_ADMISSION_MODES.diagnostic,
        expectedInput: fixture.input,
        rightsDecision: { allowed: true },
        assetDecision: { valid: false },
    });
    assert.equal(invalidAsset.code, VISUAL_ADMISSION_FAILURE_CODES.ASSET_INVALID);
    const unavailableCapability = await checkVisualCorrespondenceAdmission({
        mode: VISUAL_ADMISSION_MODES.diagnostic,
        expectedInput: fixture.input,
        rightsDecision: { allowed: true },
        assetDecision: { valid: true },
    });
    assert.equal(unavailableCapability.code, VISUAL_ADMISSION_FAILURE_CODES.CAPABILITY_UNAVAILABLE);
});

test("managed admission requires exact bytes, an approved production profile, and local trust", async () => {
    const { profile, profileHash, input, inputHash, report } = productionCase();
    const reportBytes = new TextEncoder().encode(serializeVisualCorrespondenceReport(report));
    const reportHash = sha256ExactBytes(reportBytes);
    const profiles = new Map([[profileHash, profile]]);
    const trust = {
        locallyValidated: true,
        validatorEligible: true,
        reportHash,
        evaluationInputHash: inputHash,
        thresholdProfileHash: profileHash,
        validatorId: report.validator.id,
        validatorVersion: report.validator.version,
        validatorBuildHash: report.validator.buildHash,
    };
    const base = {
        mode: VISUAL_ADMISSION_MODES.managed,
        reportBytes,
        reportSha256: reportHash,
        expectedInput: input,
        approvedProfiles: profiles,
        rightsDecision: { allowed: true },
        assetDecision: { valid: true },
        capabilityDecision: { available: true },
    };
    const untrusted = await checkVisualCorrespondenceAdmission(base);
    assert.equal(untrusted.code, VISUAL_ADMISSION_FAILURE_CODES.UNTRUSTED_VALIDATOR);
    const ineligible = await checkVisualCorrespondenceAdmission({
        ...base,
        trustedLocalValidations: new Map([[reportHash, { ...trust, validatorEligible: false }]]),
    });
    assert.equal(ineligible.code, VISUAL_ADMISSION_FAILURE_CODES.UNTRUSTED_VALIDATOR);
    const admitted = await checkVisualCorrespondenceAdmission({
        ...base,
        trustedLocalValidations: new Map([[reportHash, trust]]),
    });
    assert.equal(admitted.ok, true);
    assert.equal(admitted.managedEligible, true);

    const importedClaim = clone(report);
    importedClaim.localValidation = trust;
    assert.throws(() => assertVisualCorrespondenceReport(importedClaim), /unknown fields/);

    const tamperedBytes = new TextEncoder().encode(`${serializeVisualCorrespondenceReport(report)} `);
    const tampered = await checkVisualCorrespondenceAdmission({ ...base, reportBytes: tamperedBytes });
    assert.equal(tampered.code, VISUAL_ADMISSION_FAILURE_CODES.REPORT_TAMPERED);
});

test("managed admission rejects synthetic profiles, mismatched inputs, and threshold failures", async () => {
    const reportBytes = new TextEncoder().encode(serializeVisualCorrespondenceReport(fixture.report));
    const reportHash = sha256ExactBytes(reportBytes);
    const synthetic = await checkVisualCorrespondenceAdmission({
        mode: VISUAL_ADMISSION_MODES.managed,
        reportBytes,
        reportSha256: reportHash,
        expectedInput: fixture.input,
        approvedProfiles: new Map([[hashVisualThresholdProfile(fixture.profile), fixture.profile]]),
        trustedLocalValidations: new Map(),
        rightsDecision: { allowed: true },
        assetDecision: { valid: true },
        capabilityDecision: { available: true },
    });
    assert.equal(synthetic.code, VISUAL_ADMISSION_FAILURE_CODES.UNSUPPORTED_PROFILE);

    const wrongInput = clone(fixture.input);
    wrongInput.seed += 1;
    const mismatched = await checkVisualCorrespondenceAdmission({
        mode: VISUAL_ADMISSION_MODES.diagnostic,
        reportBytes,
        reportSha256: reportHash,
        expectedInput: wrongInput,
        approvedProfiles: new Map([[hashVisualThresholdProfile(fixture.profile), fixture.profile]]),
        rightsDecision: { allowed: true },
        assetDecision: { valid: true },
        capabilityDecision: { available: true },
    });
    assert.equal(mismatched.code, VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH);

    const wrongArtifactInput = clone(fixture.report);
    wrongArtifactInput.artifacts[0].inputHash = "f".repeat(64);
    const wrongArtifactBytes = new TextEncoder().encode(serializeVisualCorrespondenceReport(wrongArtifactInput));
    const wrongArtifact = await checkVisualCorrespondenceAdmission({
        mode: VISUAL_ADMISSION_MODES.diagnostic,
        reportBytes: wrongArtifactBytes,
        reportSha256: sha256ExactBytes(wrongArtifactBytes),
        expectedInput: fixture.input,
        approvedProfiles: new Map([[hashVisualThresholdProfile(fixture.profile), fixture.profile]]),
        rightsDecision: { allowed: true },
        assetDecision: { valid: true },
        capabilityDecision: { available: true },
    });
    assert.equal(wrongArtifact.code, VISUAL_ADMISSION_FAILURE_CODES.INPUT_MISMATCH);
});

test("the VIS-16a contract module imports without DOM, Three.js, or renderer globals", async () => {
    const source = await readFile(new URL("../app/validation/VisualCorrespondence.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["']three["']/);
    assert.doesNotMatch(source, /\bwindow\b|\bdocument\b|WebGL|OffscreenCanvas/);
});
