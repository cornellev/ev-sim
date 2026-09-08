import {
    VISUAL_PREVIEW_ERROR_CODES,
    VisualPreviewError,
    sha256FromUri,
} from "../../../simulation/visual/VisualLayer.js";

const FORBIDDEN_URI = /^(?:[a-z][a-z0-9+.-]*:|\/\/|[\\/]|[a-zA-Z]:[\\/]|\.\.(?:[\\/]|$))/i;

export function assertAllowedGltfUri(uri, allowedDigests) {
    const digest = sha256FromUri(uri);
    if (digest && allowedDigests.has(digest)) return digest;
    throw new VisualPreviewError(
        VISUAL_PREVIEW_ERROR_CODES.URI_REJECTED,
        `Rejected glTF URI ${JSON.stringify(uri)} before a request occurred.`,
    );
}

export function createDigestUrlModifier(resourceMap, { allowInternalBlobUrls = false } = {}) {
    const allowedObjectUrls = new Set(
        [...resourceMap.values()].map((entry) => entry.objectUrl).filter(Boolean),
    );
    const allowedDigests = new Set(resourceMap.keys());
    return (url) => {
        if (typeof url !== "string" || url.length === 0) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.URI_REJECTED,
                "Rejected empty glTF URI before a request occurred.",
            );
        }
        if (allowedObjectUrls.has(url)) return url;
        // Authored blob: URIs are rejected by server preflight. This opt-in is
        // only for object URLs created by GLTFLoader from validated bufferViews.
        if (allowInternalBlobUrls && url.startsWith("blob:")) return url;
        const digest = sha256FromUri(url);
        if (digest && resourceMap.has(digest) && resourceMap.get(digest).objectUrl) {
            return resourceMap.get(digest).objectUrl;
        }
        if (FORBIDDEN_URI.test(url) || url.includes("\\") || url.includes("/") || url.includes("%") || url.includes("..") || !digest) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.URI_REJECTED,
                `Rejected glTF URI ${JSON.stringify(url)} before a request occurred.`,
            );
        }
        assertAllowedGltfUri(url, allowedDigests);
        throw new VisualPreviewError(
            VISUAL_PREVIEW_ERROR_CODES.URI_REJECTED,
            `Rejected glTF URI ${JSON.stringify(url)} before a request occurred.`,
        );
    };
}
