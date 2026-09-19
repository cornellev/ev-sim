const TOKEN_PREFIX = "cev-sim:bake-token:";

function configuredBakeOrigins() {
    const configured = typeof process !== "undefined"
        ? process.env?.NEXT_PUBLIC_CEV_SIM_BAKE_ORIGINS
        : "";
    return new Set(String(configured ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            try { return new URL(entry).origin; }
            catch { return null; }
        })
        .filter(Boolean));
}

function configuredBakeToken() {
    return typeof process !== "undefined"
        ? String(process.env?.NEXT_PUBLIC_CEV_SIM_BAKE_TOKEN ?? "").trim()
        : "";
}

export function assertAllowedBakeHost(host, { allowedOrigins = configuredBakeOrigins() } = {}) {
    let url;
    try { url = new URL(String(host ?? "")); }
    catch { throw new Error("Bake host must be an absolute HTTP(S) origin."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Bake host must be an HTTP(S) origin without credentials or a path.");
    }
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (!loopback && !allowedOrigins.has(url.origin)) {
        throw new Error(`Bake origin ${url.origin} is not allowed.`);
    }
    return url.origin;
}

export function bakeServerUrl(server, pathname) {
    const path = String(pathname ?? "");
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\\]/.test(path)) {
        throw new Error("Bake request path is invalid.");
    }
    return new URL(path, `${assertAllowedBakeHost(server?.host)}/`).toString();
}

function originOf(host) {
    return assertAllowedBakeHost(host);
}

export function getBakeAccessToken(host) {
    if (typeof sessionStorage === "undefined") return configuredBakeToken() || null;
    try {
        return sessionStorage.getItem(`${TOKEN_PREFIX}${originOf(host)}`)
            || configuredBakeToken()
            || null;
    } catch {
        return configuredBakeToken() || null;
    }
}

export function setBakeAccessToken(host, token) {
    if (typeof sessionStorage === "undefined") {
        throw new Error("Bake access tokens require a browser session.");
    }
    const key = `${TOKEN_PREFIX}${originOf(host)}`;
    const value = String(token ?? "").trim();
    if (!value) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
}

export function bakeAuthorizationHeaders(server, headers = {}) {
    const token = server?.accessToken ?? server?.getAccessToken?.() ?? getBakeAccessToken(server?.host);
    if (!token || /[\r\n]/.test(token)) {
        const error = new Error("A session bake access token is required for this server.");
        error.code = "BAKE_UNAUTHORIZED";
        throw error;
    }
    return { ...headers, Authorization: `Bearer ${token}` };
}
