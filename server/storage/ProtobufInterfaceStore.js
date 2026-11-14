import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "../../app/simulation/canonicalJson.js";
import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { hashProtobufInterface, validateProtobufInterface } from "../../app/interfaces/ProtobufInterface.js";
import { loadDescriptorSet, PROTOBUF_LIMITS } from "../../app/interfaces/ProtobufSchema.js";
import {
    decodeProtobufBase64, loadDescriptorFile, loadProtoFiles, loadUploadedProtoFiles, readProtobufFile,
} from "../interfaces/ProtobufSourceLoader.js";
import { GitHubProtobufSource } from "../interfaces/GitHubProtobufSource.js";
import { JsonFileStore } from "./JsonFileStore.js";
import { protobufStorageError } from "./StorageErrors.js";
import { fsyncDir, maybeFault, writeExclusiveFile } from "./visual-assets/atomicFs.js";

export const PROTOBUF_IMPORT_JSON_BYTES = 16 * 1024 * 1024;
const SOURCE_RECORD_BYTES = 32 * 1024 * 1024;
const KIND = "cev-sim.protobuf-interface-source";
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function invalid(message) { throw protobufStorageError("PROTOBUF_INVALID", message); }
function identifier(value) {
    if (typeof value !== "string" || !ID.test(value)) invalid("Invalid protobuf source or schema identifier.");
    return value;
}
function digest(value) {
    if (typeof value !== "string" || !DIGEST.test(value)) invalid("Expected a lowercase SHA-256 interface hash.");
    return value;
}
function object(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.keys(value).some((key) => !keys.includes(key))) invalid("Invalid protobuf request fields.");
}
function normalized(value) {
    const result = validateProtobufInterface(value);
    if (!result.ok) throw protobufStorageError("PROTOBUF_INVALID", result.issues[0].message, { issues: result.issues });
    return result.document;
}
function revision(record, expected) {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== (record?.revision ?? 0)) {
        throw protobufStorageError("PROTOBUF_REVISION_CONFLICT", "Protobuf source revision conflict; send the current expectedRevision.", { currentRevision: record?.revision ?? 0 });
    }
}
function summary(document, hash) {
    return { hash, schemaIds: document.schemas.map((schema) => schema.id), routeCount: document.routes.length, bootstrapCount: document.bootstrap.length };
}

export class ProtobufInterfaceStore {
    constructor(dataDir, { fetchImpl = globalThis.fetch, now = () => new Date(), faults = {} } = {}) {
        this.rootDir = path.join(dataDir, "protobuf-interfaces");
        this.now = now;
        this.faults = faults;
        this.github = new GitHubProtobufSource({ fetchImpl, now: () => new Date(now()).getTime() });
        this._stores = new Map();
        this._chains = new Map();
    }

    _time() { return new Date(this.now()).toISOString(); }
    _path(hash) { return path.join(this.rootDir, "sha256", `${digest(hash)}.json`); }
    _sourcePath(id) { return path.join(this.rootDir, "sources", `${identifier(id)}.json`); }

    async _run(id, work) {
        identifier(id);
        const previous = this._chains.get(id) ?? Promise.resolve();
        const request = previous.catch(() => {}).then(work);
        this._chains.set(id, request);
        try { return await request; }
        finally { if (this._chains.get(id) === request) this._chains.delete(id); }
    }

    async getByHash(hash) {
        const file = this._path(hash);
        let document;
        try { document = normalized(JSON.parse(await readProtobufFile(file, PROTOBUF_LIMITS.payloadBytes))); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            throw protobufStorageError("PROTOBUF_CORRUPT", `Cannot verify protobuf interface ${hash}: ${error.message}`);
        }
        if (hashProtobufInterface(document) !== hash) throw protobufStorageError("PROTOBUF_CORRUPT", "Stored protobuf interface does not match its hash.");
        return document;
    }

    async _requiredDocument(hash) {
        const document = await this.getByHash(hash);
        if (!document) throw protobufStorageError("PROTOBUF_NOT_FOUND", "Protobuf interface was not found.");
        return document;
    }

    async _writeImmutable(document) {
        const hash = hashProtobufInterface(document);
        const file = this._path(hash);
        try {
            const result = await writeExclusiveFile(file, canonicalStringify(document), { faults: this.faults });
            if (result.existed) {
                const existing = await this._requiredDocument(hash);
                if (canonicalStringify(existing) !== canonicalStringify(document)) throw protobufStorageError("PROTOBUF_CORRUPT", "Immutable protobuf content collision.");
                await fsyncDir(path.dirname(file), this.faults);
            }
        } catch (error) {
            if (error.code?.startsWith("PROTOBUF_")) throw error;
            throw protobufStorageError("PROTOBUF_IO", `Could not publish protobuf interface: ${error.message}`);
        }
        return { hash, document };
    }

    async putImmutable(input, options = {}) {
        object(options, ["sourceId", "expectedRevision"]);
        const document = normalized(input);
        if (options.sourceId === undefined) return this._writeImmutable(document);
        return this._run(options.sourceId, async () => {
            const source = await this._requiredSource(options.sourceId);
            revision(source, options.expectedRevision);
            const current = await this._requiredDocument(source.interfaceHash);
            for (const binding of source.schemaSources) {
                if (document.schemas.find((schema) => schema.id === binding.schemaId)?.fingerprint
                    !== current.schemas.find((schema) => schema.id === binding.schemaId)?.fingerprint) invalid("Use checkUpdate/applyUpdate to change a source-bound schema.");
            }
            const published = await this._writeImmutable(document);
            const next = {
                ...source, revision: source.revision + 1, interfaceHash: published.hash, lastCheck: null,
                invalidatedRoutes: source.invalidatedRoutes.filter(({ route }) => !document.routes.some((item) => item.id === route.id)),
                invalidatedBootstrap: source.invalidatedBootstrap.filter(({ bootstrap }) => !document.bootstrap.some((item) => item.id === bootstrap.id)),
            };
            await this._writeSource(next);
            return { ...published, source: next };
        });
    }

    async getSource(id) {
        let record;
        try { record = JSON.parse(await readProtobufFile(this._sourcePath(id), SOURCE_RECORD_BYTES)); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            if (error.code === "PROTOBUF_INVALID") throw error;
            throw protobufStorageError("PROTOBUF_CORRUPT", `Cannot read protobuf source: ${error.message}`);
        }
        if (record?.kind !== KIND || record.version !== 1 || record.id !== id || !DIGEST.test(record.interfaceHash)
            || !Number.isSafeInteger(record.revision) || record.revision < 1
            || !Array.isArray(record.schemaSources) || record.schemaSources.length > 16
            || !Array.isArray(record.invalidatedRoutes) || !Array.isArray(record.invalidatedBootstrap)) {
            throw protobufStorageError("PROTOBUF_CORRUPT", "Invalid protobuf source record.");
        }
        return record;
    }

    async _requiredSource(id) {
        const record = await this.getSource(id);
        if (!record) throw protobufStorageError("PROTOBUF_NOT_FOUND", "Protobuf source was not found.");
        return record;
    }

    async _writeSource(record) {
        if (Buffer.byteLength(JSON.stringify(record, null, 2)) > SOURCE_RECORD_BYTES) throw protobufStorageError("PROTOBUF_TOO_LARGE", "Protobuf source and disabled drafts exceed the storage limit.");
        const file = this._sourcePath(record.id);
        let store = this._stores.get(file);
        if (!store) { store = new JsonFileStore(file); this._stores.set(file, store); }
        try {
            await maybeFault(this.faults, "sourceWrite");
            await store.write(record);
            await maybeFault(this.faults, "sourceCommitted");
        } catch (error) {
            store.invalidate();
            throw protobufStorageError("PROTOBUF_IO", `Could not save protobuf source: ${error.message}`);
        }
    }

    async list() {
        const names = async (directory) => {
            try { return (await readdir(path.join(this.rootDir, directory))).filter((name) => name.endsWith(".json")).sort(compareUtf8); }
            catch (error) { if (error.code === "ENOENT") return []; throw error; }
        };
        const interfaces = [];
        for (const name of await names("sha256")) {
            const hash = name.slice(0, -5);
            interfaces.push(summary(await this._requiredDocument(hash), hash));
        }
        const sources = [];
        for (const name of await names("sources")) {
            const record = await this._requiredSource(name.slice(0, -5));
            sources.push({ id: record.id, revision: record.revision, interfaceHash: record.interfaceHash,
                schemaIds: record.schemaSources.map((source) => source.schemaId),
                invalidatedRouteIds: record.invalidatedRoutes.map(({ route }) => route.id),
                invalidatedBootstrapIds: record.invalidatedBootstrap.map(({ bootstrap }) => bootstrap.id) });
        }
        return { interfaces, sources };
    }

    async _acquire(source, schemaId, signal) {
        object(source, ["kind", "url", "ref", "entryFiles", "includeDirs", "files", "filePath", "descriptorBase64"]);
        try {
            let loaded;
            let provenance;
            if (source.kind === "github") {
                object(source, ["kind", "url", "ref", "entryFiles", "includeDirs"]);
                const pin = await this.github.resolveCommit(source, { signal });
                loaded = await this.github.fetchImportClosure(pin, source);
                provenance = loaded.source;
            } else if (source.kind === "local-proto" || source.kind === "uploaded-proto") {
                object(source, source.kind === "local-proto" ? ["kind", "entryFiles", "includeDirs"] : ["kind", "entryFiles", "includeDirs", "files"]);
                loaded = source.kind === "local-proto"
                    ? await loadProtoFiles(source.entryFiles, { includeDirs: source.includeDirs })
                    : await loadUploadedProtoFiles(source);
                provenance = { kind: "local-proto", origin: source.kind === "local-proto" ? "filesystem" : "upload",
                    entryFiles: source.kind === "local-proto" ? source.entryFiles.map((file) => path.resolve(file)) : [...source.entryFiles],
                    includeDirs: source.kind === "local-proto" ? (source.includeDirs ?? []).map((dir) => path.resolve(dir)) : [...(source.includeDirs ?? [])], files: loaded.files };
            } else if (source.kind === "descriptor") {
                object(source, ["kind", "filePath", "descriptorBase64"]);
                if ((source.filePath === undefined) === (source.descriptorBase64 === undefined)) invalid("Select one descriptor file or base64 value.");
                loaded = source.filePath !== undefined ? await loadDescriptorFile(source.filePath)
                    : loadDescriptorSet(decodeProtobufBase64(source.descriptorBase64, PROTOBUF_LIMITS.descriptorBytes));
                provenance = { kind: "descriptor", origin: source.filePath === undefined ? "upload" : "filesystem",
                    ...(source.filePath === undefined ? {} : { filePath: path.resolve(source.filePath) }),
                    files: [{ path: source.filePath === undefined ? "descriptor.binpb" : path.resolve(source.filePath), sha256: loaded.fingerprint, size: Buffer.from(loaded.descriptorBase64, "base64").length }] };
            } else invalid("Unsupported protobuf source kind.");
            return { schema: { id: schemaId, fingerprint: loaded.fingerprint, descriptorBase64: loaded.descriptorBase64 }, source: { ...provenance, schemaId } };
        } catch (error) {
            if (error.code?.startsWith("PROTOBUF_")) throw error;
            throw protobufStorageError("PROTOBUF_ACQUISITION_FAILED", `Protobuf acquisition failed: ${error.message}`);
        }
    }

    importSources(input, options = {}) {
        if (input?.source?.kind === "descriptor") invalid("Use importDescriptor for binary descriptors.");
        return this._import(input, options);
    }

    importDescriptor(input, options = {}) {
        if (input?.source?.kind !== "descriptor") invalid("Select a descriptor source.");
        return this._import(input, options);
    }

    async _import(input, { signal } = {}) {
        object(input, ["sourceId", "schemaId", "source", "baseHash", "expectedRevision", "routes", "bootstrap", "interfaceVersion"]);
        if (input.interfaceVersion !== undefined && ![1, 2].includes(input.interfaceVersion)) invalid("interfaceVersion must be 1 or 2.");
        identifier(input.schemaId);
        if (input.baseHash !== undefined) digest(input.baseHash);
        return this._run(input.sourceId, async () => {
            const existing = await this.getSource(input.sourceId);
            if (existing || input.expectedRevision !== undefined) revision(existing, input.expectedRevision);
            if (existing?.schemaSources.some((binding) => binding.schemaId === input.schemaId)) invalid("Use checkUpdate/applyUpdate to replace an imported schema.");
            if (existing && input.baseHash !== undefined && existing.interfaceHash !== input.baseHash) revision(existing, -1);
            const base = existing ? await this._requiredDocument(existing.interfaceHash)
                : input.baseHash ? await this._requiredDocument(input.baseHash)
                    : { kind: "cev-sim.protobuf-interface", version: input.interfaceVersion ?? 1, schemas: [], routes: [], bootstrap: [] };
            if (input.interfaceVersion !== undefined && input.interfaceVersion !== base.version) invalid("The interfaceVersion must match the selected base interface.");
            const acquired = await this._acquire(input.source, input.schemaId, signal);
            if (base.schemas.some((schema) => schema.id === input.schemaId && schema.fingerprint !== acquired.schema.fingerprint)) invalid("The imported schema does not match the selected base interface.");
            const document = normalized({ ...base, schemas: [...base.schemas.filter((schema) => schema.id !== input.schemaId), acquired.schema],
                routes: input.routes ?? base.routes, bootstrap: input.bootstrap ?? base.bootstrap });
            const published = await this._writeImmutable(document);
            const record = { kind: KIND, version: 1, id: input.sourceId, revision: (existing?.revision ?? 0) + 1,
                interfaceHash: published.hash, schemaSources: [...(existing?.schemaSources ?? []), acquired.source].sort((a, b) => compareUtf8(a.schemaId, b.schemaId)),
                invalidatedRoutes: (existing?.invalidatedRoutes ?? []).filter(({ route }) => !document.routes.some((item) => item.id === route.id)),
                invalidatedBootstrap: (existing?.invalidatedBootstrap ?? []).filter(({ bootstrap }) => !document.bootstrap.some((item) => item.id === bootstrap.id)),
                lastCheck: null, lastUpdate: existing?.lastUpdate ?? null };
            await this._writeSource(record);
            return { ...published, source: record };
        });
    }

    _analyzeUpdate(document, candidateSchema) {
        const schemas = document.schemas.map((schema) => schema.id === candidateSchema.id ? candidateSchema : schema);
        const minimal = { kind: document.kind, version: document.version, schemas: [candidateSchema], routes: [], bootstrap: [] };
        normalized(minimal);
        const invalidatedBootstrap = [];
        const bootstrap = document.bootstrap.filter((entry) => {
            if (entry.schemaId !== candidateSchema.id) return true;
            const result = validateProtobufInterface({ ...minimal, bootstrap: [entry] });
            if (result.ok) return true;
            invalidatedBootstrap.push({ bootstrap: entry, issues: result.issues });
            return false;
        });
        const invalidatedRoutes = [];
        const routes = document.routes.filter((entry) => {
            if (entry.schemaId !== candidateSchema.id) return true;
            const selectedBootstrap = bootstrap.filter((item) => item.id === entry.source?.bootstrapId);
            const result = validateProtobufInterface({ ...minimal, bootstrap: selectedBootstrap, routes: [entry] });
            if (result.ok) return true;
            invalidatedRoutes.push({ route: entry, issues: result.issues });
            return false;
        });
        const candidate = normalized({ ...document, schemas, bootstrap, routes });
        return { document: candidate, candidateHash: hashProtobufInterface(candidate), invalidatedRoutes, invalidatedBootstrap };
    }

    async checkUpdate(id, input, { signal } = {}) {
        object(input, ["schemaId", "expectedRevision", "source"]);
        identifier(input.schemaId);
        const record = await this._requiredSource(id);
        revision(record, input.expectedRevision);
        const binding = record.schemaSources.find((source) => source.schemaId === input.schemaId);
        if (!binding) invalid("Schema is not bound to this source record.");
        let source = input.source;
        if (!source) {
            if (binding.kind === "github") source = { kind: "github", url: `https://github.com/${binding.repository.owner}/${binding.repository.repo}`,
                ref: binding.requestedRef, entryFiles: binding.entryFiles, includeDirs: binding.includeDirs };
            else if (binding.origin === "filesystem") source = binding.kind === "descriptor"
                ? { kind: "descriptor", filePath: binding.filePath }
                : { kind: "local-proto", entryFiles: binding.entryFiles, includeDirs: binding.includeDirs };
            else invalid("Supply replacement bytes to check an uploaded source.");
        }
        const acquired = await this._acquire(source, input.schemaId, signal);
        const analysis = this._analyzeUpdate(await this._requiredDocument(record.interfaceHash), acquired.schema);
        return this._run(id, async () => {
            const current = await this._requiredSource(id);
            revision(current, record.revision);
            const check = { checkId: randomUUID(), checkedAt: this._time(), baseRevision: record.revision, baseHash: record.interfaceHash,
                schemaId: input.schemaId, candidateSchema: acquired.schema, candidateSource: acquired.source,
                candidateHash: analysis.candidateHash, invalidatedRoutes: analysis.invalidatedRoutes, invalidatedBootstrap: analysis.invalidatedBootstrap };
            const next = { ...current, revision: current.revision + 1, lastCheck: check };
            await this._writeSource(next);
            return { ...check, sourceId: id, revision: next.revision };
        });
    }

    async applyUpdate(id, input) {
        object(input, ["checkId", "expectedRevision", "acceptInvalidations"]);
        if (typeof input.checkId !== "string" || !input.checkId.length || input.checkId.length > 128) invalid("Select a pending checkId.");
        if (input.acceptInvalidations !== undefined && typeof input.acceptInvalidations !== "boolean") invalid("acceptInvalidations must be boolean.");
        return this._run(id, async () => {
            const source = await this._requiredSource(id);
            if (source.lastUpdate?.checkId === input.checkId && source.lastUpdate.revision === source.revision) {
                return { hash: source.interfaceHash, document: await this._requiredDocument(source.interfaceHash), source, unchanged: true };
            }
            revision(source, input.expectedRevision);
            const check = source.lastCheck;
            if (!check || check.checkId !== input.checkId || check.baseHash !== source.interfaceHash || check.baseRevision !== source.revision - 1) revision(source, -1);
            if (check.candidateSchema.id !== check.schemaId || check.candidateSource.schemaId !== check.schemaId) throw protobufStorageError("PROTOBUF_CORRUPT", "Pending protobuf schema identity changed.");
            const analysis = this._analyzeUpdate(await this._requiredDocument(source.interfaceHash), check.candidateSchema);
            if (analysis.candidateHash !== check.candidateHash) throw protobufStorageError("PROTOBUF_CORRUPT", "Pending protobuf candidate does not match its hash.");
            if ((analysis.invalidatedRoutes.length || analysis.invalidatedBootstrap.length) && input.acceptInvalidations !== true) {
                throw protobufStorageError("PROTOBUF_INVALIDATION_ACCEPTANCE_REQUIRED", "Review the preview and explicitly accept disabled routes/bootstrap values.", {
                    issues: [...analysis.invalidatedRoutes.map((item) => ({ kind: "route", id: item.route.id, issues: item.issues })),
                        ...analysis.invalidatedBootstrap.map((item) => ({ kind: "bootstrap", id: item.bootstrap.id, issues: item.issues }))],
                });
            }
            const published = await this._writeImmutable(analysis.document);
            const next = { ...source, revision: source.revision + 1, interfaceHash: published.hash,
                schemaSources: source.schemaSources.map((binding) => binding.schemaId === check.schemaId ? check.candidateSource : binding),
                invalidatedRoutes: [...source.invalidatedRoutes, ...analysis.invalidatedRoutes],
                invalidatedBootstrap: [...source.invalidatedBootstrap, ...analysis.invalidatedBootstrap], lastCheck: null,
                lastUpdate: { checkId: check.checkId, appliedAt: this._time(), fromHash: source.interfaceHash, toHash: published.hash, revision: source.revision + 1 } };
            await this._writeSource(next);
            return { ...published, source: next };
        });
    }
}
