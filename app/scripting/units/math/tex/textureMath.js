export function requireTexture(value, typeId) {
    if (!Array.isArray(value)) {
        throw new Error(`${typeId} texture input must be an array.`);
    }
    return value;
}

export function requireFiniteSamples(texture, typeId) {
    for (let index = 0; index < texture.length; index += 1) {
        if (!Number.isFinite(Number(texture[index]))) {
            throw new Error(`${typeId} texture samples must be finite.`);
        }
    }
}

export function requireEqualLength(a, b, typeId) {
    if (a.length !== b.length) {
        throw new Error(`${typeId} texture inputs must have equal lengths.`);
    }
}

export function mapUnary(texture, fn, typeId) {
    requireTexture(texture, typeId);
    requireFiniteSamples(texture, typeId);
    return texture.map((value) => fn(Number(value)));
}

export function mapBinary(a, b, fn, typeId) {
    requireTexture(a, typeId);
    requireTexture(b, typeId);
    requireEqualLength(a, b, typeId);
    requireFiniteSamples(a, typeId);
    requireFiniteSamples(b, typeId);
    return a.map((value, index) => fn(Number(value), Number(b[index])));
}

export function isPerfectSquare(length) {
    if (!Number.isInteger(length) || length < 1) return false;
    const root = Math.sqrt(length);
    return Number.isInteger(root);
}
