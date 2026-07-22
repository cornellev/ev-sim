import { Road } from "../../city/Road.js";

const PRESETS = Object.freeze({
    default: Object.freeze({
        roadOptions: Object.freeze({
            shoulderWidth: 0.8,
        }),
    }),
    igvc: Object.freeze({
        roadOptions: Object.freeze({
            // Match setupIGVC exactly. Existing persisted manifests predate
            // shoulder serialization, so this preset also repairs those files.
            shoulderWidth: 3,
            borderLeft: Road.BorderType.SOLID_WHITE,
            borderRight: Road.BorderType.SOLID_WHITE,
            tension: 0.15,
        }),
        networkOptions: Object.freeze({
            intersectionInsetFactor: 0.75,
        }),
    }),
});

export function getRoadStylePreset(id = "default") {
    return PRESETS[id] ?? PRESETS.default;
}

