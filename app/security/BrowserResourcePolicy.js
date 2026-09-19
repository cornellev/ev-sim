function configuredOrigins() {
    const configured = typeof process !== "undefined"
        ? process.env?.NEXT_PUBLIC_CEV_SIM_RESOURCE_ORIGINS
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

function defaultOrigin() {
    return globalThis.location?.origin ?? "http://localhost";
}

/** Admit only same-origin paths, explicitly configured HTTP(S) origins, or an app-created blob URL. */
export function assertAllowedBrowserResourceUrl(value, {
    allowBlob = false,
    baseOrigin = defaultOrigin(),
    allowedOrigins = configuredOrigins(),
} = {}) {
    const source = String(value ?? "").trim();
    if (!source || /[\u0000-\u001f\\]/.test(source) || source.startsWith("//")) {
        throw new Error("Resource URL is empty or malformed.");
    }
    if (allowBlob && source.startsWith("blob:")) return source;

    let url;
    try {
        url = new URL(source, `${new URL(baseOrigin).origin}/`);
    } catch {
        throw new Error("Resource URL is invalid.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`Resource URL scheme ${url.protocol} is not allowed.`);
    }
    const base = new URL(baseOrigin).origin;
    if (url.origin !== base && !allowedOrigins.has(url.origin)) {
        throw new Error(`Resource origin ${url.origin} is not allowed.`);
    }
    return source;
}
