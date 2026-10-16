/** Failure raised by GitHub acquisition. The code is safe to return over HTTP. */

export class GitHubUrdfError extends Error {
    constructor(code, message, { path = "", statusCode = 400 } = {}) {
        super(message);
        this.name = "GitHubUrdfError";
        this.code = code;
        this.path = path;
        this.statusCode = statusCode;
    }
}
