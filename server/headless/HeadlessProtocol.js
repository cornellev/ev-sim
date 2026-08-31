import { canonicalStringify } from "../../app/simulation/RunManifest.js";

export const HEADLESS_PROTOCOL = Object.freeze({ major: 1, minor: 2 });

export const ERROR_CODE = Object.freeze({
    OK: 0,
    INVALID_REQUEST: 1,
    PROTOCOL_MISMATCH: 2,
    BUNDLE_INVALID: 3,
    BUNDLE_HASH_MISMATCH: 4,
    INCOMPATIBLE_SPACE: 5,
    UNSUPPORTED_CAPABILITY: 6,
    BATCH_NOT_FOUND: 7,
    ENVIRONMENT_NOT_FOUND: 8,
    EPISODE_TERMINAL: 9,
    RESOURCE_LIMIT: 10,
    STEP_TIMEOUT: 11,
    WORKER_CRASHED: 12,
    ARTIFACT_FAILURE: 13,
    INTERNAL: 14,
});

const RETRYABLE = new Set(["RESOURCE_LIMIT", "STEP_TIMEOUT", "WORKER_CRASHED"]);

export function protocolError(version) {
    const major = Number(version?.major ?? 0);
    const minor = Number(version?.minor ?? 0);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 0 || minor < 0
        || major !== HEADLESS_PROTOCOL.major || minor > HEADLESS_PROTOCOL.minor) {
        const error = new Error(
            `Protocol ${major}.${minor} is incompatible with ${HEADLESS_PROTOCOL.major}.${HEADLESS_PROTOCOL.minor}.`,
        );
        error.code = "PROTOCOL_MISMATCH";
        return error;
    }
    return null;
}

export function okStatus() {
    return { code: ERROR_CODE.OK, message: "", retryable: false, canonicalDetailJson: Buffer.alloc(0) };
}

export function errorStatus(error, fallbackCode = "INTERNAL") {
    const codeName = Object.hasOwn(ERROR_CODE, error?.code) ? error.code : fallbackCode;
    const details = error?.details ?? null;
    return {
        code: ERROR_CODE[codeName] ?? ERROR_CODE.INTERNAL,
        message: String(error?.message || "Internal supervisor failure."),
        retryable: RETRYABLE.has(codeName),
        canonicalDetailJson: details === null ? Buffer.alloc(0) : Buffer.from(canonicalStringify(details)),
    };
}

export function supervisorError(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

export function infrastructureResult(environmentIndex, error) {
    return { environmentIndex, error: errorStatus(error) };
}
