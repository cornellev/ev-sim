/**
 * Shared exact-JSON predicates. Callers pass `fail(path, message)` so each
 * document keeps its own error type and code.
 *
 * @param {(path: string, message: string) => never} fail
 * @param {{
 *   prototype?: "loose" | "object-or-null",
 *   unknownField?: "suffix" | "unsupported",
 *   text?: "nonempty" | "split" | "always-nfc" | "nfc-nonempty",
 *   integer?: "raw" | "finite" | "integer-word",
 *   digest?: "via-text" | "pattern" | "nullable",
 * }} [options]
 */
export function createExactParser(fail, options = {}) {
    const prototype = options.prototype ?? "loose";
    const unknownField = options.unknownField ?? "suffix";
    const textMode = options.text ?? "nonempty";
    const integerMode = options.integer ?? "raw";
    const digestMode = options.digest ?? "via-text";
    const sha256 = /^[a-f0-9]{64}$/;

    function plainObject(value, path) {
        const wrongPrototype = prototype === "object-or-null"
            && value
            && typeof value === "object"
            && Object.getPrototypeOf(value) !== Object.prototype
            && Object.getPrototypeOf(value) !== null;
        if (!value || typeof value !== "object" || Array.isArray(value) || wrongPrototype) {
            fail(path, "expected an object");
        }
        return value;
    }

    function allowedKeys(value, allowed, path) {
        const source = plainObject(value, path);
        const unknown = Object.keys(source).find((key) => !allowed.includes(key));
        if (!unknown) return source;
        if (unknownField === "unsupported") fail(path, `${unknown} is not supported`);
        fail(`${path}.${unknown}`, "unknown field");
        return source;
    }

    function denseArray(value, path) {
        if (!Array.isArray(value)) fail(path, "expected an array");
        const keys = Object.keys(value);
        if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
            fail(path, "sparse or extended arrays are outside the JSON data model");
        }
        return value;
    }

    function finite(value, path) {
        if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
        return Object.is(value, -0) ? 0 : value;
    }

    function text(value, path, { identifier = false, allowEmpty = false } = {}) {
        if (textMode === "nfc-nonempty") {
            if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
                fail(path, "expected a non-empty NFC string");
            }
            return value;
        }
        if (textMode === "nonempty-nfc") {
            if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
            if (value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
            return value;
        }
        if (textMode === "always-nfc") {
            if (typeof value !== "string") fail(path, "expected a string");
            if (!allowEmpty && value.length === 0) fail(path, "expected a non-empty string");
            if (value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
            return value;
        }
        if (textMode === "split") {
            if (typeof value !== "string") fail(path, "expected a string");
            if (!allowEmpty && value.length === 0) fail(path, "expected a non-empty string");
            if (identifier && value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
            return value;
        }
        if (typeof value !== "string" || !value) fail(path, "expected a non-empty string");
        if (identifier && value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
        return value;
    }

    function integer(value, path, { min = 0 } = {}) {
        if (integerMode === "canonical") {
            const number = Object.is(value, -0) ? 0 : value;
            if (typeof number !== "number" || !Number.isFinite(number) || !Number.isSafeInteger(number) || number < min) {
                fail(path, `expected a safe integer >= ${min}`);
            }
            return number;
        }
        if (integerMode === "finite") {
            const number = finite(value, path);
            if (!Number.isSafeInteger(number) || number < min) fail(path, `expected a safe integer >= ${min}`);
            return number;
        }
        if (integerMode === "integer-word") {
            if (!Number.isSafeInteger(value) || value < min) fail(path, `expected an integer >= ${min}`);
            return value;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < min) {
            fail(path, `expected a safe integer >= ${min}`);
        }
        return value;
    }

    function sha256Hex(value, path, { nullable = false } = {}) {
        if (digestMode === "nullable" && nullable && value == null) return null;
        if (digestMode === "pattern" || digestMode === "nullable") {
            if (typeof value !== "string" || !sha256.test(value)) fail(path, "expected a lowercase SHA-256 digest");
            return value;
        }
        const result = text(value, path);
        if (!sha256.test(result)) fail(path, "expected a lowercase SHA-256 digest");
        return result;
    }

    function booleanValue(value, path) {
        if (typeof value !== "boolean") fail(path, "expected a boolean");
        return value;
    }

    return {
        plainObject,
        allowedKeys,
        denseArray,
        text,
        finite,
        integer,
        sha256Hex,
        boolean: booleanValue,
    };
}
