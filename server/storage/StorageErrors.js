export const ENVIRONMENT_REVISION_CONFLICT = "ENVIRONMENT_REVISION_CONFLICT";
export const ENVIRONMENT_UNGUARDED_WRITE = "ENVIRONMENT_UNGUARDED_WRITE";

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

const VISUAL_ASSET_STATUS = Object.freeze({
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
