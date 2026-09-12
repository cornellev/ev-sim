export const ROAD_GEOMETRY_POLICY_V1 = Object.freeze({
    id: "road-geometry-policy-v1",
    version: 1,
    maxChordDeviation: 0.01,
    maxSampleSpacing: 1,
    maxDepth: 20,
    maxSamplesPerEdge: 16_384,
    miterLimit: 4,
    canonicalDecimals: 6,
});

export function validateRoadGeometryPolicy(value = ROAD_GEOMETRY_POLICY_V1) {
    const errors = [];
    const positive = ["maxChordDeviation", "maxSampleSpacing", "miterLimit"];
    for (const key of positive) {
        if (!Number.isFinite(Number(value?.[key])) || Number(value[key]) <= 0) {
            errors.push(`${key} must be a positive finite number.`);
        }
    }
    for (const key of ["maxDepth", "maxSamplesPerEdge", "canonicalDecimals"]) {
        if (!Number.isInteger(Number(value?.[key])) || Number(value[key]) < 0) {
            errors.push(`${key} must be a non-negative integer.`);
        }
    }
    if (Number(value?.maxSamplesPerEdge) < 2) errors.push("maxSamplesPerEdge must be at least two.");
    return { ok: errors.length === 0, errors };
}

