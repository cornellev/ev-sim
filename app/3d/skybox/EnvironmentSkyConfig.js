export const SKY_MODES = Object.freeze({
    TAKRAM: "takram",
    IMAGE: "image",
});

export const SKY_QUALITY_PRESETS = Object.freeze(["low", "medium", "high", "ultra"]);

export const DEFAULT_IMAGE_SKY_URL = "assets/skybox/sky.exr";

export const DEFAULT_ENVIRONMENT_SKY_CONFIG = Object.freeze({
    mode: SKY_MODES.TAKRAM,
    takram: Object.freeze({
        cloudsEnabled: true,
        cloudCoverage: 0.38,
        cloudQuality: "high",
        atmosphereIntensity: 1,
        timeOfDay: 14.4,
        date: "2026-06-28",
        haze: true,
        lightShafts: false,
    }),
    image: Object.freeze({
        url: DEFAULT_IMAGE_SKY_URL,
        exposure: 1,
        localPreviewUrl: null,
        localPreviewName: null,
    }),
});

export function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

export function normalizeSkyConfig(config = {}) {
    const mode = Object.values(SKY_MODES).includes(config.mode)
        ? config.mode
        : DEFAULT_ENVIRONMENT_SKY_CONFIG.mode;

    const takram = {
        ...DEFAULT_ENVIRONMENT_SKY_CONFIG.takram,
        ...(config.takram ?? {}),
    };

    const image = {
        ...DEFAULT_ENVIRONMENT_SKY_CONFIG.image,
        ...(config.image ?? {}),
    };

    return {
        mode,
        takram: {
            cloudsEnabled: takram.cloudsEnabled !== false,
            cloudCoverage: clampNumber(takram.cloudCoverage, 0, 1, DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.cloudCoverage),
            cloudQuality: SKY_QUALITY_PRESETS.includes(takram.cloudQuality)
                ? takram.cloudQuality
                : DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.cloudQuality,
            atmosphereIntensity: clampNumber(takram.atmosphereIntensity, 0.2, 2, DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.atmosphereIntensity),
            timeOfDay: clampNumber(takram.timeOfDay, 0, 23.99, DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.timeOfDay),
            date: typeof takram.date === "string" && takram.date.trim()
                ? takram.date.trim()
                : DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.date,
            haze: takram.haze !== false,
            lightShafts: takram.lightShafts === true,
        },
        image: {
            url: typeof image.url === "string" ? image.url.trim() : DEFAULT_IMAGE_SKY_URL,
            exposure: clampNumber(image.exposure, 0.1, 3, DEFAULT_ENVIRONMENT_SKY_CONFIG.image.exposure),
            localPreviewUrl: typeof image.localPreviewUrl === "string" ? image.localPreviewUrl : null,
            localPreviewName: typeof image.localPreviewName === "string" ? image.localPreviewName : null,
        },
    };
}

export function cloneSkyConfig(config = {}) {
    return normalizeSkyConfig(config);
}

export function skyConfigToManifest(config = {}) {
    const normalized = normalizeSkyConfig(config);
    return {
        mode: normalized.mode,
        takram: { ...normalized.takram },
        image: {
            url: normalized.image.url,
            exposure: normalized.image.exposure,
        },
    };
}

export function getSkyRuntimeSource(config = {}) {
    const normalized = normalizeSkyConfig(config);
    return normalized.image.localPreviewUrl || normalized.image.url || DEFAULT_IMAGE_SKY_URL;
}

export function getSkyDate(config = {}) {
    const normalized = normalizeSkyConfig(config);
    const [year, month, day] = normalized.takram.date.split("-").map((part) => Number.parseInt(part, 10));
    const wholeHours = Math.floor(normalized.takram.timeOfDay);
    const minutes = Math.round((normalized.takram.timeOfDay - wholeHours) * 60);

    if (![year, month, day].every(Number.isFinite)) {
        return new Date();
    }

    return new Date(Date.UTC(year, Math.max(0, month - 1), day, wholeHours, minutes));
}
