/**
 * UTF-8 byte order for object keys and identifiers.
 * Distinct from JavaScript's UTF-16 `String.prototype` sort.
 */

const textEncoder = new TextEncoder();

export function compareUtf8Bytes(left, right) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
}

export function compareUtf8(left, right) {
    return compareUtf8Bytes(textEncoder.encode(String(left)), textEncoder.encode(String(right)));
}
