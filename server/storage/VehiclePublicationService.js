import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { canonicalStringify } from "../../app/simulation/canonicalJson.js";
import { computeResolvedRunHash } from "../../app/simulation/RunManifest.js";
import {
    VEHICLE_MANIFEST_VERSION_V3,
    assertNoVehicleManifestDowngrade,
    normalizeVehicleManifest,
} from "../../app/vehicles/VehicleManifest.js";
import { validateStandardAxles, validateVehicleAssetClosure } from "../../app/vehicles/axle/standardAxle.js";
import { reviewBoundWheels } from "../../app/vehicles/axle/reviewModelWheels.js";
import { measurePlacedVehicleModel } from "../../app/vehicles/model/measurePlacedVehicle.js";
import { validateVehicleModelClosure } from "../../app/vehicles/model/validateVehicleModel.js";
import { VEHICLE_PUBLICATION_ERROR_CODES, vehicleStorageError } from "./StorageErrors.js";
import { fsyncDir, writeExclusiveFile } from "./visual-assets/atomicFs.js";

const JOURNAL_KIND = "cev-sim.vehicle-publication-journal";
const RECEIPT_KIND = "cev-sim.vehicle-publication-receipt";
const INTAKE_KIND = "cev-sim.vehicle-publication-intake";
const MIGRATION_KIND = "cev-sim.vehicle-pre-migration";
const CONTENT_NAME = /^[a-f0-9]{64}\.(glb|png|jpg|ktx2)$/;

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function publicationError(code, message) {
    return vehicleStorageError(code, message);
}

function validationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("; ");
    const error = new Error(`Vehicle manifest validation failed: ${detail}`);
    error.issues = issues;
    return error;
}

function operationIdOf(value) {
    if (value == null || value === "") return randomBytes(32).toString("hex");
    const text = String(value);
    if (!/^[a-f0-9]{64}$/.test(text)) {
        throw publicationError(
            VEHICLE_PUBLICATION_ERROR_CODES.INVALID,
            "operationId must be 64 lowercase hex characters.",
        );
    }
    return text;
}

async function injectFault(faults, name) {
    const fault = faults?.[name];
    if (!fault) return;
    if (typeof fault === "function") {
        await fault(name);
        return;
    }
    const error = new Error(`Injected vehicle publication fault: ${name}`);
    error.code = "INJECTED_FAULT";
    throw error;
}

/**
 * One transaction for creating, saving, importing, duplicating, migrating,
 * and publishing a vehicle. Asset bytes land before the manifest, and a
 * crash before that manifest write removes only the files this operation
 * introduced.
 */
export class VehiclePublicationService {
    constructor(service, { faults = {}, now = () => new Date() } = {}) {
        this.service = service;
        this.faults = faults;
        this.now = now;
    }

    async recover(vehicleId = null) {
        const journals = await this._listJournals();
        const referenced = new Set(journals.map((journal) => journal.stageId).filter(Boolean));
        await this.service.vehicleStages.recover(referenced);
        for (const journal of journals) {
            if (vehicleId != null && journal.vehicleId !== vehicleId && journal.sourceVehicleId !== vehicleId) continue;
            await this._recoverJournal(journal);
        }
    }

    async referencedStageIds() {
        const journals = await this._listJournals();
        return new Set(journals.map((journal) => journal.stageId).filter(Boolean));
    }

    /**
     * Publish while the caller holds the destination vehicle lock, and the
     * source lock when `sourceVehicleId` is set.
     */
    async publishLocked(operation) {
        const operationId = operationIdOf(operation.operationId);
        const stageId = operation.stageId ?? null;
        if (stageId) await this.service.vehicleStages.markPublishing(stageId);
        let journal = null;
        try {
            const inputs = await this._collectInputs(operation);
            const prepared = await this._prepareManifest(operation, inputs);
            const requestHash = this._requestHash(operation, prepared.normalized, inputs);
            const receipt = await this._readReceipt(operationId);
            if (receipt) {
                if (receipt.requestHash !== requestHash) {
                    throw publicationError(
                        VEHICLE_PUBLICATION_ERROR_CODES.CONFLICT,
                        `Vehicle publication "${operationId}" was already used for a different request.`,
                    );
                }
                return receipt.manifest;
            }
            const existing = await this._readJournal(operationId);
            if (existing) {
                if (existing.requestHash !== requestHash) {
                    throw publicationError(
                        VEHICLE_PUBLICATION_ERROR_CODES.CONFLICT,
                        `Vehicle publication "${operationId}" was already used for a different request.`,
                    );
                }
                await this._recoverJournal(existing);
                const resumed = await this._readReceipt(operationId);
                if (resumed) return resumed.manifest;
            }

            const current = await this.service.getVehicleManifest(operation.vehicleId);
            const currentRevision = Number(current?.revision || 0);
            if (operation.create && current) throw new Error(`Vehicle "${operation.vehicleId}" already exists.`);
            if (!operation.create && operation.expectedRevision !== undefined && Number(operation.expectedRevision) !== currentRevision) {
                throw new Error(`Vehicle manifest revision conflict: expected ${operation.expectedRevision}, current revision is ${currentRevision}.`);
            }
            assertNoVehicleManifestDowngrade(current, operation.manifest);
            const now = this.now().toISOString();
            const stored = {
                ...prepared.normalized,
                revision: currentRevision + 1,
                definitionHash: computeResolvedRunHash(prepared.normalized),
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
            };
            const placement = await this._planPlacement(operation.vehicleId, inputs);
            const migrationSnapshot = operation.migration
                ? await this._captureMigrationSnapshot(operation.vehicleId)
                : null;
            journal = {
                kind: JOURNAL_KIND,
                version: 1,
                operationId,
                requestHash,
                mode: operation.mode,
                phase: "prepared",
                vehicleId: operation.vehicleId,
                sourceVehicleId: operation.sourceVehicleId ?? null,
                expectedRevision: Number(operation.expectedRevision ?? 0),
                stageId,
                introduced: placement.introduced,
                reused: placement.reused,
                resultRevision: stored.revision,
                resultDefinitionHash: stored.definitionHash,
                candidateManifest: stored,
                migrationSnapshot,
            };
            await this._writeJournal(journal);
            await injectFault(this.faults, "after-prepared");
            await this._promote(operation.vehicleId, placement.introduced);
            journal = { ...journal, phase: "assets-promoted" };
            await this._writeJournal(journal);
            await injectFault(this.faults, "after-promote");
            const written = await this.service._commitPreparedVehicleManifest(operation.vehicleId, stored, {
                expectedRevision: operation.expectedRevision,
                create: operation.create === true,
            });
            journal = { ...journal, phase: "manifest-published", candidateManifest: written };
            await this._writeJournal(journal);
            await injectFault(this.faults, "after-manifest");
            await this._writeMigrationFile(migrationSnapshot);
            await injectFault(this.faults, "after-snapshot");
            const finished = await this._writeReceipt(journal, written);
            await injectFault(this.faults, "after-receipt");
            await this._deleteJournal(operationId);
            if (operation.useIntake) await this.removeIntake(operation.vehicleId);
            journal = null;
            return finished.manifest;
        } finally {
            if (stageId) {
                const pending = await this._readJournal(operationId);
                if (!pending || pending.stageId !== stageId) {
                    await this.service.vehicleStages.markOpen(stageId);
                }
            }
        }
    }

    async putIntake({ vehicleId, name, bytes, sha256: digest }) {
        const buffer = Buffer.from(bytes);
        if (sha256(buffer) !== digest) {
            throw new Error("Prepared marketplace vehicle asset hash changed.");
        }
        const intake = await this._readIntake(vehicleId) ?? {
            kind: INTAKE_KIND,
            version: 1,
            vehicleId,
            members: [],
        };
        const current = intake.members.find((entry) => entry.name === name);
        if (current && current.sha256 !== digest) {
            const error = new Error(`Vehicle asset "${vehicleId}/${name}" changed after marketplace planning.`);
            error.code = "CONFLICT";
            error.statusCode = 409;
            throw error;
        }
        const target = this._intakeMemberPath(vehicleId, digest);
        await writeExclusiveFile(target, buffer);
        if (!current) {
            intake.members.push({ name, sha256: digest, size: buffer.length });
            intake.members.sort((left, right) => (left.name < right.name ? -1 : 1));
            await this._writeIntake(vehicleId, intake);
        }
        return { vehicleId, fileName: name, sha256: digest, sizeBytes: buffer.length, reused: Boolean(current) };
    }

    async assertIntakePublished(vehicleId) {
        const intake = await this._readIntake(vehicleId);
        if (!intake) return;
        for (const member of intake.members) {
            const bytes = await this.service._readVehicleAssetIfPresent(vehicleId, member.name);
            if (!bytes || sha256(bytes) !== member.sha256) {
                const error = new Error(`Published marketplace vehicle "${vehicleId}" is missing asset "${member.name}".`);
                error.code = "RECOVERY_REQUIRED";
                error.statusCode = 409;
                throw error;
            }
        }
    }

    async removeIntake(vehicleId) {
        const directory = this.service._vehicleIntakeDir(vehicleId);
        this.service._fileStore(path.join(directory, "intake.json"), null).invalidate();
        await fs.rm(directory, { recursive: true, force: true });
    }

    async hiddenNames(vehicleId) {
        const hidden = new Set();
        const stored = await this.service.getVehicleManifest(vehicleId);
        for (const journal of await this._listJournals()) {
            if (journal.vehicleId !== vehicleId) continue;
            if (journal.phase === "manifest-published" || journal.phase === "receipt") continue;
            if (stored && stored.revision === journal.resultRevision && stored.definitionHash === journal.resultDefinitionHash) {
                continue;
            }
            for (const entry of journal.introduced ?? []) hidden.add(entry.name);
        }
        return hidden;
    }

    async _prepareManifest(operation, inputs) {
        const validation = await this.service._validateVehicleManifestWithPluginSensors({
            ...operation.manifest,
            id: operation.vehicleId,
        });
        if (!validation.ok) throw validationError(validation.issues);
        const normalized = validation.manifest;
        await this._assertClosure(operation, normalized, inputs);
        return { normalized };
    }

    async _assertClosure(operation, manifest, inputs) {
        if (Number(manifest.version) !== VEHICLE_MANIFEST_VERSION_V3) return;
        const axleIssues = validateStandardAxles(manifest);
        if (axleIssues.length > 0) throw validationError(axleIssues);
        const asset = manifest.model?.asset ?? null;
        if (!asset) {
            if ((manifest.model?.dependencies ?? []).length > 0 || (manifest.model?.hiddenNodeIndices ?? []).length > 0) {
                throw validationError([{
                    path: "model",
                    message: "A model-free vehicle cannot declare dependencies or hidden nodes.",
                }]);
            }
            return;
        }
        const canonical = CONTENT_NAME.test(asset);
        if (!canonical && !operation.migration) return;
        if (!canonical) {
            throw validationError([{
                path: "model.asset",
                message: "A version 3 model publication requires a content-addressed GLB.",
            }]);
        }
        const names = [asset, ...(manifest.model.dependencies ?? [])];
        const files = new Map();
        const dependencies = [];
        for (const name of names) {
            const member = await this._memberBytes(operation.vehicleId, name, inputs);
            files.set(name, member.bytes);
            if (name !== asset) dependencies.push({ name, bytes: member.bytes, sha256: member.sha256 });
        }
        let closure;
        try {
            closure = validateVehicleModelClosure({ glbBytes: files.get(asset), dependencies });
        } catch (error) {
            throw validationError([{ path: "model", message: error.message }]);
        }
        const issues = validateVehicleAssetClosure(manifest, {
            files: Object.fromEntries(names.map((name) => [name, true])),
            nodeTable: closure.nodeTable,
        });
        if (issues.length > 0) throw validationError(issues);
        const bound = (manifest.wheels ?? []).some((wheel) => wheel.visual?.kind === "model-node");
        if (!bound) return;
        let measurement;
        try {
            measurement = measurePlacedVehicleModel({
                glbBytes: files.get(asset),
                model: manifest.model,
                boundingBox: manifest.boundingBox,
                hiddenNodeIndices: manifest.model?.hiddenNodeIndices ?? [],
            });
        } catch (error) {
            throw validationError([{
                path: "model",
                code: error.code || "vehicle.wheel.bounds-unavailable",
                message: error.message,
            }]);
        }
        const measured = reviewBoundWheels(manifest, measurement);
        if (!measured.withinTolerance || !measured.unchanged) {
            throw validationError(measured.issues.length > 0 ? measured.issues : [{
                path: "wheels",
                code: "vehicle.wheel.measurement-mismatch",
                message: "Bound wheels do not match the measured proposal.",
            }]);
        }
    }

    async _memberBytes(vehicleId, name, inputs) {
        if (inputs.has(name)) return inputs.get(name);
        const bytes = await this.service._readVehicleAssetIfPresent(vehicleId, name);
        if (!bytes) {
            throw validationError([{ path: "model.asset", message: `Missing model file "${name}".` }]);
        }
        return { name, bytes, sha256: sha256(bytes), size: bytes.length, source: { type: "vehicle", vehicleId, name } };
    }

    async _collectInputs(operation) {
        const inputs = new Map();
        const add = (name, bytes, source) => {
            const buffer = Buffer.from(bytes);
            const digest = sha256(buffer);
            const previous = inputs.get(name);
            if (previous && previous.sha256 !== digest) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.CONFLICT,
                    `Vehicle asset "${name}" was staged with two different digests.`,
                );
            }
            if (!previous) {
                inputs.set(name, { name, bytes: buffer, sha256: digest, size: buffer.length, source });
            }
        };
        if (operation.stageId) {
            const meta = await this.service.vehicleStages.requireMeta(operation.stageId);
            for (const member of meta.members) {
                const loaded = await this.service.vehicleStages.readMember(operation.stageId, member.name);
                if (loaded.sha256 !== member.sha256) {
                    throw publicationError(
                        VEHICLE_PUBLICATION_ERROR_CODES.CONFLICT,
                        `Staged member "${member.name}" does not match its recorded digest.`,
                    );
                }
                add(member.name, loaded.bytes, { type: "stage", stageId: operation.stageId, sha256: loaded.sha256 });
            }
        }
        if (operation.useIntake) {
            const intake = await this._readIntake(operation.vehicleId);
            for (const member of intake?.members ?? []) {
                const bytes = await fs.readFile(this._intakeMemberPath(operation.vehicleId, member.sha256));
                add(member.name, bytes, { type: "intake", vehicleId: operation.vehicleId, sha256: member.sha256 });
            }
        }
        for (const file of operation.files ?? []) {
            add(file.name, file.bytes, file.source ?? {
                type: "vehicle",
                vehicleId: operation.sourceVehicleId,
                name: file.name,
            });
        }
        return inputs;
    }

    async _planPlacement(vehicleId, inputs) {
        const introduced = [];
        const reused = [];
        for (const member of [...inputs.values()].sort((left, right) => (left.name < right.name ? -1 : 1))) {
            const existing = await this.service._readVehicleAssetIfPresent(vehicleId, member.name);
            if (existing) {
                if (sha256(existing) !== member.sha256) {
                    throw publicationError(
                        VEHICLE_PUBLICATION_ERROR_CODES.IMMUTABLE,
                        `Vehicle asset "${member.name}" already exists with different bytes.`,
                    );
                }
                reused.push({ name: member.name, sha256: member.sha256 });
                continue;
            }
            introduced.push({
                name: member.name,
                sha256: member.sha256,
                size: member.size,
                source: member.source,
            });
        }
        return { introduced, reused };
    }

    async _promote(vehicleId, introduced) {
        for (const entry of introduced) {
            const bytes = await this._readSource(entry.source);
            if (sha256(bytes) !== entry.sha256) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.RECOVERY_REQUIRED,
                    `Publication source for "${entry.name}" changed before it was promoted.`,
                );
            }
            const filePath = this.service._vehicleAssetPath(vehicleId, entry.name);
            const existing = await this.service._readVehicleAssetIfPresent(vehicleId, entry.name);
            if (existing) {
                if (sha256(existing) !== entry.sha256) {
                    throw publicationError(
                        VEHICLE_PUBLICATION_ERROR_CODES.IMMUTABLE,
                        `Vehicle asset "${entry.name}" already exists with different bytes.`,
                    );
                }
                continue;
            }
            await writeExclusiveFile(filePath, bytes);
        }
        if (introduced.length > 0) await fsyncDir(this.service._vehicleAssetDir(vehicleId), this.faults);
    }

    async _captureMigrationSnapshot(vehicleId) {
        const current = await this.service.getVehicleManifest(vehicleId);
        if (!current) throw new Error(`Vehicle "${vehicleId}" does not exist.`);
        const { registry } = await this.service._sensorRegistryForVehicle(current);
        const manifest = normalizeVehicleManifest(current, { sensorRegistry: registry });
        const names = await this.service._listVehicleAssetNamesUnlocked(vehicleId);
        const hidden = await this.hiddenNames(vehicleId);
        const assets = {};
        for (const name of names) {
            if (hidden.has(name)) continue;
            const bytes = await this.service._readVehicleAssetUnlocked(vehicleId, name);
            assets[name] = sha256(bytes);
        }
        return {
            kind: MIGRATION_KIND,
            version: 1,
            vehicleId,
            retainedAt: this.now().toISOString(),
            manifest,
            assets,
        };
    }

    async _writeMigrationFile(snapshot) {
        if (!snapshot) return;
        const store = this.service._fileStore(this.service._vehicleMigrationPath(snapshot.vehicleId), null);
        if (await store.read()) return;
        await store.write(snapshot);
    }

    /**
     * Move a vehicle to a new id. Asset bytes are copied before the destination
     * manifest, and the source is removed only after that manifest is durable.
     * Run and scenario references are not rewritten.
     */
    async changeIdLocked({ sourceVehicleId, destinationVehicleId, expectedRevision, operationId }) {
        const operation = operationIdOf(operationId);
        const receipt = await this._readReceipt(operation);
        const source = await this.service.getVehicleManifest(sourceVehicleId);
        if (!source) {
            if (receipt?.manifest?.id === destinationVehicleId) return receipt.manifest;
            if (receipt) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.CONFLICT,
                    `Vehicle publication "${operation}" was already used for a different request.`,
                );
            }
            throw new Error(`Vehicle "${sourceVehicleId}" does not exist.`);
        }
        const sourceRevision = Number(source.revision || 0);
        if (Number(expectedRevision) !== sourceRevision) {
            throw new Error(`Vehicle manifest revision conflict: expected ${expectedRevision}, current revision is ${sourceRevision}.`);
        }
        if (sourceVehicleId === destinationVehicleId) return source;
        const destination = await this.service.getVehicleManifest(destinationVehicleId);
        if (destination) throw new Error(`Vehicle "${destinationVehicleId}" already exists.`);
        const { registry } = await this.service._sensorRegistryForVehicle(source);
        const normalized = normalizeVehicleManifest({ ...source, id: destinationVehicleId }, { sensorRegistry: registry });
        const now = this.now().toISOString();
        const stored = {
            ...normalized,
            revision: 1,
            definitionHash: computeResolvedRunHash(normalized),
            createdAt: source.createdAt ?? now,
            updatedAt: now,
        };
        const requestHash = sha256(Buffer.from(canonicalStringify({
            mode: "change-id",
            sourceVehicleId,
            destinationVehicleId,
            expectedRevision: sourceRevision,
            sourceDefinitionHash: source.definitionHash,
        })));
        if (receipt) {
            if (receipt.requestHash !== requestHash) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.CONFLICT,
                    `Vehicle publication "${operation}" was already used for a different request.`,
                );
            }
            return receipt.manifest;
        }
        const existing = await this._readJournal(operation);
        if (existing) {
            if (existing.requestHash !== requestHash) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.CONFLICT,
                    `Vehicle publication "${operation}" was already used for a different request.`,
                );
            }
            await this._recoverIdChange(existing);
            const resumed = await this._readReceipt(operation);
            if (resumed) return resumed.manifest;
        }

        const snapshot = await this.service._readVehicleSnapshotUnlocked(sourceVehicleId);
        const introduced = [];
        for (const file of snapshot.files) {
            const current = await this.service._readVehicleAssetIfPresent(destinationVehicleId, file.name);
            if (current) {
                if (sha256(current) !== file.sha256) {
                    throw publicationError(
                        VEHICLE_PUBLICATION_ERROR_CODES.IMMUTABLE,
                        `Vehicle asset "${file.name}" is an immutable content-addressed member.`,
                    );
                }
                continue;
            }
            introduced.push({
                name: file.name,
                sha256: file.sha256,
                size: file.bytes.length,
                source: { type: "vehicle", vehicleId: sourceVehicleId, name: file.name },
            });
        }
        let journal = {
            kind: JOURNAL_KIND,
            version: 1,
            operationId: operation,
            requestHash,
            mode: "change-id",
            phase: "prepared",
            vehicleId: destinationVehicleId,
            sourceVehicleId,
            destinationVehicleId,
            expectedRevision: sourceRevision,
            introduced,
            resultRevision: stored.revision,
            resultDefinitionHash: stored.definitionHash,
            candidateManifest: stored,
        };
        await this._writeJournal(journal);
        await injectFault(this.faults, "after-id-prepared");
        for (const entry of introduced) {
            const bytes = await this.service._readVehicleAssetUnlocked(sourceVehicleId, entry.name);
            await this.service._putVehicleAssetUnlocked(destinationVehicleId, entry.name, bytes);
        }
        journal = { ...journal, phase: "assets-copied" };
        await this._writeJournal(journal);
        await injectFault(this.faults, "after-id-assets");
        const written = await this.service._commitPreparedVehicleManifest(destinationVehicleId, stored, {
            expectedRevision: 0,
            create: true,
        });
        journal = { ...journal, phase: "destination-published", candidateManifest: written };
        await this._writeJournal(journal);
        await injectFault(this.faults, "after-id-manifest");
        await this.service._deleteVehicleRecordUnlocked(sourceVehicleId);
        journal = { ...journal, phase: "source-removed" };
        await this._writeJournal(journal);
        await injectFault(this.faults, "after-id-source");
        const finished = await this._writeReceipt(journal, written);
        await this._deleteJournal(operation);
        return finished.manifest;
    }

    async _recoverIdChange(journal) {
        const destination = await this.service.getVehicleManifest(journal.destinationVehicleId);
        const ready = Boolean(destination)
            && destination.id === journal.destinationVehicleId
            && destination.revision === journal.resultRevision
            && destination.definitionHash === journal.resultDefinitionHash;
        if (!ready) {
            await this._rollback({ ...journal, vehicleId: journal.destinationVehicleId });
            await this._deleteJournal(journal.operationId);
            return;
        }
        await this._ensureIntroduced({ ...journal, vehicleId: journal.destinationVehicleId });
        await this.service._deleteVehicleRecordUnlocked(journal.sourceVehicleId);
        await this._writeReceipt(journal, destination);
        await this._deleteJournal(journal.operationId);
    }

    async _recoverJournal(journal) {
        if (journal.mode === "change-id") {
            await this._recoverIdChange(journal);
            return;
        }
        const stored = await this.service.getVehicleManifest(journal.vehicleId);
        const matches = Boolean(stored)
            && stored.revision === journal.resultRevision
            && stored.definitionHash === journal.resultDefinitionHash;
        const previous = !stored
            ? journal.resultRevision === 1
            : stored.revision === journal.resultRevision - 1;
        if (matches) {
            await this._ensureIntroduced(journal);
            await this._writeMigrationFile(journal.migrationSnapshot);
            await this._writeReceipt(journal, stored);
            await this._deleteJournal(journal.operationId);
            if (journal.stageId) await this.service.vehicleStages.markOpen(journal.stageId);
            return;
        }
        if (!previous) {
            throw publicationError(
                VEHICLE_PUBLICATION_ERROR_CODES.RECOVERY_REQUIRED,
                `Vehicle "${journal.vehicleId}" publication "${journal.operationId}" cannot be recovered.`,
            );
        }
        await this._rollback(journal);
        await this._deleteJournal(journal.operationId);
        if (journal.stageId) await this.service.vehicleStages.markOpen(journal.stageId);
    }

    async _ensureIntroduced(journal) {
        for (const entry of journal.introduced ?? []) {
            const existing = await this.service._readVehicleAssetIfPresent(journal.vehicleId, entry.name);
            if (existing) {
                if (sha256(existing) !== entry.sha256) {
                    throw publicationError(
                        VEHICLE_PUBLICATION_ERROR_CODES.RECOVERY_REQUIRED,
                        `Published asset "${entry.name}" does not match the publication journal.`,
                    );
                }
                continue;
            }
            const bytes = await this._readSource(entry.source);
            if (sha256(bytes) !== entry.sha256) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.RECOVERY_REQUIRED,
                    `Publication source for "${entry.name}" no longer matches the journal.`,
                );
            }
            await writeExclusiveFile(this.service._vehicleAssetPath(journal.vehicleId, entry.name), bytes);
        }
    }

    async _rollback(journal) {
        for (const entry of journal.introduced ?? []) {
            const existing = await this.service._readVehicleAssetIfPresent(journal.vehicleId, entry.name);
            if (!existing) continue;
            if (sha256(existing) !== entry.sha256) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.RECOVERY_REQUIRED,
                    `Cannot roll back "${entry.name}" because its bytes changed.`,
                );
            }
            await fs.rm(this.service._vehicleAssetPath(journal.vehicleId, entry.name), { force: true });
        }
    }

    async _readSource(source) {
        if (source?.type === "stage") {
            const meta = await this.service.vehicleStages.requireMeta(source.stageId);
            const member = meta.members.find((entry) => entry.sha256 === source.sha256);
            if (!member) {
                throw publicationError(
                    VEHICLE_PUBLICATION_ERROR_CODES.RECOVERY_REQUIRED,
                    "Publication stage no longer contains the promoted member.",
                );
            }
            const loaded = await this.service.vehicleStages.readMember(source.stageId, member.name);
            return loaded.bytes;
        }
        if (source?.type === "intake") {
            return fs.readFile(this._intakeMemberPath(source.vehicleId, source.sha256));
        }
        if (source?.type === "vehicle") {
            return this.service._readVehicleAssetUnlocked(source.vehicleId, source.name);
        }
        throw publicationError(
            VEHICLE_PUBLICATION_ERROR_CODES.RECOVERY_REQUIRED,
            "Publication journal is missing a member source.",
        );
    }

    _requestHash(operation, manifest, inputs) {
        const files = [...inputs.values()]
            .map((entry) => ({ name: entry.name, sha256: entry.sha256 }))
            .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        return sha256(Buffer.from(canonicalStringify({
            create: operation.create === true,
            expectedRevision: Number(operation.expectedRevision ?? 0),
            files,
            manifest,
            migration: operation.migration === true,
            mode: operation.mode,
            sourceVehicleId: operation.sourceVehicleId ?? null,
            vehicleId: operation.vehicleId,
        })));
    }

    async _writeReceipt(journal, manifest) {
        const receipt = {
            kind: RECEIPT_KIND,
            version: 1,
            operationId: journal.operationId,
            requestHash: journal.requestHash,
            vehicleId: journal.vehicleId,
            revision: manifest.revision,
            definitionHash: manifest.definitionHash,
            manifest,
        };
        await this.service._fileStore(this._receiptPath(journal.operationId), null).write(receipt);
        return receipt;
    }

    async _readReceipt(operationId) {
        return this.service._fileStore(this._receiptPath(operationId), null).read();
    }

    async _readJournal(operationId) {
        return this.service._fileStore(this._journalPath(operationId), null).read();
    }

    async _writeJournal(journal) {
        await this.service._fileStore(this._journalPath(journal.operationId), null).write(journal);
    }

    async _deleteJournal(operationId) {
        const filePath = this._journalPath(operationId);
        this.service._fileStore(filePath, null).invalidate();
        await fs.rm(filePath, { force: true });
    }

    async _listJournals() {
        let names = [];
        try {
            names = await fs.readdir(this.service.vehiclePublicationsDir);
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
        const journals = [];
        for (const name of names.sort()) {
            if (!name.endsWith(".json")) continue;
            const journal = await this.service._fileStore(path.join(this.service.vehiclePublicationsDir, name), null).read();
            if (journal?.kind === JOURNAL_KIND) journals.push(journal);
        }
        return journals;
    }

    async _readIntake(vehicleId) {
        return this.service._fileStore(path.join(this.service._vehicleIntakeDir(vehicleId), "intake.json"), null).read();
    }

    async _writeIntake(vehicleId, intake) {
        await this.service._fileStore(path.join(this.service._vehicleIntakeDir(vehicleId), "intake.json"), null).write(intake);
    }

    _journalPath(operationId) {
        return path.join(this.service.vehiclePublicationsDir, `${operationId}.json`);
    }

    _receiptPath(operationId) {
        return path.join(this.service.vehiclePublicationReceiptsDir, `${operationId}.json`);
    }

    _intakeMemberPath(vehicleId, digest) {
        return path.join(this.service._vehicleIntakeDir(vehicleId), "members", digest);
    }
}
