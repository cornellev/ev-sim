import {
    DEFAULT_EARTH_IMPORT_CONFIG,
    getGoogleMapsApiKey,
    TILE_PROVIDER_IDS,
} from "./EarthImportConfig.js";
import { defaultFetch } from "../../util/Fetch.js";

/**
 * @typedef {{ rootUrl: string, apiKey: string|null, providerId: string }} GoogleEarthTileSession
 */

/**
 * Resolves Google Photorealistic 3D Tiles root URL and API key reference.
 */
export class GoogleEarthTilesService {
    /**
     * @param {Object} [options]
     * @param {() => string|null} [options.getApiKey]
     * @param {typeof fetch} [options.fetchImpl]
     */
    constructor(options = {}) {
        this.getApiKey = options.getApiKey ?? getGoogleMapsApiKey;
        this.fetchImpl = options.fetchImpl ?? defaultFetch;
    }

    /**
     * Root tileset URL without query params. GoogleCloudAuthPlugin injects the API key.
     * @returns {GoogleEarthTileSession}
     */
    resolveSession() {
        const apiKey = this.getApiKey();
        return {
            providerId: TILE_PROVIDER_IDS.GOOGLE_PHOTOREALISTIC,
            rootUrl: DEFAULT_EARTH_IMPORT_CONFIG.googleTilesRootUrl,
            apiKey,
        };
    }

    /**
     * @returns {{ ok: boolean, error?: string, session?: GoogleEarthTileSession }}
     */
    validateSession() {
        const session = this.resolveSession();
        if (!session.apiKey) {
            return {
                ok: false,
                error: "Google Maps API key is missing. Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.",
            };
        }
        return { ok: true, session };
    }

    /**
     * Preflight the Map Tiles API and return a human-readable error when Google rejects the key.
     * @returns {Promise<{ ok: boolean, error?: string, session?: GoogleEarthTileSession }>}
     */
    async validateAccess() {
        const sessionCheck = this.validateSession();
        if (!sessionCheck.ok) {
            return sessionCheck;
        }

        const { session } = sessionCheck;
        const url = new URL(session.rootUrl);
        url.searchParams.set("key", session.apiKey);

        try {
            const response = await this.fetchImpl(url.toString());
            if (response.ok) {
                return { ok: true, session };
            }

            let detail = "";
            try {
                const payload = await response.json();
                detail = payload?.error?.message ?? "";
            } catch {
                // ignore JSON parse failures
            }

            const hints = [
                "Enable the Map Tiles API on your Google Cloud project.",
                "Confirm billing is active for the project.",
                "If the API key has HTTP referrer restrictions, allow your app origin.",
                "Photorealistic 3D Tiles are not available in the European Economic Area.",
            ];

            const message = [
                `Google Map Tiles request failed (${response.status})`,
                detail,
                hints.join(" "),
            ].filter(Boolean).join(": ");

            return { ok: false, error: message };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Google Map Tiles request failed.";
            return { ok: false, error: message };
        }
    }
}
