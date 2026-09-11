export const ENVIRONMENT_REVISION_CONFLICT = "ENVIRONMENT_REVISION_CONFLICT";
export const ENVIRONMENT_UNGUARDED_WRITE = "ENVIRONMENT_UNGUARDED_WRITE";
export const ENVIRONMENT_SCHEMA_DOWNGRADE = "ENVIRONMENT_SCHEMA_DOWNGRADE";
export const ENVIRONMENT_OBJECT_GRAPH_INVALID = "ENVIRONMENT_OBJECT_GRAPH_INVALID";
export const ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED = "ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED";

export const ENVIRONMENT_ERROR_CODES = Object.freeze({
    REVISION_CONFLICT: ENVIRONMENT_REVISION_CONFLICT,
    UNGUARDED_WRITE: ENVIRONMENT_UNGUARDED_WRITE,
    SCHEMA_DOWNGRADE: ENVIRONMENT_SCHEMA_DOWNGRADE,
    OBJECT_GRAPH_INVALID: ENVIRONMENT_OBJECT_GRAPH_INVALID,
    OBJECT_TYPE_UNSUPPORTED: ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED,
});

export const VISUAL_LAYER_ERROR_CODES = Object.freeze({
    INVALID_ACCESS: "VISUAL_LAYER_INVALID_ACCESS",
    ACCESS_NOT_FOUND: "VISUAL_LAYER_ACCESS_NOT_FOUND",
    DESCRIPTOR_NOT_FOUND: "VISUAL_LAYER_DESCRIPTOR_NOT_FOUND",
    ACCESS_MISMATCH: "VISUAL_LAYER_ACCESS_MISMATCH",
    ACCESS_REQUIRED: "VISUAL_LAYER_ACCESS_REQUIRED",
    RIGHTS_DENIED: "VISUAL_LAYER_RIGHTS_DENIED",
    WORLD_MISMATCH: "VISUAL_LAYER_WORLD_MISMATCH",
});

export const BAKE_PROMOTION_ERROR_CODES = Object.freeze({
    INVALID: "BAKE_PROMOTION_INVALID",
    GENERATION_CONFLICT: "BAKE_PROMOTION_GENERATION_CONFLICT",
    STALE: "BAKE_PROMOTION_STALE",
    BINDING_MISMATCH: "BAKE_PROMOTION_BINDING_MISMATCH",
    OUTPUT_SOURCE_MISSING: "BAKE_PROMOTION_OUTPUT_SOURCE_MISSING",
    HASH_MISMATCH: "BAKE_PROMOTION_HASH_MISMATCH",
    INCOMPLETE: "BAKE_PROMOTION_INCOMPLETE",
    RIGHTS_DENIED: "BAKE_PROMOTION_RIGHTS_DENIED",
    NOT_FOUND: "BAKE_PROMOTION_NOT_FOUND",
    REUSE_UNAUTHORIZED: "BAKE_PROMOTION_REUSE_UNAUTHORIZED",
    NOOP_INVALID: "BAKE_PROMOTION_NOOP_INVALID",
    RECOVERY_CONFLICT: "BAKE_PROMOTION_RECOVERY_CONFLICT",
});

export const VISUAL_ASSET_ERROR_CODES = Object.freeze({
    INVALID_METADATA: "VISUAL_ASSET_INVALID_METADATA",
    INVALID_MEDIA: "VISUAL_ASSET_INVALID_MEDIA",
    INVALID_GRAPH: "VISUAL_ASSET_INVALID_GRAPH",
    RIGHTS_DENIED: "VISUAL_ASSET_RIGHTS_DENIED",
    CONFLICT: "VISUAL_ASSET_CONFLICT",
    REQUEST_TOO_LARGE: "VISUAL_ASSET_REQUEST_TOO_LARGE",
    QUOTA_EXCEEDED: "VISUAL_ASSET_QUOTA_EXCEEDED",
    USE_NOT_FOUND: "VISUAL_ASSET_USE_NOT_FOUND",
    UPLOAD_NOT_FOUND: "VISUAL_ASSET_UPLOAD_NOT_FOUND",
    RANGE_NOT_SATISFIABLE: "VISUAL_ASSET_RANGE_NOT_SATISFIABLE",
    CORRUPT: "VISUAL_ASSET_CORRUPT",
    DELETION_DISABLED: "VISUAL_ASSET_DELETION_DISABLED",
    DISK_FULL: "VISUAL_ASSET_DISK_FULL",
    SHORT_WRITE: "VISUAL_ASSET_SHORT_WRITE",
    SYMLINK: "VISUAL_ASSET_SYMLINK",
    VALIDATION_TIMEOUT: "VISUAL_ASSET_VALIDATION_TIMEOUT",
});

export const RUN_PACKAGE_ERROR_CODES = Object.freeze({
    HOSTILE: "RUN_PACKAGE_HOSTILE",
    INVALID: "RUN_PACKAGE_INVALID",
    CLOSURE_MISMATCH: "RUN_PACKAGE_CLOSURE_MISMATCH",
    RIGHTS_DENIED: "RUN_PACKAGE_RIGHTS_DENIED",
    TOO_LARGE: "RUN_PACKAGE_TOO_LARGE",
    TIMEOUT: "RUN_PACKAGE_TIMEOUT",
    IO: "RUN_PACKAGE_IO",
});

const VISUAL_ASSET_STATUS = Object.freeze({
    ENVIRONMENT_REVISION_CONFLICT: 409,
    ENVIRONMENT_UNGUARDED_WRITE: 400,
    ENVIRONMENT_SCHEMA_DOWNGRADE: 409,
    ENVIRONMENT_OBJECT_GRAPH_INVALID: 400,
    ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED: 400,
    VISUAL_ASSET_INVALID_METADATA: 400,
    VISUAL_ASSET_INVALID_MEDIA: 400,
    VISUAL_ASSET_INVALID_GRAPH: 400,
    VISUAL_ASSET_RIGHTS_DENIED: 403,
    VISUAL_ASSET_CONFLICT: 409,
    VISUAL_ASSET_REQUEST_TOO_LARGE: 413,
    VISUAL_ASSET_QUOTA_EXCEEDED: 507,
    VISUAL_ASSET_USE_NOT_FOUND: 404,
    VISUAL_ASSET_UPLOAD_NOT_FOUND: 404,
    VISUAL_ASSET_RANGE_NOT_SATISFIABLE: 416,
    VISUAL_ASSET_CORRUPT: 409,
    VISUAL_ASSET_DELETION_DISABLED: 405,
    VISUAL_ASSET_DISK_FULL: 507,
    VISUAL_ASSET_SHORT_WRITE: 500,
    VISUAL_ASSET_SYMLINK: 400,
    VISUAL_ASSET_VALIDATION_TIMEOUT: 503,
    RUN_PACKAGE_HOSTILE: 400,
    RUN_PACKAGE_INVALID: 400,
    RUN_PACKAGE_CLOSURE_MISMATCH: 400,
    RUN_PACKAGE_RIGHTS_DENIED: 403,
    RUN_PACKAGE_TOO_LARGE: 413,
    RUN_PACKAGE_TIMEOUT: 503,
    RUN_PACKAGE_IO: 500,
    VISUAL_LAYER_INVALID_ACCESS: 400,
    VISUAL_LAYER_ACCESS_NOT_FOUND: 404,
    VISUAL_LAYER_DESCRIPTOR_NOT_FOUND: 404,
    VISUAL_LAYER_ACCESS_MISMATCH: 409,
    VISUAL_LAYER_ACCESS_REQUIRED: 409,
    VISUAL_LAYER_RIGHTS_DENIED: 403,
    VISUAL_LAYER_WORLD_MISMATCH: 409,
    BAKE_PROMOTION_INVALID: 400,
    BAKE_PROMOTION_GENERATION_CONFLICT: 409,
    BAKE_PROMOTION_STALE: 409,
    BAKE_PROMOTION_BINDING_MISMATCH: 409,
    BAKE_PROMOTION_OUTPUT_SOURCE_MISSING: 403,
    BAKE_PROMOTION_HASH_MISMATCH: 409,
    BAKE_PROMOTION_INCOMPLETE: 400,
    BAKE_PROMOTION_RIGHTS_DENIED: 403,
    BAKE_PROMOTION_NOT_FOUND: 404,
    BAKE_PROMOTION_REUSE_UNAUTHORIZED: 409,
    BAKE_PROMOTION_NOOP_INVALID: 409,
    BAKE_PROMOTION_RECOVERY_CONFLICT: 409,
});

export class StorageHttpError extends Error {
    constructor(message, { statusCode = 400, code = null, currentRevision = undefined } = {}) {
        super(message);
        this.name = "StorageHttpError";
        this.statusCode = statusCode;
        this.code = code;
        this.currentRevision = currentRevision;
    }

    toJSON() {
        const payload = { error: this.message };
        if (this.code) payload.code = this.code;
        if (this.currentRevision !== undefined) payload.currentRevision = this.currentRevision;
        return payload;
    }
}

export function environmentRevisionConflict(expectedRevision, currentRevision, label = "Environment") {
    const current = Number.isInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0;
    const message = !Number.isInteger(expectedRevision) || expectedRevision < 0
        ? `${label} revision conflict: expectedRevision is required.`
        : `${label} revision conflict: expected ${expectedRevision}, current revision is ${current}.`;
    return new StorageHttpError(message, {
        statusCode: 409,
        code: ENVIRONMENT_REVISION_CONFLICT,
        currentRevision: current,
    });
}

export function unguardedEnvironmentWriteError() {
    return new StorageHttpError(
        "Unguarded environment writes are not accepted. Send { manifest, expectedRevision }.",
        { statusCode: 400, code: ENVIRONMENT_UNGUARDED_WRITE },
    );
}

/**
 * A stored schema-v4 environment cannot be overwritten by a manifest that
 * lacks its object graph; accepting it would silently drop authored data.
 */
export function environmentSchemaDowngradeError({
    message,
    storedSchemaVersion = 4,
    incomingSchemaVersion = null,
    currentRevision = undefined,
} = {}) {
    const error = new StorageHttpError(
        message ?? "Environment stores a schema v4 object graph; writes must include document.objects.",
        { statusCode: 409, code: ENVIRONMENT_SCHEMA_DOWNGRADE, currentRevision },
    );
    error.storedSchemaVersion = storedSchemaVersion;
    error.incomingSchemaVersion = incomingSchemaVersion;
    const original = error.toJSON.bind(error);
    error.toJSON = () => ({
        ...original(),
        storedSchemaVersion,
        incomingSchemaVersion,
    });
    return error;
}

export function environmentObjectGraphInvalidError(issues = [], message = null) {
    const first = issues.find((entry) => entry.severity === "error") ?? issues[0];
    const error = new StorageHttpError(
        message ?? (first ? `Environment object graph is invalid: ${first.message}` : "Environment object graph is invalid."),
        { statusCode: 400, code: ENVIRONMENT_OBJECT_GRAPH_INVALID },
    );
    error.issues = issues;
    const original = error.toJSON.bind(error);
    error.toJSON = () => ({ ...original(), issues });
    return error;
}

export function environmentObjectTypeUnsupportedError(typeId, known = []) {
    const error = new StorageHttpError(
        `Unknown object type "${typeId}". Valid: ${known.join(", ")}`,
        { statusCode: 400, code: ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED },
    );
    error.typeId = typeId;
    error.known = [...known];
    const original = error.toJSON.bind(error);
    error.toJSON = () => ({ ...original(), typeId, known: [...known] });
    return error;
}

/** Convert a shared-policy error (plain Error with `code`) into its HTTP form. */
export function environmentPolicyError(error) {
    if (error instanceof StorageHttpError) return error;
    switch (error?.code) {
        case ENVIRONMENT_UNGUARDED_WRITE:
            return unguardedEnvironmentWriteError();
        case ENVIRONMENT_REVISION_CONFLICT:
            return environmentRevisionConflict(undefined, error.currentRevision);
        case ENVIRONMENT_SCHEMA_DOWNGRADE:
            return environmentSchemaDowngradeError(error);
        case ENVIRONMENT_OBJECT_GRAPH_INVALID:
            return environmentObjectGraphInvalidError(error.issues ?? [], error.message);
        default:
            return error;
    }
}

export function visualAssetError(code, message, { statusCode, headers, denials } = {}) {
    const error = new StorageHttpError(message, {
        statusCode: statusCode ?? VISUAL_ASSET_STATUS[code] ?? 400,
        code,
    });
    if (headers) error.headers = headers;
    if (denials) error.denials = denials;
    const original = error.toJSON.bind(error);
    error.toJSON = () => {
        const payload = original();
        if (denials) payload.denials = denials;
        return payload;
    };
    return error;
}
