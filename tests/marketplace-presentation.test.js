import assert from "node:assert/strict";
import test from "node:test";

import { MARKETPLACE_JOB_PHASES } from "../server/marketplace/client/MarketplaceInstallDocuments.js";
import { PUBLICATION_DRAFT_STATES } from "../server/marketplace/client/MarketplacePublicationDocuments.js";
import {
    displayKind,
    draftStateLabel,
    formatBytes,
    formatCompatibilityIssue,
    healthTone,
    installPhaseLabel,
    publicationRecoveryActions,
    publishPhaseLabel,
    releaseMatchesAdvisory,
    sortLabel,
    sourceHealthLabel,
} from "../app/marketplace/ui/presentation.js";

const PUBLISH_PHASES = [
    "queued", "build", "inspect", "awaiting-confirmation", "publish-artifacts", "publish-previews",
    "publish-items", "sign-releases", "publish-releases", "refresh", "needs-attention", "failed", "cancelled", "complete",
];

test("marketplace presentation names kinds, bytes, and sort modes", () => {
    assert.equal(displayKind("run-template"), "Run Template");
    assert.equal(displayKind(""), "");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KiB");
    assert.equal(formatBytes(Number.NaN), "—");
    assert.equal(sortLabel("version"), "Release version");
    assert.equal(sortLabel("name"), "Name");
});

test("marketplace presentation turns compatibility codes into sentences", () => {
    assert.equal(formatCompatibilityIssue({ code: "LIFECYCLE_UNAVAILABLE" }), "This content cannot be installed in this version.");
    assert.equal(formatCompatibilityIssue({ code: "CEV_SIM_VERSION", required: ">=1.2.0", actual: "1.0.0" }), "Requires cev-sim >=1.2.0. This host is 1.0.0.");
    assert.equal(formatCompatibilityIssue({ code: "PLATFORM", required: ["linux"], actual: "darwin" }), "Requires platform linux. This host is darwin.");
    assert.equal(formatCompatibilityIssue({ code: "ARCHITECTURE", required: ["x64"], actual: "arm64" }), "Requires architecture x64. This host is arm64.");
    assert.equal(formatCompatibilityIssue({ code: "RUNTIME", required: ["node"], actual: ["browser"] }), "Requires runtime node. This host has browser.");
    assert.equal(formatCompatibilityIssue({ code: "FEATURE", required: "webgpu" }), "Requires feature webgpu.");
    assert.equal(formatCompatibilityIssue({ code: "CONTRACT", required: { kind: "cev-sim.plugin-package", versions: [1] } }), "Requires contract cev-sim.plugin-package@1.");
    assert.equal(formatCompatibilityIssue({ code: "BACKEND", required: { kind: "render", id: "webgl", version: 1 } }), "Requires backend render:webgl@1.");
    assert.equal(formatCompatibilityIssue({ code: "ARTIFACT_LIMIT_EXCEEDED" }), "The release is larger than this host allows.");
    assert.equal(formatCompatibilityIssue({ code: "PUBLISHER_NOT_APPROVED" }), "The publisher is not approved on this host.");
    assert.equal(formatCompatibilityIssue({ code: "RELEASE_BLOCKED" }), "A security advisory blocks this release.");
    assert.equal(formatCompatibilityIssue({ code: "UNKNOWN" }), "This release is not eligible for this host.");
});

test("marketplace presentation labels every install phase, publish phase, and draft state", () => {
    assert.equal(installPhaseLabel("queued"), "Preparing");
    assert.equal(installPhaseLabel("download"), "Preparing");
    assert.equal(installPhaseLabel("plan"), "Preparing");
    assert.equal(installPhaseLabel("verify"), "Verifying");
    assert.equal(installPhaseLabel("awaiting-confirmation"), "Ready to install");
    assert.equal(installPhaseLabel("commit"), "Installing");
    assert.equal(installPhaseLabel("recover"), "Recovering");
    for (const phase of MARKETPLACE_JOB_PHASES) {
        const label = installPhaseLabel(phase);
        assert.equal(label.includes("-"), false, phase);
        assert.notEqual(label, phase);
    }
    assert.equal(publishPhaseLabel("awaiting-confirmation"), "Ready to publish");
    assert.equal(publishPhaseLabel("publish-artifacts"), "Publishing");
    for (const phase of PUBLISH_PHASES) {
        const label = publishPhaseLabel(phase);
        assert.equal(label.includes("-"), false, phase);
        assert.notEqual(label, phase);
    }
    assert.deepEqual(publicationRecoveryActions({ progress: { operationsComplete: 0, operationsTotal: 13 } }), {
        replan: true,
        resume: true,
        detail: null,
    });
    const partial = publicationRecoveryActions({ progress: { operationsComplete: 3, operationsTotal: 13 } });
    assert.equal(partial.replan, false);
    assert.equal(partial.resume, true);
    assert.match(partial.detail, /3 of 13 registry writes finished/u);
    assert.equal(publicationRecoveryActions(null).replan, true);
    assert.equal(draftStateLabel("incomplete"), "Draft");
    assert.equal(draftStateLabel("ready"), "Ready");
    for (const state of PUBLICATION_DRAFT_STATES) {
        const label = draftStateLabel(state);
        assert.equal(label.includes("-"), false, state);
    }
});

test("marketplace presentation reserves success for ready and complete states", () => {
    assert.equal(sourceHealthLabel("ready"), "Ready");
    assert.equal(sourceHealthLabel("offline"), "Offline");
    assert.equal(healthTone("ready"), "success");
    assert.equal(healthTone("complete"), "success");
    assert.equal(healthTone("stale"), "warning");
    assert.equal(healthTone("update"), "warning");
    assert.equal(healthTone("yanked"), "danger");
    assert.equal(healthTone("blocked"), "danger");
    assert.equal(healthTone("untrusted"), "danger");
    assert.equal(healthTone("custom"), "neutral");
});

test("marketplace presentation matches advisory subjects to an installed release", () => {
    const entry = {
        registryId: "registry-a",
        itemId: "com.example.pack",
        releaseVersion: "1.0.0",
        artifactSha256: "a".repeat(64),
        mappings: [{ hashes: { packageHash: "b".repeat(64) } }],
    };
    const record = (affected) => ({ registryId: "registry-a", advisory: { affected } });
    assert.equal(releaseMatchesAdvisory(entry, record([{ itemId: "com.example.pack", releaseVersion: "1.0.0" }])), true);
    assert.equal(releaseMatchesAdvisory(entry, record([{ itemId: "com.example.pack", releaseVersion: "2.0.0" }])), false);
    assert.equal(releaseMatchesAdvisory(entry, record([{ artifactSha256: "a".repeat(64) }])), true);
    assert.equal(releaseMatchesAdvisory(entry, record([{ packageHash: "b".repeat(64) }])), true);
    assert.equal(releaseMatchesAdvisory(entry, { ...record([{ itemId: "com.example.pack", releaseVersion: "1.0.0" }]), registryId: "other" }), false);
});
