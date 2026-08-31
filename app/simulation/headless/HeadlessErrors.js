export class HeadlessEpisodeError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "HeadlessEpisodeError";
        this.code = code;
        this.details = details;
    }
}

export function headlessError(code, message, details = null) {
    return new HeadlessEpisodeError(code, message, details);
}
