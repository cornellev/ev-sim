import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
    VISUAL_ASSET_ACCESS_OPERATIONS,
    VISUAL_ASSET_UPLOAD_OPERATIONS,
    assertVisualLayer,
    assertVisualLayerAccess,
    assertVisualLayerAccessMatches,
    evaluateVisualSourcePolicy,
    hashVisualLayer,
    hashVisualLayerAccess,
} from "../../app/simulation/visual/VisualLayer.js";
import {
    hashBakeArtifactSet,
    normalizeBakeArtifactSet,
} from "../../app/3d/environment/visual/BakeArtifactWriter.js";
import {
    hashBakeReuseManifest,
    hashBakeReuseReport,
    isBakeReuseManifestV2,
    normalizeBakeReuseManifest,
    normalizeBakeReuseReport,
    reuseContributionUseHashes,
} from "../../app/3d/environment/visual/BakeReuseContracts.js";
import {
    hashBakeCapturePlan,
    hashBakeProviderRequest,
    hashBakeProviderResponse,
    hashBakeRunConfig,
    hashBakeSourceSnapshot,
    normalizeBakeCapturePlan,
    normalizeBakeProviderRequest,
    normalizeBakeProviderResponse,
    normalizeBakeRunConfig,
    normalizeBakeSourceSnapshot,
} from "../../app/3d/environment/visual/BakeRunCatalog.js";
import { serializeEnvironmentManifestV3 } from "../../app/3d/environment/EnvironmentManifestPolicy.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import {
    BAKE_PROMOTION_ERROR_CODES,
    ENVIRONMENT_REVISION_CONFLICT,
    environmentRevisionConflict,
    visualAssetError,
} from "./StorageErrors.js";

const STATE_KIND = "cev-sim.environment-bake-promotion-state";
const JOURNAL_KIND = "cev-sim.bake-promotion-journal";
const JOURNAL_PHASES = Object.freeze([
    "acquire-temp",
    "publish-revision",
    "replace-root",
    "replace-reuse-root",
    "release-temp",
    "receipt",
]);

export function parseBakeOutputSourceIds(value) {
    const source = Array.isArray(value)
        ? value
        : String(value ?? "").split(",");
    return [...new Set(source.map((entry) => String(entry).trim()).filter(Boolean))].sort();
}

export function durableVisualRootOwner(environmentId) {
    return `environment:${environmentId}:visual`;
}

export function durableBakeReuseRootOwner(environmentId) {
    return `environment:${environmentId}:bake-reuse`;
}

export function bakeOutputRootOwner(environmentId, generation) {
    return `environment:${environmentId}:bake:${generation}:outputs`;
}

function bakeError(code, message, extra = {}) {
    return visualAssetError(code, message, extra);
}

function sameStringSets(left = [], right = []) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function sha256Bytes(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

export class BakePromotionController {
    constructor(service) {
        this.service = service;
        this.dir = path.join(service.dataDir, "environment-bake-promotions");
        this.journalDir = path.join(service.dataDir, "environment-bake-journals");
        this._staleReconciled = new Set();
    }

    outputSourceIds() {
        return parseBakeOutputSourceIds(this.service.bakeOutputSourceIds);
    }

    statePath(environmentId) {
        return path.join(this.dir, `${environmentId}.json`);
    }

    journalPath(environmentId, generation) {
        return path.join(this.journalDir, `${environmentId}--${generation}.json`);
    }

    async readState(environmentId) {
        try {
            return JSON.parse(await fs.readFile(this.statePath(environmentId), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") {
                return {
                    kind: STATE_KIND,
                    version: 1,
                    environmentId,
                    active: null,
                    receipts: {},
                    nextGeneration: 1,
                };
            }
            throw error;
        }
    }

    async writeState(state) {
        await this.service._writeJsonFile(this.statePath(state.environmentId), state);
        return state;
    }

    async begin(environmentId, { expectedRevision } = {}) {
        return this.service._withEnvironmentWrite(environmentId, async () => {
            await this.recover(environmentId);
            const current = await this.service._readEnvironment(environmentId);
            if (!current) throw bakeError(BAKE_PROMOTION_ERROR_CODES.NOT_FOUND, `Environment ${environmentId} was not found.`);
            if (!Number.isInteger(expectedRevision) || expectedRevision !== (current.revision ?? 0)) {
                throw environmentRevisionConflict(expectedRevision, current.revision ?? 0);
            }
            const outputSourceIds = this.outputSourceIds();
            if (!outputSourceIds.length) {
                throw bakeError(
                    BAKE_PROMOTION_ERROR_CODES.OUTPUT_SOURCE_MISSING,
                    "CEV_SIM_BAKE_OUTPUT_SOURCE_IDS must list trusted generated-output source IDs.",
                );
            }
            await this._assertOutputSourceGrants(outputSourceIds);
            const world = createWorldResource(current);
            const state = await this.readState(environmentId);
            if (state.active) await this._cancelActive(environmentId, state, { invalidate: true });
            const generation = state.nextGeneration;
            const sourceUseHashes = await this._currentUseHashes(current);
            const reuseCandidate = await this._readReuseCandidate(current, state);
            const pinnedHashes = [...new Set([
                ...sourceUseHashes,
                ...reuseContributionUseHashes(reuseCandidate?.manifest),
            ])].sort();
            const pin = await this.service.visualAssets.acquirePin({
                ownerId: `environment:${environmentId}:bake-input`,
                useHashes: pinnedHashes,
                operations: [...VISUAL_ASSET_ACCESS_OPERATIONS],
            });
            state.active = {
                generation,
                expectedRevision: current.revision ?? 0,
                worldHash: world.hash,
                visualDescriptorHash: current.visualLayer?.descriptorHash ?? null,
                visualAccessHash: current.visualLayer?.accessHash ?? null,
                bakeReuseManifestHash: current.visualLayer?.bakeReuseManifestHash
                    ?? reuseCandidate?.bakeReuseManifestHash
                    ?? null,
                sourceUseHashes,
                outputSourceIds,
                pinHandle: pin.handle,
            };
            state.nextGeneration = generation + 1;
            await this.writeState(state);
            return {
                environmentId,
                generation,
                expectedRevision: current.revision ?? 0,
                environmentRevision: current.revision ?? 0,
                worldHash: world.hash,
                visualDescriptorHash: current.visualLayer?.descriptorHash ?? null,
                visualAccessHash: current.visualLayer?.accessHash ?? null,
                bakeReuseManifestHash: current.visualLayer?.bakeReuseManifestHash ?? reuseCandidate?.bakeReuseManifestHash ?? null,
                sourceUseHashes,
                outputSourceIds,
                reuseCandidate,
            };
        });
    }

    async commit(environmentId, generation, body = {}) {
        return this.service._withEnvironmentWrite(environmentId, async () => {
            await this.recover(environmentId);
            const state = await this.readState(environmentId);
            const existing = state.receipts?.[String(generation)];
            if (existing) return existing;
            if (!state.active || state.active.generation !== generation) {
                throw bakeError(
                    BAKE_PROMOTION_ERROR_CODES.STALE,
                    `Bake generation ${generation} is not the reserved generation.`,
                );
            }
            const current = await this.service._readEnvironment(environmentId);
            if (!current) throw bakeError(BAKE_PROMOTION_ERROR_CODES.NOT_FOUND, `Environment ${environmentId} was not found.`);
            if ((current.revision ?? 0) !== state.active.expectedRevision) {
                throw environmentRevisionConflict(state.active.expectedRevision, current.revision ?? 0);
            }
            const world = createWorldResource(current);
            if (world.hash !== state.active.worldHash) {
                throw bakeError(BAKE_PROMOTION_ERROR_CODES.BINDING_MISMATCH, "World hash changed during the bake.");
            }
            if (body.mode === "noop") {
                return this._commitNoop(environmentId, generation, body, state, current, world);
            }
            const documents = this._assertDocuments(body, state.active, world.hash, environmentId);
            await this._assertOutputSourceGrants(state.active.outputSourceIds);
            await this._assertGeneratedOutputs(documents.artifactSet, state.active.outputSourceIds);
            await this._assertClosure(documents.descriptor, documents.access, documents.artifactSet);
            const reuse = await this._storeReuseDocuments(body, documents);
            await this._assertReuseContributions(reuse.manifest);
            const visualUseHashes = [...new Set(documents.access.assets.map((entry) => entry.useHash))].sort();
            const reuseUseHashes = reuseContributionUseHashes(reuse.manifest);
            const newUseHashes = [...new Set([...visualUseHashes, ...reuseUseHashes])].sort();
            const storedDescriptorHash = await this.service._visualLayerDescriptors.put(documents.descriptor);
            const storedAccessHash = await this.service._visualLayerAccess.put(documents.access);
            if (storedDescriptorHash !== documents.descriptorHash || storedAccessHash !== documents.accessHash) {
                throw bakeError(BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH, "Stored descriptor/access hashes do not match.");
            }
            const nextRevision = (current.revision ?? 0) + 1;
            const visualLayer = {
                descriptorHash: storedDescriptorHash,
                accessHash: storedAccessHash,
                ...(reuse.manifestHash ? { bakeReuseManifestHash: reuse.manifestHash } : {}),
            };
            const nextManifest = serializeEnvironmentManifestV3({
                ...current,
                visualLayer,
                evidence: null,
            }, {
                environmentId,
                revision: nextRevision,
                current,
            });
            await this.service._assertVisualReference(nextManifest);
            const tempOwnerId = bakeOutputRootOwner(environmentId, generation);
            const durableOwnerId = durableVisualRootOwner(environmentId);
            const reuseOwnerId = isBakeReuseManifestV2(reuse.manifest)
                ? durableBakeReuseRootOwner(environmentId)
                : null;
            const receipt = {
                environmentId,
                generation,
                revision: nextRevision,
                worldHash: world.hash,
                descriptorHash: storedDescriptorHash,
                accessHash: storedAccessHash,
                artifactHash: documents.artifactHash,
                bakeReuseManifestHash: reuse.manifestHash,
                reuseReportHash: reuse.reportHash,
                mode: "promote",
                visualLayer,
                manifest: nextManifest,
            };
            const journal = {
                kind: JOURNAL_KIND,
                version: 1,
                environmentId,
                generation,
                phase: "acquire-temp",
                tempOwnerId,
                durableOwnerId,
                reuseOwnerId,
                pinHandle: state.active.pinHandle,
                newUseHashes,
                visualUseHashes,
                reuseUseHashes,
                newDescriptorHash: storedDescriptorHash,
                oldDescriptorHash: current.visualLayer?.descriptorHash ?? null,
                bakeReuseManifestHash: reuse.manifestHash,
                nextManifest,
                receipt,
            };
            await this._runJournal(journal, state);
            if (state.reuseCandidate) {
                state.reuseCandidate = null;
                await this.writeState(state);
            }
            return receipt;
        });
    }

    async cancel(environmentId, generation) {
        return this.service._withEnvironmentWrite(environmentId, async () => {
            await this.recover(environmentId);
            const state = await this.readState(environmentId);
            const receipt = state.receipts?.[String(generation)];
            if (receipt) return { cancelled: false, committed: true, receipt };
            if (!state.active || (generation != null && state.active.generation !== generation)) {
                return { cancelled: true, generation };
            }
            await this._cancelActive(environmentId, state, { invalidate: true });
            return { cancelled: true, generation };
        });
    }

    async recover(environmentId = null) {
        await this.service.visualAssets.initialize();
        let names;
        try {
            names = await fs.readdir(this.journalDir);
        } catch (error) {
            if (error.code === "ENOENT") names = [];
            else throw error;
        }
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            if (environmentId && !name.startsWith(`${environmentId}--`)) continue;
            let journal;
            try {
                journal = JSON.parse(await fs.readFile(path.join(this.journalDir, name), "utf8"));
            } catch {
                await fs.rm(path.join(this.journalDir, name), { force: true });
                continue;
            }
            if (environmentId && journal.environmentId !== environmentId) continue;
            await this._recoverJournal(journal);
        }
        const ids = environmentId
            ? [environmentId]
            : (await this._listStateIds());
        for (const id of ids) {
            if (this._staleReconciled.has(id)) continue;
            this._staleReconciled.add(id);
            const state = await this.readState(id);
            if (state.active && !state.receipts?.[String(state.active.generation)]) {
                await this._cancelActive(id, state, { invalidate: true });
            }
        }
    }

    async _assertOutputSourceGrants(outputSourceIds) {
        const registry = await this.service.visualAssets.registry.policyMap();
        const decision = evaluateVisualSourcePolicy({
            sourceIds: outputSourceIds,
            operations: [...VISUAL_ASSET_UPLOAD_OPERATIONS, ...VISUAL_ASSET_ACCESS_OPERATIONS, "derivatives"],
            registry,
            atTime: this.service.visualAssets.now(),
        });
        if (!decision.allowed) {
            throw bakeError(
                BAKE_PROMOTION_ERROR_CODES.RIGHTS_DENIED,
                "Trusted bake output sources are missing or insufficient.",
                { denials: decision.denials },
            );
        }
    }

    async retainReuseCandidate(environmentId, current) {
        if (!current?.visualLayer?.descriptorHash) return null;
        const state = await this.readState(environmentId);
        const world = createWorldResource(current);
        state.reuseCandidate = {
            worldHash: world.hash,
            descriptorHash: current.visualLayer.descriptorHash,
            accessHash: current.visualLayer.accessHash ?? null,
            bakeReuseManifestHash: current.visualLayer.bakeReuseManifestHash ?? null,
            sourceUseHashes: await this._currentUseHashes(current),
        };
        await this.writeState(state);
        return state.reuseCandidate;
    }

    async _readReuseCandidate(current, state) {
        const visual = current?.visualLayer;
        if (visual?.bakeReuseManifestHash) {
            const manifest = await this.service._bakeReuseManifests.get(visual.bakeReuseManifestHash);
            if (!manifest) {
                throw bakeError(
                    BAKE_PROMOTION_ERROR_CODES.REUSE_UNAUTHORIZED,
                    "Published bake reuse manifest is missing.",
                );
            }
            if (
                manifest.descriptorHash !== visual.descriptorHash
                || (visual.accessHash && manifest.accessHash !== visual.accessHash)
            ) {
                throw bakeError(
                    BAKE_PROMOTION_ERROR_CODES.REUSE_UNAUTHORIZED,
                    "Bake reuse manifest does not match the published visual layer.",
                );
            }
            return {
                trusted: true,
                worldHash: manifest.sourceWorldHash,
                descriptorHash: visual.descriptorHash,
                accessHash: visual.accessHash ?? null,
                bakeReuseManifestHash: visual.bakeReuseManifestHash,
                manifest,
            };
        }
        if (state.reuseCandidate?.bakeReuseManifestHash) {
            const manifest = await this.service._bakeReuseManifests.get(state.reuseCandidate.bakeReuseManifestHash);
            return {
                trusted: Boolean(manifest),
                ...state.reuseCandidate,
                manifest,
            };
        }
        if (visual?.descriptorHash) {
            return {
                trusted: false,
                worldHash: null,
                descriptorHash: visual.descriptorHash,
                accessHash: visual.accessHash ?? null,
                bakeReuseManifestHash: null,
                manifest: null,
            };
        }
        if (state.reuseCandidate) {
            return { trusted: false, ...state.reuseCandidate, manifest: null };
        }
        return null;
    }

    async _commitNoop(environmentId, generation, body, state, current, world) {
        const report = body.reuseReport ? normalizeBakeReuseReport(body.reuseReport) : null;
        if (!report || report.mode !== "noop" || report.captured.length || report.uploaded.length) {
            throw bakeError(
                BAKE_PROMOTION_ERROR_CODES.NOOP_INVALID,
                "A no-op bake must report zero captured or uploaded units.",
            );
        }
        if (report.sourceWorldHash !== world.hash) {
            throw bakeError(
                BAKE_PROMOTION_ERROR_CODES.NOOP_INVALID,
                "A no-op bake requires an unchanged world hash.",
            );
        }
        const visual = current.visualLayer;
        if (!visual?.descriptorHash || !visual?.accessHash) {
            throw bakeError(
                BAKE_PROMOTION_ERROR_CODES.NOOP_INVALID,
                "A no-op bake requires a published visual layer.",
            );
        }
        if (body.reuseManifest) {
            const manifest = normalizeBakeReuseManifest(body.reuseManifest);
            if (
                manifest.descriptorHash !== visual.descriptorHash
                || manifest.accessHash !== visual.accessHash
                || manifest.sourceWorldHash !== world.hash
            ) {
                throw bakeError(
                    BAKE_PROMOTION_ERROR_CODES.REUSE_UNAUTHORIZED,
                    "No-op reuse manifest does not match the published layer.",
                );
            }
        }
        await this._releaseActivePin(state);
        state.active = null;
        const receipt = {
            environmentId,
            generation,
            revision: current.revision ?? 0,
            worldHash: world.hash,
            descriptorHash: visual.descriptorHash,
            accessHash: visual.accessHash,
            artifactHash: null,
            bakeReuseManifestHash: visual.bakeReuseManifestHash ?? null,
            reuseReportHash: hashBakeReuseReport(report),
            mode: "noop",
            visualLayer: visual,
            manifest: current,
        };
        state.receipts[String(generation)] = receipt;
        await this.writeState(state);
        return receipt;
    }

    async _storeReuseDocuments(body, documents) {
        if (!body.reuseManifest && !body.reuseReport) {
            return { manifest: null, manifestHash: null, reportHash: null };
        }
        if (!body.reuseManifest || !body.reuseReport) {
            throw bakeError(
                BAKE_PROMOTION_ERROR_CODES.INCOMPLETE,
                "Bake reuse commits require both a manifest and a report.",
            );
        }
        const manifest = normalizeBakeReuseManifest(body.reuseManifest);
        const report = normalizeBakeReuseReport(body.reuseReport);
        if (manifest.descriptorHash !== documents.descriptorHash || manifest.accessHash !== documents.accessHash) {
            throw bakeError(
                BAKE_PROMOTION_ERROR_CODES.REUSE_UNAUTHORIZED,
                "Reuse manifest does not match the committed descriptor/access hashes.",
            );
        }
        const manifestHash = await this.service._bakeReuseManifests.put(manifest);
        if (manifestHash !== hashBakeReuseManifest(manifest)) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH, "Stored reuse manifest hash mismatch.");
        }
        return {
            manifest,
            manifestHash,
            reportHash: hashBakeReuseReport(report),
        };
    }

    async _assertReuseContributions(manifest) {
        if (!isBakeReuseManifestV2(manifest)) return;
        for (const unit of manifest.units ?? []) {
            const asset = unit.contribution;
            const use = await this.service.visualAssets.getUse(asset.useHash);
            if (!use) {
                throw bakeError(BAKE_PROMOTION_ERROR_CODES.INCOMPLETE, `Contribution use ${asset.useHash} is missing.`);
            }
            if (
                use.asset.sha256 !== asset.sha256
                || use.asset.sizeBytes !== asset.sizeBytes
                || use.asset.mediaType !== asset.mediaType
                || use.asset.role !== asset.role
            ) {
                throw bakeError(
                    BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH,
                    `Contribution use ${asset.useHash} does not match the reuse record.`,
                );
            }
            const opened = await this.service.visualAssets.openUseContent(asset.useHash);
            try {
                const chunks = [];
                for await (const chunk of opened.stream) chunks.push(chunk);
                const bytes = Buffer.concat(chunks);
                if (bytes.length !== asset.sizeBytes || sha256Bytes(bytes) !== asset.sha256) {
                    throw bakeError(
                        BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH,
                        `Contribution bytes for ${asset.useHash} do not match.`,
                    );
                }
            } finally {
                await opened.release();
            }
        }
    }

    async _releaseActivePin(state) {
        if (state.active?.pinHandle) {
            await this.service.visualAssets.releasePin({ handle: state.active.pinHandle });
        }
    }

    async _currentUseHashes(current) {
        const accessHash = current?.visualLayer?.accessHash;
        if (!accessHash) return [];
        const access = await this.service._visualLayerAccess.get(accessHash);
        if (!access) return [];
        return [...new Set(access.assets.map((entry) => entry.useHash))].sort();
    }

    _assertDocuments(body, active, worldHash, environmentId) {
        const config = normalizeBakeRunConfig(body.config ?? body.recipe ?? {});
        const snapshot = normalizeBakeSourceSnapshot(body.snapshot);
        const plan = normalizeBakeCapturePlan(body.plan);
        const request = normalizeBakeProviderRequest(body.request);
        const response = normalizeBakeProviderResponse(body.response);
        const artifactSet = normalizeBakeArtifactSet(body.artifactSet);
        const descriptor = assertVisualLayer(body.descriptor);
        const access = assertVisualLayerAccess(body.access);
        const recipeHash = hashBakeRunConfig(config);
        const snapshotHash = hashBakeSourceSnapshot(snapshot);
        const planHash = hashBakeCapturePlan(plan);
        const requestHash = hashBakeProviderRequest(request);
        const responseHash = hashBakeProviderResponse(response);
        const descriptorHash = hashVisualLayer(descriptor);
        const accessHash = hashVisualLayerAccess(access);
        const artifactHash = hashBakeArtifactSet(artifactSet);
        if (config.environmentId !== environmentId || artifactSet.environmentId !== environmentId) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.BINDING_MISMATCH, "Bake documents are bound to a different environment.");
        }
        if (snapshot.worldHash !== worldHash || snapshot.worldHash !== active.worldHash) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.BINDING_MISMATCH, "Snapshot world hash does not match the reserved binding.");
        }
        if (snapshot.environmentRevision !== active.expectedRevision) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.BINDING_MISMATCH, "Snapshot revision does not match the reserved binding.");
        }
        if (snapshot.bakeGeneration !== active.generation) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.STALE, "Snapshot generation does not match the reserved generation.");
        }
        if (artifactSet.bakeGeneration !== active.generation || artifactSet.worldHash !== worldHash) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.BINDING_MISMATCH, "Artifact set is not bound to the reserved generation.");
        }
        if (
            artifactSet.recipeHash !== recipeHash
            || artifactSet.snapshotHash !== snapshotHash
            || artifactSet.planHash !== planHash
            || artifactSet.requestHash !== requestHash
            || artifactSet.responseHash !== responseHash
            || artifactSet.descriptorHash !== descriptorHash
            || artifactSet.accessHash !== accessHash
        ) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH, "Artifact set hashes do not match the submitted VIS-07 documents.");
        }
        if (access.descriptorHash !== descriptorHash) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH, "Access sidecar does not match the descriptor.");
        }
        return {
            config,
            snapshot,
            plan,
            request,
            response,
            artifactSet,
            descriptor,
            access,
            descriptorHash,
            accessHash,
            artifactHash,
        };
    }

    async _assertGeneratedOutputs(artifactSet, outputSourceIds) {
        for (const asset of artifactSet.assets) {
            const use = await this.service.visualAssets.getUse(asset.useHash);
            if (!use) {
                throw bakeError(BAKE_PROMOTION_ERROR_CODES.INCOMPLETE, `Generated use ${asset.useHash} is missing.`);
            }
            if (
                use.asset.sha256 !== asset.sha256
                || use.asset.sizeBytes !== asset.sizeBytes
                || use.asset.mediaType !== asset.mediaType
                || use.asset.role !== asset.role
            ) {
                throw bakeError(BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH, `Generated use ${asset.useHash} does not match the artifact record.`);
            }
            if (!sameStringSets([...use.sourceIds].sort(), outputSourceIds)) {
                throw bakeError(
                    BAKE_PROMOTION_ERROR_CODES.RIGHTS_DENIED,
                    "Generated bake outputs must use the server-issued source IDs.",
                );
            }
            const opened = await this.service.visualAssets.openUseContent(asset.useHash);
            try {
                const chunks = [];
                for await (const chunk of opened.stream) chunks.push(chunk);
                const bytes = Buffer.concat(chunks);
                if (bytes.length !== asset.sizeBytes || sha256Bytes(bytes) !== asset.sha256) {
                    throw bakeError(BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH, `Generated bytes for ${asset.useHash} do not match.`);
                }
            } finally {
                await opened.release();
            }
        }
    }

    async _assertClosure(descriptor, access, artifactSet) {
        const uses = await this.service._loadAccessUses(access);
        try {
            assertVisualLayerAccessMatches(access, descriptor, uses);
        } catch (error) {
            throw bakeError(BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH, error.message);
        }
        await this.service.visualAssets.validateAccessSet({
            useHashes: access.assets.map((entry) => entry.useHash),
            operations: [...VISUAL_ASSET_ACCESS_OPERATIONS, ...VISUAL_ASSET_UPLOAD_OPERATIONS],
        });
        void artifactSet;
    }

    async _runJournal(journal, state) {
        const journalPath = this.journalPath(journal.environmentId, journal.generation);
        await this.service._writeJsonFile(journalPath, journal);
        await this._maybeFault("acquire-temp");
        await this._acquireTempRoot(journal);
        journal.phase = "publish-revision";
        await this.service._writeJsonFile(journalPath, journal);
        await this._maybeFault("publish-revision");
        await this._publishRevision(journal);
        journal.phase = "replace-root";
        await this.service._writeJsonFile(journalPath, journal);
        await this._maybeFault("replace-root");
        await this._replaceDurableRoot(journal);
        journal.phase = "replace-reuse-root";
        await this.service._writeJsonFile(journalPath, journal);
        await this._maybeFault("replace-reuse-root");
        await this._replaceReuseRoot(journal);
        journal.phase = "release-temp";
        await this.service._writeJsonFile(journalPath, journal);
        await this._maybeFault("release-temp");
        await this._releaseTempAndPin(journal);
        journal.phase = "receipt";
        await this.service._writeJsonFile(journalPath, journal);
        await this._maybeFault("receipt");
        state.active = null;
        state.receipts[String(journal.generation)] = journal.receipt;
        await this.writeState(state);
        await fs.rm(journalPath, { force: true });
    }

    async _recoverJournal(journal) {
        const current = await this.service._readEnvironment(journal.environmentId);
        const referenced = current?.visualLayer?.descriptorHash ?? null;
        const published = referenced === journal.newDescriptorHash;
        if (!published && (journal.phase === "acquire-temp" || journal.phase === "publish-revision")) {
            await this._rollbackPrePublish(journal);
            return;
        }
        if (published || JOURNAL_PHASES.indexOf(journal.phase) >= JOURNAL_PHASES.indexOf("publish-revision")) {
            if (!published && journal.phase !== "publish-revision") {
                await this._rollbackPrePublish(journal);
                return;
            }
            if (!published) {
                await this._publishRevision(journal);
            }
            if (JOURNAL_PHASES.indexOf(journal.phase) <= JOURNAL_PHASES.indexOf("replace-root")) {
                await this._replaceDurableRoot(journal);
            }
            if (JOURNAL_PHASES.indexOf(journal.phase) <= JOURNAL_PHASES.indexOf("replace-reuse-root")) {
                await this._replaceReuseRoot(journal);
            }
            await this._releaseTempAndPin(journal);
            const state = await this.readState(journal.environmentId);
            state.active = null;
            state.receipts[String(journal.generation)] = journal.receipt;
            await this.writeState(state);
        }
        await fs.rm(this.journalPath(journal.environmentId, journal.generation), { force: true });
    }

    async _acquireTempRoot(journal) {
        const current = this.service.visualAssets._roots?.roots?.[journal.tempOwnerId];
        if (current) {
            await this.service.visualAssets.replaceRoot({
                ownerId: journal.tempOwnerId,
                expectedGeneration: current.generation,
                useHashes: journal.newUseHashes,
                operations: [...VISUAL_ASSET_ACCESS_OPERATIONS, ...VISUAL_ASSET_UPLOAD_OPERATIONS],
                ownerKind: "bake-output",
            });
            return;
        }
        await this.service.visualAssets.acquireRoot({
            ownerId: journal.tempOwnerId,
            ownerKind: "bake-output",
            useHashes: journal.newUseHashes,
            operations: [...VISUAL_ASSET_ACCESS_OPERATIONS, ...VISUAL_ASSET_UPLOAD_OPERATIONS],
        });
    }

    async _publishRevision(journal) {
        const filePath = this.service._environmentPath(journal.environmentId);
        await this.service._fileStore(filePath, null).write(journal.nextManifest);
    }

    async _replaceDurableRoot(journal) {
        const useHashes = journal.visualUseHashes ?? journal.newUseHashes;
        const current = this.service.visualAssets._roots?.roots?.[journal.durableOwnerId];
        if (!current) {
            await this.service.visualAssets.acquireRoot({
                ownerId: journal.durableOwnerId,
                ownerKind: "environment",
                useHashes,
                operations: [...VISUAL_ASSET_ACCESS_OPERATIONS, ...VISUAL_ASSET_UPLOAD_OPERATIONS],
            });
            return;
        }
        await this.service.visualAssets.replaceRoot({
            ownerId: journal.durableOwnerId,
            expectedGeneration: current.generation,
            useHashes,
            operations: [...VISUAL_ASSET_ACCESS_OPERATIONS, ...VISUAL_ASSET_UPLOAD_OPERATIONS],
            ownerKind: "environment",
        });
    }

    async _replaceReuseRoot(journal) {
        if (!journal.reuseOwnerId) return;
        const useHashes = journal.reuseUseHashes ?? [];
        const current = this.service.visualAssets._roots?.roots?.[journal.reuseOwnerId];
        if (!current) {
            await this.service.visualAssets.acquireRoot({
                ownerId: journal.reuseOwnerId,
                ownerKind: "bake-reuse",
                useHashes,
                operations: [...VISUAL_ASSET_ACCESS_OPERATIONS, ...VISUAL_ASSET_UPLOAD_OPERATIONS],
            });
            return;
        }
        await this.service.visualAssets.replaceRoot({
            ownerId: journal.reuseOwnerId,
            expectedGeneration: current.generation,
            useHashes,
            operations: [...VISUAL_ASSET_ACCESS_OPERATIONS, ...VISUAL_ASSET_UPLOAD_OPERATIONS],
            ownerKind: "bake-reuse",
        });
    }

    async _releaseTempAndPin(journal) {
        const temp = this.service.visualAssets._roots?.roots?.[journal.tempOwnerId];
        if (temp) {
            await this.service.visualAssets.releaseRoot({
                ownerId: journal.tempOwnerId,
                expectedGeneration: temp.generation,
            });
        }
        if (journal.pinHandle) {
            await this.service.visualAssets.releasePin({ handle: journal.pinHandle });
        }
    }

    async _rollbackPrePublish(journal) {
        await this._releaseTempAndPin(journal);
        const state = await this.readState(journal.environmentId);
        if (state.active?.generation === journal.generation) state.active = null;
        await this.writeState(state);
        await fs.rm(this.journalPath(journal.environmentId, journal.generation), { force: true });
    }

    async _cancelActive(environmentId, state, { invalidate = false } = {}) {
        if (state.active?.pinHandle) {
            await this.service.visualAssets.releasePin({ handle: state.active.pinHandle });
        }
        const tempOwnerId = bakeOutputRootOwner(environmentId, state.active?.generation);
        const temp = this.service.visualAssets._roots?.roots?.[tempOwnerId];
        if (temp) {
            await this.service.visualAssets.releaseRoot({
                ownerId: tempOwnerId,
                expectedGeneration: temp.generation,
            });
        }
        if (invalidate) state.active = null;
        await this.writeState(state);
    }

    async _maybeFault(phase) {
        const fault = this.service.faults?.bakePromotion;
        if (typeof fault === "function") await fault(phase);
        if (this.service.faults?.bakePromotionPhase === phase) {
            throw Object.assign(new Error(`Injected bake promotion fault at ${phase}`), {
                code: "BAKE_PROMOTION_FAULT",
                phase,
            });
        }
    }

    async _listStateIds() {
        try {
            return (await fs.readdir(this.dir))
                .filter((name) => name.endsWith(".json"))
                .map((name) => name.slice(0, -".json".length));
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    }
}

void ENVIRONMENT_REVISION_CONFLICT;
void JOURNAL_PHASES;
