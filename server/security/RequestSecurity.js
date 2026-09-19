const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);

function list(value) {
    return String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function hostname(value) {
    const normalized = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
    return normalized.startsWith("[") && normalized.endsWith("]")
        ? normalized.slice(1, -1)
        : normalized;
}

function hostHeader(value) {
    const text = String(value ?? "").trim();
    if (!text || /[\s/\\]/.test(text)) throw securityError(400, "Invalid Host header.");
    try {
        const parsed = new URL(`http://${text}`);
        return { raw: text.toLowerCase(), hostname: hostname(parsed.hostname) };
    } catch {
        throw securityError(400, "Invalid Host header.");
    }
}

function securityError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode, code: "REQUEST_ORIGIN_REJECTED" });
}

export function isLoopbackHost(value) {
    return LOOPBACK_HOSTS.includes(hostname(value));
}

export function resolveHttpSecurityConfig(env = process.env) {
    const bindHost = hostname(env.CEV_SIM_HOST || "127.0.0.1");
    const allowRemote = env.CEV_SIM_ALLOW_REMOTE_HTTP === "1";
    if (!isLoopbackHost(bindHost) && !allowRemote) {
        throw new Error(
            `Refusing non-loopback CEV_SIM_HOST=${JSON.stringify(bindHost)} without CEV_SIM_ALLOW_REMOTE_HTTP=1.`,
        );
    }
    const configuredHosts = list(env.CEV_SIM_ALLOWED_HOSTS).map(hostname);
    if (!isLoopbackHost(bindHost) && configuredHosts.length === 0) {
        throw new Error("CEV_SIM_ALLOWED_HOSTS is required for a non-loopback HTTP listener.");
    }
    return Object.freeze({
        bindHost,
        allowedHosts: new Set([...LOOPBACK_HOSTS, ...configuredHosts]),
        allowedOrigins: new Set(list(env.CEV_SIM_ALLOWED_ORIGINS).map((entry) => {
            try {
                return new URL(entry).origin;
            } catch {
                throw new Error(`Invalid CEV_SIM_ALLOWED_ORIGINS entry: ${JSON.stringify(entry)}.`);
            }
        })),
    });
}

export function assertTrustedHttpRequest(req, config) {
    const requestHost = hostHeader(req.headers?.host);
    if (!config.allowedHosts.has(requestHost.hostname)) {
        throw securityError(403, "Host is not allowed for the local authoring service.");
    }

    const value = String(req.headers?.origin ?? "").trim();
    if (!value) return;
    if (value === "null") throw securityError(403, "Opaque browser origins are not allowed.");
    let origin;
    try {
        origin = new URL(value);
    } catch {
        throw securityError(403, "Origin is invalid.");
    }
    const requestProtocol = `${req.protocol || "http"}:`;
    const sameOrigin = origin.protocol === requestProtocol
        && origin.host.toLowerCase() === requestHost.raw;
    if (!sameOrigin && !config.allowedOrigins.has(origin.origin)) {
        throw securityError(403, "Cross-origin authoring requests are not allowed.");
    }
}

export function createRequestSecurityMiddleware(config) {
    return (req, res, next) => {
        try {
            assertTrustedHttpRequest(req, config);
            next();
        } catch (error) {
            res.status(error.statusCode || 403).json({ error: error.message, code: error.code });
        }
    };
}
