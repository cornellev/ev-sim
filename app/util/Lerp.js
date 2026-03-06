
export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function lerpVec3(out, a, b, t) {
    out.x = lerp(a.x, b.x, t);
    out.y = lerp(a.y, b.y, t);
    out.z = lerp(a.z, b.z, t);
    return out;
}

export function lerpEuler(out, a, b, t) {
    out.x = lerp(a.x, b.x, t);
    out.y = lerp(a.y, b.y, t);
    out.z = lerp(a.z, b.z, t);
    return out;
}

export function smoothStep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export function smoothStepVec3(out, edge0, edge1, x) {
    out.x = smoothStep(edge0.x, edge1.x, x.x);
    out.y = smoothStep(edge0.y, edge1.y, x.y);
    out.z = smoothStep(edge0.z, edge1.z, x.z);
    return out;
}

export function smoothStepEuler(out, edge0, edge1, x) {
    out.x = smoothStep(edge0.x, edge1.x, x.x);
    out.y = smoothStep(edge0.y, edge1.y, x.y);
    out.z = smoothStep(edge0.z, edge1.z, x.z);
    return out;
}