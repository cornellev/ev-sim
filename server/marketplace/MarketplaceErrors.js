export const MARKETPLACE_ERROR_CODES = Object.freeze({
    SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
    SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
    SOURCE_UNTRUSTED: "SOURCE_UNTRUSTED",
    METADATA_EXPIRED: "METADATA_EXPIRED",
    SIGNATURE_INVALID: "SIGNATURE_INVALID",
    ARTIFACT_HASH_MISMATCH: "ARTIFACT_HASH_MISMATCH",
    INCOMPATIBLE: "INCOMPATIBLE",
    RIGHTS_DENIED: "RIGHTS_DENIED",
    CONFLICT: "CONFLICT",
    LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
    RELEASE_YANKED: "RELEASE_YANKED",
    RELEASE_BLOCKED: "RELEASE_BLOCKED",
    CANCELLED: "CANCELLED",
    RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
    DOCUMENT_INVALID: "DOCUMENT_INVALID",
    UNSUPPORTED_SCHEMA: "UNSUPPORTED_SCHEMA",
    CONFIG_INVALID: "CONFIG_INVALID",
    AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
    UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
});

export class MarketplaceError extends Error {
    constructor(code, message, { path = null, cause = null } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = "MarketplaceError";
        this.code = code;
        this.path = path;
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            ...(this.path ? { path: this.path } : {}),
        };
    }
}

export function marketplaceError(code, message, fields = {}) {
    return new MarketplaceError(code, message, fields);
}
