import {
    assertVisualLabCandidateMatchesCase,
    normalizeVisualLabCase,
    visualLabDocumentHash,
} from "./VisualLabDocuments.js";
import { createExperimentZeroScene } from "./ExperimentZeroScene.js";
import { createExperimentOneScene } from "./ExperimentOneScene.js";

/**
 * Narrow scene adapter for Visual Lab fixtures.
 *
 * Repository-owned visual-only fixtures are validated against the frozen case
 * and opened without inventing a world binding. Descriptor-backed candidates
 * continue through VisualLayerMaterializer with an actual world resource.
 */
export class VisualLabFixtureAdapter {
    constructor({ materializer = null } = {}) {
        this.materializer = materializer;
    }

    openBuiltIn({ caseDocument, candidate, arrangement = { transforms: [] } }) {
        const caseValue = normalizeVisualLabCase(caseDocument);
        const candidateValue = assertVisualLabCandidateMatchesCase(caseValue, candidate);
        if (!["experiment-0-room@1", "experiment-1-room@1"].includes(caseValue.scene.fixtureId)
            || candidateValue.scene.fixtureId !== caseValue.scene.fixtureId) {
            throw new Error("The retained candidate is not supported by the built-in room fixture adapter.");
        }
        const expectedArtifactHash = visualLabDocumentHash(caseValue.scene);
        if ((candidateValue.scene.fixtureArtifactHash ?? candidateValue.scene.artifactHash) !== expectedArtifactHash) {
            throw new Error("The retained candidate scene artifact does not match the frozen Visual Lab case.");
        }
        if (!["simple", "detailed"].includes(candidateValue.scene.detail)) {
            throw new Error(`Unsupported room detail level "${candidateValue.scene.detail}".`);
        }
        if (caseValue.scene.fixtureId === "experiment-1-room@1") {
            return createExperimentOneScene({
                detail: candidateValue.scene.detail,
                materialProfile: candidateValue.scene.materialProfile ?? "physical",
                transforms: arrangement.transforms ?? [],
            });
        }
        return createExperimentZeroScene({ detail: candidateValue.scene.detail, transforms: arrangement.transforms ?? [] });
    }

    async openVisualLayer({ caseDocument, candidate, reference, worldResource, assetUseHash = null }) {
        const caseValue = normalizeVisualLabCase(caseDocument);
        assertVisualLabCandidateMatchesCase(caseValue, candidate);
        if (!this.materializer) throw new Error("A VisualLayerMaterializer is required for descriptor-backed fixtures.");
        if (!worldResource?.hash || !worldResource?.description) {
            throw new Error("Descriptor-backed fixtures require a validated world resource and truth bindings.");
        }
        if (caseValue.sourceEnvironment.worldHash && caseValue.sourceEnvironment.worldHash !== worldResource.hash) {
            throw new Error("The fixture world resource does not match the frozen source environment hash.");
        }
        const status = await this.materializer.replace(reference, worldResource);
        if (status?.state === "error" || status?.status === "error") {
            throw new Error(status.error?.message || "Visual layer materialization failed.");
        }
        if (!assetUseHash) {
            return { root: this.materializer.previewRoot, release: () => this.materializer.clear() };
        }
        return this.materializer.materializeAssetUse(assetUseHash, {
            metadata: { visualLab: true, candidateId: candidate.id },
        });
    }
}
