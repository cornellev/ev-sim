/**
 * Async JSON route wrapper. Callers keep their log prefix and error mapping.
 */
export function jsonHandler(fn, {
    logPrefix,
    statusOf = (error) => Number(error.statusCode) || 400,
    bodyOf = (error) => error.toJSON?.() ?? {
        error: error.message,
        code: error.code,
        currentRevision: error.currentRevision,
    },
} = {}) {
    return async (req, res) => {
        try {
            const result = await fn(req);
            res.json(result ?? null);
        } catch (error) {
            console.error(`[${logPrefix}] ${req.method} ${req.originalUrl} failed:`, error);
            res.status(statusOf(error)).json(bodyOf(error));
        }
    };
}
