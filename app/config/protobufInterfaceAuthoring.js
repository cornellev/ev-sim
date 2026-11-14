import { createProtobufInterfaceResource } from "../interfaces/ProtobufRunBinding.js";
import { PROTOBUF_LIMITS } from "../interfaces/ProtobufSchema.js";

export function parseInterfaceRoutes(document, text) {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || Object.keys(value).some((key) => !["routes", "bootstrap"].includes(key))
        || !Array.isArray(value.routes) || !Array.isArray(value.bootstrap)) throw new Error('Use an object containing "routes" and "bootstrap" arrays.');
    return createProtobufInterfaceResource({ ...document, ...value });
}

function base64(bytes) {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text);
}

export async function uploadedProtoSource(files, entryFiles, includeDirs) {
    if (!files.length || files.length > 128) throw new Error("Select 1–128 proto files, including their imports.");
    if (files.some((file) => file.size > 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error("Proto files exceed the 1 MiB file or 8 MiB closure limit.");
    return { kind: "uploaded-proto", entryFiles, includeDirs, files: await Promise.all(files.map(async (file) => ({
        path: file.webkitRelativePath || file.name, bytesBase64: base64(new Uint8Array(await file.arrayBuffer())),
    }))) };
}

export async function uploadedDescriptorSource(file) {
    if (!file || file.size > PROTOBUF_LIMITS.descriptorBytes) throw new Error("Select a descriptor no larger than 700,000 bytes.");
    return { kind: "descriptor", descriptorBase64: base64(new Uint8Array(await file.arrayBuffer())) };
}

// One session belongs to ConfigPage, so mode switches keep drafts and fence old requests.
export class ProtobufInterfaceAuthoringSession {
    constructor({ fetchImpl = globalThis.fetch } = {}) {
        this.fetch = fetchImpl;
        this.listeners = new Set();
        this.cache = new Map();
        this.epoch = 0;
        this.snapshot = this.empty();
    }
    empty() { return { document: null, hash: null, source: null, check: null, busy: false, error: null, text: "", fields: { sourceId: "", schemaId: "schema", kind: "proto", url: "", ref: "main", entryFiles: "", includeDirs: "" }, catalog: { interfaces: [], sources: [] }, migration: null }; }
    getSnapshot = () => this.snapshot;
    subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    set(patch) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
    reset() { this.epoch++; this.cache.clear(); this.set(this.empty()); }
    async request(path, body) {
        const response = await this.fetch(`/api/storage/protobuf-interfaces${path}`, body === undefined ? undefined : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || result.message || "Protobuf request failed.");
        return result;
    }
    async work(operation) {
        if (this.snapshot.busy) throw new Error("Wait for the current interface request.");
        const epoch = this.epoch;
        this.set({ busy: true, error: null });
        try { return await operation(() => epoch === this.epoch); }
        catch (error) { if (epoch === this.epoch) this.set({ error: error.message }); throw error; }
        finally { if (epoch === this.epoch) this.set({ busy: false }); }
    }
    adopt(result) {
        const resource = createProtobufInterfaceResource(result.document, result.hash);
        this.cache.set(resource.hash, { ...resource, persisted: true });
        this.set({ ...resource, source: result.source ?? null, check: null,
            ...(result.source ? { fields: { ...this.snapshot.fields, sourceId: result.source.id, schemaId: result.source.schemaSources[0]?.schemaId ?? this.snapshot.fields.schemaId } } : {}),
            text: JSON.stringify({ routes: resource.document.routes, bootstrap: resource.document.bootstrap }, null, 2) });
        return resource;
    }
    async list() { return this.work(async (current) => { const catalog = await this.request(""); if (current()) this.set({ catalog }); }); }
    async select(hash, sourceId = null) {
        return this.work(async (current) => {
            const document = await this.request(`/sha256/${hash}`);
            if (!current()) return;
            if (!sourceId) {
                const catalog = await this.request("");
                if (!current()) return;
                this.set({ catalog });
                sourceId = catalog.sources.find((entry) => entry.interfaceHash === hash)?.id;
            }
            const source = sourceId ? await this.request(`/sources/${encodeURIComponent(sourceId)}`) : null;
            if (current()) return this.adopt({ document, hash, source });
        });
    }
    async importSource(source) {
        const { fields, hash } = this.snapshot;
        return this.work(async (current) => {
            await this.persist(hash);
            if (!current()) return;
            const tracked = this.snapshot.source;
            const input = { sourceId: fields.sourceId, schemaId: fields.schemaId, source,
                ...(hash ? { baseHash: hash } : { interfaceVersion: 2 }),
                ...(tracked?.id === fields.sourceId ? { expectedRevision: tracked.revision } : {}) };
            const result = await this.request(source.kind === "descriptor" ? "/import-descriptor" : "/import-sources", input);
            if (current()) return this.adopt(result);
        });
    }
    edit(text, retainedHashes = []) {
        this.set({ text, check: null });
        const resource = parseInterfaceRoutes(this.snapshot.document, text);
        this.cache.set(resource.hash, { ...resource, persisted: this.cache.get(resource.hash)?.persisted ?? false });
        for (const hash of this.cache.keys()) if (hash !== resource.hash && !retainedHashes.includes(hash)) this.cache.delete(hash);
        this.set({ document: resource.document, hash: resource.hash, error: null });
        return resource;
    }
    discard(document) {
        const resource = createProtobufInterfaceResource(document);
        this.set({ ...resource, text: JSON.stringify({ routes: document.routes, bootstrap: document.bootstrap }, null, 2), error: null });
    }
    async persist(hash = this.snapshot.hash) {
        const entry = this.cache.get(hash);
        if (!entry || entry.persisted) return;
        const epoch = this.epoch;
        const source = this.snapshot.source;
        const result = await this.request("", { document: entry.document,
            ...(source ? { sourceId: source.id, expectedRevision: source.revision } : {}) });
        if (epoch !== this.epoch) throw new Error("Run selection changed while saving the interface.");
        entry.persisted = true;
        if (source) this.set({ source: result.source, check: null });
    }
    async checkUpdate(source) {
        const tracked = this.snapshot.source;
        if (!tracked) throw new Error("Select a tracked source first.");
        return this.work(async (current) => {
            await this.persist();
            const result = await this.request(`/sources/${encodeURIComponent(tracked.id)}/check-update`, {
                schemaId: this.snapshot.fields.schemaId, expectedRevision: this.snapshot.source.revision, ...(source ? { source } : {}),
            });
            if (current()) {
                const record = await this.request(`/sources/${encodeURIComponent(tracked.id)}`);
                if (current()) this.set({ check: result, source: record });
            }
        });
    }
    async applyUpdate(acceptInvalidations) {
        const { source, check } = this.snapshot;
        return this.work(async (current) => {
            const result = await this.request(`/sources/${encodeURIComponent(source.id)}/apply-update`, {
                checkId: check.checkId, expectedRevision: source.revision, acceptInvalidations,
            });
            if (current()) return this.adopt(result);
        });
    }
}
