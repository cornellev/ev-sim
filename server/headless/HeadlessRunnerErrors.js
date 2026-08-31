export class HeadlessRunnerError extends Error {
    constructor(code, message, details = null, options = {}) {
        super(message, options);
        this.name = "HeadlessRunnerError";
        this.code = code;
        this.details = details;
    }
}

export function runnerError(code, message, details = null, options = {}) {
    return new HeadlessRunnerError(code, message, details, options);
}
