import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
    VISUAL_ADMISSION_MODES,
    checkVisualCorrespondenceAdmission,
} from "../../app/validation/VisualCorrespondence.js";
import { canonicalExactStringify } from "../../app/simulation/visual/VisualLayer.js";
import { PBR_MEASURED_ASSET_OPERATIONS } from "../../app/simulation/render/PbrRenderScene.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";

export const MANAGED_VISUAL_ASSET_OPERATIONS = Object.freeze([
    "display",
    "machine-interpretation",
    "retention",
    "worker-access",
]);

export const MANAGED_RESULT_ROOT_KIND = "headless-experiment-result";
export const MANAGED_BASELINE_ROOT_KIND = "headless-experiment-baseline";

export function managedResultRootOwner(resultId) {
    return `headless-result:${resultId}`;
}

export function managedBaselineRootOwner(baselineId) {
    return `headless-baseline:${baselineId}`;
}

export function isManagedPbrRun(resolved) {
    return resolved?.renderScene?.description?.provider?.id === "pbr-mesh";
}

function sortedUnique(values) {
    return [...new Set(values.filter(Boolean).map(String))].sort();
}

function same(left, right) {
    return canonicalExactStringify(left) === canonicalExactStringify(right);
}

function admissionError(message, details = null) {
    return new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", message, details);
}

function safeJournalName(resultId) {
    return createHash("sha256").update(String(resultId)).digest("hex");
}

async function writeAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${canonicalExactStringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
        const handle = await fs.open(temporary, "r");
        try { await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, filePath);
        const directory = await fs.open(path.dirname(filePath), "r");
        try { await directory.sync(); }
        finally { await directory.close(); }
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
    }
}

function closureFor(bundle) {
    if (!isManagedPbrRun(bundle?.resolved)) return null;
    const visualAssets = bundle.resolved.evidence?.visualAssets;
    if (!visualAssets) throw admissionError("Managed PBR evidence is missing its immutable visual-asset closure.");
    const useHashes = sortedUnique((visualAssets.uses || []).map((entry) => entry.useHash));
    const rootHashes = sortedUnique((visualAssets.roots || []).map((entry) => entry.useHash));
    if (rootHashes.some((useHash) => !useHashes.includes(useHash))) {
        throw admissionError("Managed PBR visual-asset roots are outside the resolved evidence closure.");
    }
    return {
        useHashes,
        digestUses: Object.fromEntries((visualAssets.uses || []).map((entry) => [entry.use.asset.sha256, entry.useHash])),
        closureUses: visualAssets.uses || [],
        assetClosureHash: visualAssets.assetClosureHash ?? null,
        reportHash: bundle.resolved.evidence?.correspondence?.reportHash ?? null,
    };
}

function assertEvidenceInputMatchesBundle(expectedInput, bundle, closure) {
    const resolved = bundle.resolved;
    const scene = resolved.renderScene;
    const description = scene.description;
    const required = [
        ["worldHash", description.worldHash ?? resolved.world?.hash],
        ["visualLayerHash", description.visualLayerHash],
        ["renderSceneHash", scene.hash],
        ["assetClosureHash", closure.assetClosureHash],
        ["captureRecipeHash", description.recipeHash],
        ["calibrationBundleHash", resolved.calibration?.hash],
    ];
    for (const [field, value] of required) {
        if (value && expectedInput?.[field] !== value) {
            throw admissionError(`Managed PBR evaluation input ${field} is not bound to the frozen run bundle.`);
        }
    }
    if (description.provider
        && (expectedInput?.provider?.id !== description.provider.id
            || Number(expectedInput?.provider?.version) !== Number(description.provider.version))) {
        throw admissionError("Managed PBR evaluation input provider is not bound to the frozen render scene.");
    }
    if (resolved.manifest?.seed !== undefined
        && Number(expectedInput?.seed) !== Number(resolved.manifest.seed)) {
        throw admissionError("Managed PBR evaluation input seed is not bound to the frozen run bundle.");
    }
    const expectedAssets = [...(expectedInput?.assets || [])]
        .map((entry) => ({
            sha256: entry.sha256,
            mediaType: entry.mediaType,
            sizeBytes: entry.sizeBytes,
            role: entry.role,
            useHash: entry.useHash,
        }))
        .sort((left, right) => `${left.sha256}:${left.useHash}`.localeCompare(`${right.sha256}:${right.useHash}`));
    const closureAssets = closure.closureUses
        .map((entry) => ({ ...entry.use.asset, useHash: entry.useHash }))
        .sort((left, right) => `${left.sha256}:${left.useHash}`.localeCompare(`${right.sha256}:${right.useHash}`));
    if (!same(expectedAssets, closureAssets)) {
        throw admissionError("Managed PBR evaluation input assets do not match the frozen visual-asset closure.");
    }
}

/**
 * Server-owned admission for authoring-store assets used by managed runs.
 * Queue roots are durable; active worker pins and readers are process scoped.
 */
export class ManagedVisualAssetAdmission {
    constructor(storage, {
        evidenceContextProvider = null,
        executionPinLeaseMs = 24 * 60 * 60 * 1000,
    } = {}) {
        if (!storage?.visualAssets) throw new TypeError("Managed visual admission requires a visual asset store.");
        this.storage = storage;
        this.store = storage.visualAssets;
        this.evidenceContextProvider = evidenceContextProvider;
        this.executionPinLeaseMs = executionPinLeaseMs;
        this.journalDir = path.join(storage.dataDir, "headless-admission-journals");
    }

    async _assertEvidence(bundle, phase) {
        if (!isManagedPbrRun(bundle.resolved)) return { ok: true, managedEligible: true };
        const closure = closureFor(bundle);
        if (!closure.reportHash) {
            throw admissionError("Managed PBR requires correspondence evidence bound to the immutable run bundle.");
        }
        const context = await this.evidenceContextProvider?.({
            bundle,
            resolved: bundle.resolved,
            reportHash: closure.reportHash,
            phase,
        });
        if (!context) {
            throw admissionError("Managed PBR correspondence evaluation is unavailable until VIS-16b is configured.");
        }
        if (context.reportSha256 !== closure.reportHash) {
            throw admissionError("Managed PBR correspondence bytes do not match the report bound to the run bundle.");
        }
        assertEvidenceInputMatchesBundle(context.expectedInput, bundle, closure);
        const decision = await checkVisualCorrespondenceAdmission({
            ...context,
            mode: VISUAL_ADMISSION_MODES.managed,
            rightsDecision: { allowed: true },
            assetDecision: { valid: true },
        });
        if (!decision.ok || decision.managedEligible !== true) {
            throw admissionError(decision.message || "Managed PBR correspondence evidence is ineligible.", {
                phase,
                code: decision.code ?? null,
                failures: decision.failures ?? [],
            });
        }
        return decision;
    }

    async _validateBundle(bundle, phase) {
        const closure = closureFor(bundle);
        if (!closure) return null;
        const verified = await this.store.validateAccessSet({
            useHashes: closure.useHashes,
            operations: [...MANAGED_VISUAL_ASSET_OPERATIONS],
            verifyBytes: true,
            includeUseRecords: true,
        });
        if (!same(verified.closureUses, closure.closureUses)) {
            throw admissionError("Managed PBR asset records do not match the frozen bundle evidence.");
        }
        await this._assertEvidence(bundle, phase);
        return closure;
    }

    async validateBundle(bundle, phase = "preflight") {
        return this._validateBundle(bundle, phase);
    }

    _journalPath(resultId) {
        return path.join(this.journalDir, `${safeJournalName(resultId)}.json`);
    }

    async acquireQueueRoot(resultId, bundles) {
        const closures = [];
        for (const bundle of bundles) {
            const closure = await this._validateBundle(bundle, "queue-admission");
            if (closure) closures.push(closure);
        }
        const useHashes = sortedUnique(closures.flatMap((entry) => entry.useHashes));
        if (useHashes.length === 0) return { root: null, cases: bundles.map(() => null) };
        const ownerId = managedResultRootOwner(resultId);
        const journalPath = this._journalPath(resultId);
        await writeAtomic(journalPath, {
            kind: "cev-sim.managed-visual-admission-journal",
            version: 1,
            phase: "acquiring-root",
            resultId,
            ownerId,
            useHashes,
        });
        let root = await this.store.getRoot(ownerId);
        let created = false;
        try {
            if (root) {
                if (root.ownerKind !== MANAGED_RESULT_ROOT_KIND || !same(root.useHashes, useHashes)) {
                    throw admissionError("Existing managed result root conflicts with the queued immutable closure.");
                }
            } else {
                root = await this.store.acquireRoot({
                    ownerId,
                    ownerKind: MANAGED_RESULT_ROOT_KIND,
                    useHashes,
                    operations: [...MANAGED_VISUAL_ASSET_OPERATIONS],
                });
                created = true;
            }
            await writeAtomic(journalPath, {
                kind: "cev-sim.managed-visual-admission-journal",
                version: 1,
                phase: "root-acquired",
                resultId,
                ownerId,
                rootGeneration: root.generation,
                useHashes,
            });
        } catch (error) {
            if (created && root) {
                const released = await this.store.releaseRoot({
                    ownerId,
                    expectedGeneration: root.generation,
                }).then(() => true, () => false);
                if (released) await fs.rm(journalPath, { force: true }).catch(() => {});
            } else if (!root) {
                await fs.rm(journalPath, { force: true }).catch(() => {});
            }
            throw error;
        }
        let pbrIndex = 0;
        return {
            root,
            cases: bundles.map((bundle) => {
                if (!isManagedPbrRun(bundle.resolved)) return null;
                const closure = closures[pbrIndex++];
                return {
                    useHashes: closure.useHashes,
                    assetClosureHash: closure.assetClosureHash,
                    correspondenceReportHash: closure.reportHash,
                };
            }),
        };
    }

    async commitQueueRoot(resultId) {
        await fs.rm(this._journalPath(resultId), { force: true });
    }

    async recordQueueStage(resultId, phase) {
        const allowed = new Set(["sidecars-published", "result-created", "queue-published"]);
        if (!allowed.has(phase)) throw new TypeError(`Unknown managed admission phase ${phase}.`);
        const ownerId = managedResultRootOwner(resultId);
        const root = await this.store.getRoot(ownerId);
        if (!root || root.ownerKind !== MANAGED_RESULT_ROOT_KIND) return null;
        await writeAtomic(this._journalPath(resultId), {
            kind: "cev-sim.managed-visual-admission-journal",
            version: 1,
            phase,
            resultId,
            ownerId,
            rootGeneration: root.generation,
            useHashes: root.useHashes,
        });
        return root;
    }

    /**
     * Remove roots only when a crash journal has no persisted result, sidecars,
     * or queue owner. Any partially published ownership stays protected and is
     * surfaced to normal result reconciliation instead of being guessed away.
     */
    async reconcileOrphanJournals(queue) {
        let names;
        try {
            names = await fs.readdir(this.journalDir);
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
        const queued = new Set((queue?.entries || []).map((entry) => entry.resultId));
        const outcomes = [];
        for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
            const journalPath = path.join(this.journalDir, name);
            let journal;
            try {
                journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
            } catch (error) {
                outcomes.push({ journal: name, action: "preserved", reason: error.message });
                continue;
            }
            const resultId = String(journal?.resultId || "");
            const ownerId = managedResultRootOwner(resultId);
            if (journal?.kind !== "cev-sim.managed-visual-admission-journal"
                || journal?.version !== 1
                || !resultId
                || journal.ownerId !== ownerId) {
                outcomes.push({ journal: name, action: "preserved", reason: "invalid-journal" });
                continue;
            }
            if (queued.has(resultId)) {
                outcomes.push({ resultId, action: "queued" });
                continue;
            }
            let result;
            let sidecars;
            try {
                [result, sidecars] = await Promise.all([
                    this.storage.getExperimentResult(resultId),
                    this.storage.readHeadlessRunBundles(resultId),
                ]);
            } catch (error) {
                outcomes.push({ resultId, action: "preserved", reason: error.message });
                continue;
            }
            if (result || sidecars) {
                outcomes.push({ resultId, action: "preserved", reason: "ambiguous-persisted-owner" });
                continue;
            }
            const root = await this.store.getRoot(ownerId);
            if (root?.ownerKind === MANAGED_RESULT_ROOT_KIND) {
                await this.store.releaseRoot({ ownerId, expectedGeneration: root.generation });
            }
            await fs.rm(journalPath, { force: true });
            outcomes.push({ resultId, action: "rolled-back" });
        }
        return outcomes;
    }

    async rollbackQueueRoot(resultId) {
        const ownerId = managedResultRootOwner(resultId);
        const root = await this.store.getRoot(ownerId);
        if (root?.ownerKind === MANAGED_RESULT_ROOT_KIND) {
            await this.store.releaseRoot({ ownerId, expectedGeneration: root.generation });
        }
        await fs.rm(this._journalPath(resultId), { force: true });
    }

    async reconcileQueueRoot(resultId, sidecars) {
        const pbrCases = sidecars.bundles.filter((bundle) => isManagedPbrRun(bundle.resolved));
        if (pbrCases.length === 0) return null;
        if (Number(sidecars.manifest.version) < 2) {
            throw admissionError("Managed PBR requires version-2 immutable bundle sidecars.");
        }
        for (const [index, bundle] of sidecars.bundles.entries()) {
            if (!isManagedPbrRun(bundle.resolved)) continue;
            const closure = closureFor(bundle);
            const metadata = sidecars.manifest.cases[index];
            if (!same(metadata?.visualUseHashes ?? [], closure.useHashes)
                || metadata?.assetClosureHash !== closure.assetClosureHash
                || metadata?.correspondenceReportHash !== closure.reportHash) {
                throw admissionError("Managed PBR sidecar metadata does not match its immutable bundle closure.");
            }
        }
        const expected = sortedUnique(pbrCases.flatMap((bundle) => closureFor(bundle).useHashes));
        const root = await this.store.getRoot(managedResultRootOwner(resultId));
        if (!root || root.ownerKind !== MANAGED_RESULT_ROOT_KIND || !same(root.useHashes, expected)) {
            throw admissionError("Managed PBR durable queue root is missing or does not match its frozen sidecars.");
        }
        for (const bundle of pbrCases) await this._validateBundle(bundle, "queue-recovery");
        return root;
    }

    async openExecution({ resultId, caseIndex, bundle }) {
        const closure = await this._validateBundle(bundle, "worker-start");
        if (!closure) return null;
        const root = await this.store.getRoot(managedResultRootOwner(resultId));
        if (!root || root.ownerKind !== MANAGED_RESULT_ROOT_KIND
            || !closure.useHashes.every((useHash) => root.useHashes.includes(useHash))) {
            throw admissionError("Managed PBR execution has no matching durable result root.");
        }
        const pin = await this.store.acquirePin({
            ownerId: `headless-execution:${resultId}:${caseIndex}`,
            useHashes: closure.useHashes,
            operations: [...MANAGED_VISUAL_ASSET_OPERATIONS],
            leaseMs: this.executionPinLeaseMs,
        });
        const pending = new Set();
        const leases = new Set();
        let closed = false;
        const assertOpen = () => {
            if (closed) throw admissionError("Managed visual-asset reader is closed.");
        };
        const track = (promise) => {
            pending.add(promise);
            promise.finally(() => pending.delete(promise)).catch(() => {});
            return promise;
        };
        const openUse = async (useHash, options = {}) => {
            assertOpen();
            if (!closure.useHashes.includes(useHash)) throw admissionError("Requested use is outside the managed asset closure.");
            const opened = await this.store.openUseContent(useHash, {
                ...options,
                operations: [...PBR_MEASURED_ASSET_OPERATIONS],
            });
            let released = false;
            const release = async () => {
                if (released) return;
                released = true;
                await opened.release();
                leases.delete(release);
            };
            leases.add(release);
            return { ...opened, release };
        };
        const reader = Object.freeze({
            authorizeUse: (useHash, operations = []) => track((async () => {
                assertOpen();
                if (!closure.useHashes.includes(useHash)) throw admissionError("Requested use is outside the managed asset closure.");
                const requested = sortedUnique(operations);
                if (requested.some((operation) => !PBR_MEASURED_ASSET_OPERATIONS.includes(operation))) {
                    throw admissionError("Renderer requested an operation outside managed measured-camera rights.");
                }
                await this.store.statUseContent(useHash, { operations: requested });
                return { allowed: true, useHash, operations: requested };
            })()),
            openUse: (useHash, options) => track(openUse(useHash, options)),
            open: (digest, options) => {
                const useHash = closure.digestUses[digest];
                if (!useHash) return Promise.reject(admissionError("Requested digest is outside the managed asset closure."));
                return track(openUse(useHash, options));
            },
        });
        const close = async () => {
            if (closed) return;
            closed = true;
            await Promise.allSettled([...pending]);
            await Promise.allSettled([...leases].map((release) => release()));
            await this.store.releasePin({ handle: pin.handle });
        };
        return { pin, reader, close };
    }
}
