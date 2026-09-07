export const ENVIRONMENT_REVISION_CONFLICT = "ENVIRONMENT_REVISION_CONFLICT";
export const ENVIRONMENT_UNGUARDED_WRITE = "ENVIRONMENT_UNGUARDED_WRITE";

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
