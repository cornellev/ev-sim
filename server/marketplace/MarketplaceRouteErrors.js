import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "./MarketplaceErrors.js";
import {
    BAKE_PROMOTION_ERROR_CODES,
    EDITOR_ASSET_ERROR_CODES,
    ENVIRONMENT_ERROR_CODES,
    RUN_PACKAGE_ERROR_CODES,
    StorageHttpError,
    VISUAL_ASSET_ERROR_CODES,
    VISUAL_LAYER_ERROR_CODES,
} from "../storage/StorageErrors.js";

const DOCUMENT_INVALID = MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID;
const SOURCE_NOT_FOUND = MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND;
const RIGHTS_DENIED = MARKETPLACE_ERROR_CODES.RIGHTS_DENIED;
const LIMIT_EXCEEDED = MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED;
const ARTIFACT_HASH_MISMATCH = MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH;

// Authoring failures use codes whose client text is the server message.
// CONFLICT is reserved for marketplace revision races and is rewritten in the UI.
const STORAGE_PUBLIC_CODES = Object.freeze({
    [VISUAL_LAYER_ERROR_CODES.WORLD_MISMATCH]: DOCUMENT_INVALID,
    [VISUAL_LAYER_ERROR_CODES.ACCESS_NOT_FOUND]: SOURCE_NOT_FOUND,
    [VISUAL_LAYER_ERROR_CODES.DESCRIPTOR_NOT_FOUND]: SOURCE_NOT_FOUND,
    [VISUAL_LAYER_ERROR_CODES.ACCESS_MISMATCH]: DOCUMENT_INVALID,
    [VISUAL_LAYER_ERROR_CODES.ACCESS_REQUIRED]: DOCUMENT_INVALID,
    [VISUAL_LAYER_ERROR_CODES.INVALID_ACCESS]: DOCUMENT_INVALID,
    [VISUAL_LAYER_ERROR_CODES.RIGHTS_DENIED]: RIGHTS_DENIED,
    [VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED]: RIGHTS_DENIED,
    [VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND]: SOURCE_NOT_FOUND,
    [VISUAL_ASSET_ERROR_CODES.INVALID_METADATA]: DOCUMENT_INVALID,
    [VISUAL_ASSET_ERROR_CODES.INVALID_MEDIA]: DOCUMENT_INVALID,
    [VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH]: DOCUMENT_INVALID,
    [VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE]: LIMIT_EXCEEDED,
    [VISUAL_ASSET_ERROR_CODES.QUOTA_EXCEEDED]: LIMIT_EXCEEDED,
    [VISUAL_ASSET_ERROR_CODES.CONFLICT]: DOCUMENT_INVALID,
    [VISUAL_ASSET_ERROR_CODES.CORRUPT]: ARTIFACT_HASH_MISMATCH,
    [EDITOR_ASSET_ERROR_CODES.NOT_FOUND]: SOURCE_NOT_FOUND,
    [EDITOR_ASSET_ERROR_CODES.INVALID]: DOCUMENT_INVALID,
    [EDITOR_ASSET_ERROR_CODES.REVISION_CONFLICT]: DOCUMENT_INVALID,
    [EDITOR_ASSET_ERROR_CODES.IMMUTABLE_CONFLICT]: DOCUMENT_INVALID,
    [EDITOR_ASSET_ERROR_CODES.FOLDER_NOT_EMPTY]: DOCUMENT_INVALID,
    [ENVIRONMENT_ERROR_CODES.REVISION_CONFLICT]: DOCUMENT_INVALID,
    [ENVIRONMENT_ERROR_CODES.OBJECT_GRAPH_INVALID]: DOCUMENT_INVALID,
    [ENVIRONMENT_ERROR_CODES.SCHEMA_DOWNGRADE]: DOCUMENT_INVALID,
    [ENVIRONMENT_ERROR_CODES.OBJECT_TYPE_UNSUPPORTED]: DOCUMENT_INVALID,
    [BAKE_PROMOTION_ERROR_CODES.INVALID]: DOCUMENT_INVALID,
    [BAKE_PROMOTION_ERROR_CODES.STALE]: DOCUMENT_INVALID,
    [BAKE_PROMOTION_ERROR_CODES.INCOMPLETE]: DOCUMENT_INVALID,
    [BAKE_PROMOTION_ERROR_CODES.BINDING_MISMATCH]: DOCUMENT_INVALID,
    [BAKE_PROMOTION_ERROR_CODES.HASH_MISMATCH]: ARTIFACT_HASH_MISMATCH,
    [BAKE_PROMOTION_ERROR_CODES.RIGHTS_DENIED]: RIGHTS_DENIED,
    [BAKE_PROMOTION_ERROR_CODES.NOT_FOUND]: SOURCE_NOT_FOUND,
    [BAKE_PROMOTION_ERROR_CODES.REUSE_UNAUTHORIZED]: RIGHTS_DENIED,
    [BAKE_PROMOTION_ERROR_CODES.OUTPUT_SOURCE_MISSING]: RIGHTS_DENIED,
    [BAKE_PROMOTION_ERROR_CODES.NOOP_INVALID]: DOCUMENT_INVALID,
    [BAKE_PROMOTION_ERROR_CODES.GENERATION_CONFLICT]: DOCUMENT_INVALID,
    [RUN_PACKAGE_ERROR_CODES.INVALID]: DOCUMENT_INVALID,
    [RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH]: DOCUMENT_INVALID,
    [RUN_PACKAGE_ERROR_CODES.RIGHTS_DENIED]: RIGHTS_DENIED,
    [RUN_PACKAGE_ERROR_CODES.TOO_LARGE]: LIMIT_EXCEEDED,
});

const ENVIRONMENT_EXPORT_NOT_FOUND = Object.freeze([
    /^Saved environment "[^"]+" was not found\.$/u,
    /^Visual layer descriptor [a-f0-9]{64} is missing\.$/u,
]);

const ENVIRONMENT_EXPORT_INVALID = Object.freeze([
    /^Marketplace environment export requires a saved schema-v4 environment\.$/u,
]);

function safeAuthoringMessage(message) {
    if (typeof message !== "string" || message.length < 1 || message.length > 400) return null;
    if (/[\r\n]/u.test(message) || message.includes("/") || message.includes("\\")) return null;
    if (/bearer|token|secret|password|credential/iu.test(message)) return null;
    return message;
}

function authoringMarketplaceError(error) {
    if (error instanceof StorageHttpError) {
        const code = STORAGE_PUBLIC_CODES[error.code];
        const message = safeAuthoringMessage(error.message);
        if (!code || !message) return null;
        return marketplaceError(code, message, { cause: error });
    }
    const message = safeAuthoringMessage(error?.message);
    if (!message || !(error instanceof Error)) return null;
    if (error instanceof TypeError) return marketplaceError(DOCUMENT_INVALID, message, { cause: error });
    if (ENVIRONMENT_EXPORT_NOT_FOUND.some((pattern) => pattern.test(message))) {
        return marketplaceError(SOURCE_NOT_FOUND, message, { cause: error });
    }
    if (ENVIRONMENT_EXPORT_INVALID.some((pattern) => pattern.test(message))) {
        return marketplaceError(DOCUMENT_INVALID, message, { cause: error });
    }
    return null;
}

export function publicMarketplaceError(error) {
    if (error instanceof MarketplaceError && error.code === MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED) {
        return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace local state requires recovery.");
    }
    if (error instanceof MarketplaceError) return error;
    if (error?.type === "entity.too.large") {
        return marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, "Marketplace request body exceeds 32 KiB.");
    }
    if (error instanceof SyntaxError && Object.hasOwn(error, "body")) {
        return marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Marketplace request body is not valid JSON.");
    }
    return authoringMarketplaceError(error)
        ?? marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace request failed.");
}
