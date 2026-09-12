/**
 * Environment document schema and apply policy.
 *
 * Schema v2 is the legacy authoring shape. Schema v3 adds a server-owned
 * revision and optional content-addressed visual/evidence references.
 * Schema v4 adds `document.objects`, the authoring object graph: an overlay
 * keyed by the legacy record ids whose geometry stays canonical in
 * `roads`/`buildings`/`features`/`earth`, so the graph never enters
 * `worldHash`. v4 is read everywhere but written only when the server opts in
 * (the ED-02 default; `CEV_SIM_ENVIRONMENT_SCHEMA_V4=0` opts out); once a file is v4 it stays v4.
 * `accessHash` is provenance for preview materialization and stays out of
 * `worldHash`. Preview meshes are isolated from measured cameras, registries,
 * and oracle scans.
 */

import {
    OBJECT_GRAPH_VERSION,
    deriveObjectGraph,
    normalizeObjectRecord,
    objectTypeRegistry,
    reconcileObjectGraph,
    sortObjectRecords,
    validateObjectGraph,
} from "../editor/objects/index.js";

export const ENVIRONMENT_SCHEMA_VERSION = 3;
export const ENVIRONMENT_LEGACY_SCHEMA_VERSION = 2;
export const ENVIRONMENT_OBJECT_SCHEMA_VERSION = 4;
export const ENVIRONMENT_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([
    ENVIRONMENT_LEGACY_SCHEMA_VERSION,
    ENVIRONMENT_SCHEMA_VERSION,
    ENVIRONMENT_OBJECT_SCHEMA_VERSION,
]);
export const ENVIRONMENT_REVISION_CONFLICT = "ENVIRONMENT_REVISION_CONFLICT";
export const ENVIRONMENT_UNGUARDED_WRITE = "ENVIRONMENT_UNGUARDED_WRITE";
export const ENVIRONMENT_SCHEMA_DOWNGRADE = "ENVIRONMENT_SCHEMA_DOWNGRADE";
export const ENVIRONMENT_OBJECT_GRAPH_INVALID = "ENVIRONMENT_OBJECT_GRAPH_INVALID";

const SHA256_DIGEST = /^[a-f0-9]{64}$/;

/**
 * Decide which document domains are authoritative for a persisted manifest.
 * Missing flags mean "hydrated template data" for backward compatibility.
 */
export function getEnvironmentApplyPolicy(manifest = {}, templateId = "blank") {
    const document = manifest.document ?? {};
    const roadsAuthored = manifest.roadsAuthored === true || document.roadsAuthored === true;
    const buildingsAuthored = manifest.buildingsAuthored === true || document.buildingsAuthored === true;
    const featuresAuthored = manifest.featuresAuthored === true || document.featuresAuthored === true;

    return {
        roadsAuthored,
        buildingsAuthored,
        featuresAuthored,
        rebuildRoads: templateId === "blank" || roadsAuthored,
        rebuildBuildings: buildingsAuthored,
        rebuildFeatures: featuresAuthored,
    };
}

export function isSha256Digest(value) {
    return typeof value === "string" && SHA256_DIGEST.test(value);
}

export function environmentRevisionOf(manifest) {
    if (manifest && Number.isInteger(manifest.revision) && manifest.revision >= 0) {
        return manifest.revision;
    }
    return 0;
}

/**
 * Present a stored environment for catalog, GET, and hashing.
 * v2 files keep their on-disk shape: revision 0 and null visual/evidence
 * references are implied, not injected, until the first guarded v3 save.
 */
export function presentStoredEnvironment(manifest, environmentId) {
    if (!manifest) return null;
    const schemaVersion = readSchemaVersion(manifest);
    const presented = {
        ...(schemaVersion >= ENVIRONMENT_SCHEMA_VERSION ? omitLegacyConcurrency(manifest) : { ...manifest }),
        environmentId: String(environmentId ?? manifest.environmentId ?? "").trim() || manifest.environmentId,
        schemaVersion,
    };
    if (schemaVersion >= ENVIRONMENT_SCHEMA_VERSION) {
        presented.revision = environmentRevisionOf(manifest);
        presented.visualLayer = normalizeVisualLayerReference(manifest.visualLayer);
        presented.evidence = normalizeHashReference(manifest.evidence, "evidence", "reportHash");
    } else {
        if (hasOwn(manifest, "revision")) presented.revision = environmentRevisionOf(manifest);
        if (hasOwn(manifest, "visualLayer")) {
            presented.visualLayer = normalizeVisualLayerReference(manifest.visualLayer);
        }
        if (hasOwn(manifest, "evidence")) {
            presented.evidence = normalizeHashReference(manifest.evidence, "evidence", "reportHash");
        }
    }
    if (schemaVersion >= ENVIRONMENT_OBJECT_SCHEMA_VERSION && Array.isArray(manifest.document?.objects)) {
        presented.document = {
            ...manifest.document,
            objects: sortObjectRecords(manifest.document.objects.map(normalizeObjectRecord)),
        };
    }
    return presented;
}

/**
 * Read view of the authoring object graph. v4 manifests return their stored
 * records; v2/v3 manifests derive the overlay in memory without rewriting.
 */
export function presentEnvironmentObjectGraph(manifest, registry = objectTypeRegistry, context = {}) {
    const document = manifest?.document ?? {};
    if (readSchemaVersion(manifest ?? {}) >= ENVIRONMENT_OBJECT_SCHEMA_VERSION && Array.isArray(document.objects)) {
        return reconcileObjectGraph(document, document.objects, registry, { sky: manifest?.sky, ...context }).records;
    }
    return deriveObjectGraph(document);
}

/**
 * Runtime view of a stored or authored environment. v2 documents surface as
 * revision 0 with null visual/evidence references without writing those keys
 * back into a v2 file.
 */
export function normalizeEnvironmentDocument(manifest = {}, environmentId = manifest.environmentId) {
    const presented = presentStoredEnvironment(manifest, environmentId) ?? {};
    return {
        ...presented,
        revision: environmentRevisionOf(presented),
        visualLayer: presented.visualLayer ?? null,
        evidence: presented.evidence ?? null,
    };
}

/** Copy storage-only visual references onto environment state. No meshes. */
export function applyEnvironmentVisualReferences(environment, manifest = {}) {
    if (!environment) return environment;
    environment.revision = environmentRevisionOf(manifest);
    environment.visualLayer = manifest.visualLayer ?? null;
    environment.evidence = manifest.evidence ?? null;
    return environment;
}

/**
 * Decide which schema a guarded write produces. The configured version is the
 * server default (v3 unless the v4 flag is set); a file already stored as v4
 * never downgrades, because rewriting it as v3 would drop the object graph.
 */
export function resolveEnvironmentWriteSchemaVersion(configured, current = null) {
    if (current && readSchemaVersion(current) >= ENVIRONMENT_OBJECT_SCHEMA_VERSION) {
        return ENVIRONMENT_OBJECT_SCHEMA_VERSION;
    }
    return Number(configured) === ENVIRONMENT_OBJECT_SCHEMA_VERSION
        ? ENVIRONMENT_OBJECT_SCHEMA_VERSION
        : ENVIRONMENT_SCHEMA_VERSION;
}

/**
 * Reject writes that would silently drop a stored object graph: the current
 * file is v4 with records, and the incoming manifest supplies a `document`
 * without an `objects` array (an old client) and the stored overlay carries
 * authored data. Writes that omit `document` entirely reuse the stored
 * document and pass. The check keys on the objects array rather than the
 * declared version because graph-aware browsers still declare v3.
 */
/**
 * True when a stored overlay carries information a graph-unaware write would
 * lose: groups, unknown types, renamed records, parents, tags, locks, hidden
 * flags, or group frames. A purely derived overlay (what the writer produces
 * for a v2/v3 document) can always be re-derived, so dropping it loses nothing.
 */
export function objectGraphHasAuthoredData(document, registry = objectTypeRegistry) {
    const stored = Array.isArray(document?.objects) ? document.objects.map(normalizeObjectRecord) : [];
    if (stored.length === 0) return false;
    const derived = new Map(deriveObjectGraph(document).map((record) => [record.id, record]));
    if (stored.length !== derived.size) return true;
    for (const record of stored) {
        const expected = derived.get(record.id);
        if (!expected) return true;
        if (!registry.get(record.typeId)) return true;
        if (record.typeId !== expected.typeId || record.typeVersion !== expected.typeVersion) return true;
        if (record.name !== expected.name) return true;
        if (record.parentId !== null && record.parentId !== undefined) return true;
        if (JSON.stringify(record.components) !== JSON.stringify(expected.components)) return true;
    }
    return false;
}

export function assertNoObjectGraphDowngrade(incoming, current, environmentId = current?.environmentId) {
    if (!current || readSchemaVersion(current) < ENVIRONMENT_OBJECT_SCHEMA_VERSION) return;
    const stored = current.document?.objects;
    if (!Array.isArray(stored) || stored.length === 0) return;
    const document = incoming?.document;
    if (document === undefined || document === null || typeof document !== "object") return;
    if (Array.isArray(document.objects)) return;
    // ED-02: a graph-unaware write only downgrades when authored overlay data
    // would be lost; a purely derived overlay is re-derived from the geometry.
    if (!objectGraphHasAuthoredData(current.document)) return;
    const error = new Error(
        `Environment "${environmentId}" stores a schema v4 object graph; writes must include document.objects.`,
    );
    error.code = ENVIRONMENT_SCHEMA_DOWNGRADE;
    error.statusCode = 409;
    error.storedSchemaVersion = readSchemaVersion(current);
    error.incomingSchemaVersion = readSchemaVersion(incoming ?? {});
    error.currentRevision = environmentRevisionOf(current);
    throw error;
}

function omitObjectGraph(document) {
    if (!document || typeof document !== "object") return document;
    const { objects: _objects, objectGraphVersion: _version, ...rest } = document;
    return rest;
}

/**
 * Attach a reconciled, validated object graph to a document being written as
 * v4. Incoming records win; legacy entities without a record gain one; records
 * whose legacy counterpart vanished are dropped; unknown types are preserved.
 */
function withObjectGraph(document, current, registry, context) {
    const base = document && typeof document === "object" ? { ...document } : {};
    const incoming = Array.isArray(base.objects)
        ? base.objects
        : Array.isArray(current?.document?.objects) ? current.document.objects : [];
    const { records } = reconcileObjectGraph(base, incoming, registry, context);
    const validation = validateObjectGraph({ ...base, objects: records }, registry, context);
    if (!validation.ok) {
        const first = validation.issues.find((entry) => entry.severity === "error");
        const error = new Error(`Environment object graph is invalid: ${first.message}`);
        error.code = ENVIRONMENT_OBJECT_GRAPH_INVALID;
        error.statusCode = 400;
        error.issues = validation.issues;
        throw error;
    }
    return { ...omitObjectGraph(base), objectGraphVersion: OBJECT_GRAPH_VERSION, objects: records };
}

/** Legacy name for the default (v3) writer; sticky v4 files still stay v4. */
export function serializeEnvironmentManifestV3(manifest, options = {}) {
    return serializeEnvironmentManifest(manifest, { ...options, schemaVersion: ENVIRONMENT_SCHEMA_VERSION });
}

/**
 * Serialize the canonical document written to disk. `schemaVersion` is the
 * configured write target (3 or 4); see `resolveEnvironmentWriteSchemaVersion`.
 */
export function serializeEnvironmentManifest(manifest, {
    environmentId,
    revision,
    current = null,
    schemaVersion = ENVIRONMENT_SCHEMA_VERSION,
    registry = objectTypeRegistry,
} = {}) {
    const id = String(environmentId ?? manifest.environmentId ?? "").trim();
    if (!id) throw new Error("Environment id is required.");
    if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== null) {
        const version = Number(manifest.schemaVersion);
        if (!ENVIRONMENT_SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
            throw new Error(`Unsupported environment schema version ${manifest.schemaVersion}.`);
        }
    }
    const target = resolveEnvironmentWriteSchemaVersion(schemaVersion, current);
    const now = new Date().toISOString();
    const visualLayer = resolveVisualLayerField(manifest, current);
    const evidence = visualLayer == null && !hasOwn(manifest, "evidence")
        ? null
        : resolveReferenceField(manifest, current, "evidence", "reportHash");
    const source = manifest.document ?? current?.document ?? null;
    const document = target >= ENVIRONMENT_OBJECT_SCHEMA_VERSION
        ? withObjectGraph(source, current, registry, { sky: manifest.sky ?? current?.sky ?? null })
        : omitObjectGraph(source);
    return omitLegacyConcurrency({
        ...manifest,
        environmentId: id,
        name: String(manifest.name ?? current?.name ?? id).trim() || id,
        schemaVersion: target,
        revision,
        templateId: manifest.templateId
            ?? current?.templateId
            ?? (id === "igvc" ? "igvc" : "blank"),
        roadStylePreset: manifest.roadStylePreset
            ?? current?.roadStylePreset
            ?? (id === "igvc" ? "igvc" : "default"),
        roadsAuthored: manifest.roadsAuthored ?? current?.roadsAuthored ?? false,
        buildingsAuthored: manifest.buildingsAuthored ?? current?.buildingsAuthored ?? false,
        featuresAuthored: manifest.featuresAuthored ?? current?.featuresAuthored ?? false,
        visualLayer,
        evidence,
        document: document && typeof document === "object"
            ? { ...document, environmentId: document.environmentId ?? id }
            : document,
        createdAt: current?.createdAt ?? manifest.createdAt ?? now,
        updatedAt: now,
    });
}

export function parseEnvironmentWriteEnvelope(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        const error = new Error("Environment writes require { manifest, expectedRevision }.");
        error.code = ENVIRONMENT_UNGUARDED_WRITE;
        error.statusCode = 400;
        throw error;
    }
    if (!Object.hasOwn(body, "manifest")) {
        const error = new Error("Unguarded environment writes are not accepted. Send { manifest, expectedRevision }.");
        error.code = ENVIRONMENT_UNGUARDED_WRITE;
        error.statusCode = 400;
        throw error;
    }
    return {
        manifest: body.manifest,
        expectedRevision: body.expectedRevision,
        detachStaleVisual: body.detachStaleVisual === true,
    };
}

export function assertExpectedRevision(expectedRevision, currentRevision, label = "Environment") {
    const current = Number.isInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        const error = new Error(`${label} revision conflict: expectedRevision is required.`);
        error.code = ENVIRONMENT_REVISION_CONFLICT;
        error.statusCode = 409;
        error.currentRevision = current;
        throw error;
    }
    if (expectedRevision !== current) {
        const error = new Error(
            `${label} revision conflict: expected ${expectedRevision}, current revision is ${current}.`,
        );
        error.code = ENVIRONMENT_REVISION_CONFLICT;
        error.statusCode = 409;
        error.currentRevision = current;
        throw error;
    }
    return current;
}

export function environmentSummaryFields(manifest, { builtIn = false, fallbackName = null } = {}) {
    const id = manifest.environmentId;
    return {
        id,
        name: String(manifest.name ?? fallbackName ?? id).trim() || String(fallbackName ?? id),
        templateId: manifest.templateId ?? (id === "igvc" ? "igvc" : "blank"),
        builtIn,
        revision: environmentRevisionOf(manifest),
        updatedAt: manifest.updatedAt ?? null,
    };
}

export function readSchemaVersion(manifest) {
    if (manifest?.schemaVersion === undefined || manifest?.schemaVersion === null) {
        return ENVIRONMENT_LEGACY_SCHEMA_VERSION;
    }
    const version = Number(manifest.schemaVersion);
    if (ENVIRONMENT_SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
        return version;
    }
    throw new Error(`Unsupported environment schema version ${manifest.schemaVersion}.`);
}

export function isVisualLayerMaterializable(value) {
    return Boolean(value?.descriptorHash && value?.accessHash);
}

export function normalizeVisualLayerReference(value, field = "visualLayer") {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Environment ${field} must be null or { descriptorHash [, accessHash] [, bakeReuseManifestHash] }.`);
    }
    const keys = Object.keys(value);
    const allowed = keys.every((key) => (
        key === "descriptorHash" || key === "accessHash" || key === "bakeReuseManifestHash"
    ));
    if (!allowed || !keys.includes("descriptorHash")) {
        throw new Error(`Environment ${field} must be null or { descriptorHash [, accessHash] [, bakeReuseManifestHash] }.`);
    }
    const descriptorHash = value.descriptorHash;
    if (!isSha256Digest(descriptorHash)) {
        throw new Error(`Environment ${field}.descriptorHash must be a lowercase SHA-256 digest.`);
    }
    const result = { descriptorHash };
    if (keys.includes("accessHash")) {
        if (!isSha256Digest(value.accessHash)) {
            throw new Error(`Environment ${field}.accessHash must be a lowercase SHA-256 digest.`);
        }
        result.accessHash = value.accessHash;
    }
    if (keys.includes("bakeReuseManifestHash")) {
        if (!result.accessHash) {
            throw new Error(`Environment ${field}.bakeReuseManifestHash requires accessHash.`);
        }
        if (!isSha256Digest(value.bakeReuseManifestHash)) {
            throw new Error(`Environment ${field}.bakeReuseManifestHash must be a lowercase SHA-256 digest.`);
        }
        result.bakeReuseManifestHash = value.bakeReuseManifestHash;
    }
    return result;
}

function resolveVisualLayerField(manifest, current) {
    if (hasOwn(manifest, "visualLayer")) {
        const incoming = normalizeVisualLayerReference(manifest.visualLayer);
        const existing = current && hasOwn(current, "visualLayer")
            ? normalizeVisualLayerReference(current.visualLayer)
            : null;
        if (incoming && !incoming.accessHash && existing?.accessHash) {
            if (existing.descriptorHash === incoming.descriptorHash) {
                const preserved = {
                    descriptorHash: existing.descriptorHash,
                    accessHash: existing.accessHash,
                };
                if (existing.bakeReuseManifestHash) {
                    preserved.bakeReuseManifestHash = existing.bakeReuseManifestHash;
                }
                return preserved;
            }
            const error = new Error(
                "Environment visualLayer descriptor replacement requires a matching accessHash.",
            );
            error.code = "VISUAL_LAYER_ACCESS_REQUIRED";
            error.statusCode = 409;
            throw error;
        }
        if (incoming && incoming.accessHash && !incoming.bakeReuseManifestHash && existing?.bakeReuseManifestHash) {
            if (
                existing.descriptorHash === incoming.descriptorHash
                && existing.accessHash === incoming.accessHash
            ) {
                return {
                    descriptorHash: existing.descriptorHash,
                    accessHash: existing.accessHash,
                    bakeReuseManifestHash: existing.bakeReuseManifestHash,
                };
            }
        }
        return incoming;
    }
    if (current && hasOwn(current, "visualLayer")) {
        return normalizeVisualLayerReference(current.visualLayer);
    }
    return null;
}

function normalizeHashReference(value, field, hashKey) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Environment ${field} must be null or { ${hashKey} }.`);
    }
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== hashKey) {
        throw new Error(`Environment ${field} must be null or { ${hashKey} }.`);
    }
    const digest = value[hashKey];
    if (!isSha256Digest(digest)) {
        throw new Error(`Environment ${field}.${hashKey} must be a lowercase SHA-256 digest.`);
    }
    return { [hashKey]: digest };
}

function resolveReferenceField(manifest, current, field, hashKey) {
    if (hasOwn(manifest, field)) {
        return normalizeHashReference(manifest[field], field, hashKey);
    }
    if (current && hasOwn(current, field)) {
        return normalizeHashReference(current[field], field, hashKey);
    }
    return null;
}

function omitLegacyConcurrency(manifest) {
    if (!manifest || typeof manifest !== "object") return {};
    const { clientRevision: _ignored, ...rest } = manifest;
    return rest;
}

function hasOwn(value, key) {
    return Boolean(value) && Object.hasOwn(value, key);
}
