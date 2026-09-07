/**
 * Environment document schema and apply policy.
 *
 * Schema v2 is the legacy authoring shape. Schema v3 adds a server-owned
 * revision and optional content-addressed visual/evidence references. Those
 * reference fields are storage-only: loaders must not materialize them into
 * measured scenes, and they must not enter `worldHash`.
 */

export const ENVIRONMENT_SCHEMA_VERSION = 3;
export const ENVIRONMENT_LEGACY_SCHEMA_VERSION = 2;
export const ENVIRONMENT_REVISION_CONFLICT = "ENVIRONMENT_REVISION_CONFLICT";
export const ENVIRONMENT_UNGUARDED_WRITE = "ENVIRONMENT_UNGUARDED_WRITE";

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
        presented.visualLayer = normalizeHashReference(manifest.visualLayer, "visualLayer", "descriptorHash");
        presented.evidence = normalizeHashReference(manifest.evidence, "evidence", "reportHash");
    } else {
        if (hasOwn(manifest, "revision")) presented.revision = environmentRevisionOf(manifest);
        if (hasOwn(manifest, "visualLayer")) {
            presented.visualLayer = normalizeHashReference(manifest.visualLayer, "visualLayer", "descriptorHash");
        }
        if (hasOwn(manifest, "evidence")) {
            presented.evidence = normalizeHashReference(manifest.evidence, "evidence", "reportHash");
        }
    }
    return presented;
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

/** Serialize the canonical v3 document written to disk. */
export function serializeEnvironmentManifestV3(manifest, {
    environmentId,
    revision,
    current = null,
} = {}) {
    const id = String(environmentId ?? manifest.environmentId ?? "").trim();
    if (!id) throw new Error("Environment id is required.");
    if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== null) {
        const version = Number(manifest.schemaVersion);
        if (version !== 2 && version !== ENVIRONMENT_SCHEMA_VERSION) {
            throw new Error(`Unsupported environment schema version ${manifest.schemaVersion}.`);
        }
    }
    const now = new Date().toISOString();
    const visualLayer = resolveReferenceField(
        manifest,
        current,
        "visualLayer",
        "descriptorHash",
    );
    const evidence = visualLayer == null && !hasOwn(manifest, "evidence")
        ? null
        : resolveReferenceField(manifest, current, "evidence", "reportHash");
    const document = manifest.document ?? current?.document ?? null;
    return omitLegacyConcurrency({
        ...manifest,
        environmentId: id,
        name: String(manifest.name ?? current?.name ?? id).trim() || id,
        schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
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

function readSchemaVersion(manifest) {
    if (manifest?.schemaVersion === undefined || manifest?.schemaVersion === null) {
        return ENVIRONMENT_LEGACY_SCHEMA_VERSION;
    }
    const version = Number(manifest.schemaVersion);
    if (version === ENVIRONMENT_LEGACY_SCHEMA_VERSION || version === ENVIRONMENT_SCHEMA_VERSION) {
        return version;
    }
    throw new Error(`Unsupported environment schema version ${manifest.schemaVersion}.`);
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
