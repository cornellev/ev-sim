/**
 * Option contracts for environment object types.
 *
 * Every object type owns an `ObjectOptions` describing its editable value:
 * defaults, declarative field descriptors, normalization, and validation that
 * returns structured issues instead of throwing. Editors render fields from
 * descriptors; the kernel never imports this module's consumers' UI. This
 * module is kernel-safe: no React, Three, DOM, or `node:` imports.
 */

export const FIELD_CONTROLS = Object.freeze([
    "number",
    "text",
    "toggle",
    "enum",
    "vector3",
    "color",
    "asset-reference",
]);

export const ISSUE_SEVERITIES = Object.freeze(["error", "warning"]);

export function text(value, fallback = "") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

export function finite(value, fallback) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : fallback;
}

export function integer(value, fallback) {
    return Number.isInteger(value) ? value : fallback;
}

export function boolean(value, fallback = false) {
    return typeof value === "boolean" ? value : fallback;
}

export function enumOf(values) {
    const allowed = Object.freeze([...values]);
    return (value, fallback = allowed[0]) => (allowed.includes(value) ? value : fallback);
}

export function stringList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

export function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @typedef {{ path: Array<string|number>, code: string, message: string, severity: "error"|"warning", objectId?: string }} ObjectIssue
 */

/**
 * @param {Array<string|number>} path
 * @param {string} code
 * @param {string} message
 * @returns {ObjectIssue}
 */
export function issue(path, code, message, { severity = "error", objectId = null } = {}) {
    if (!Array.isArray(path)) throw new TypeError("Issue paths must be arrays.");
    if (!text(code)) throw new TypeError("Issue codes are required.");
    if (!ISSUE_SEVERITIES.includes(severity)) throw new TypeError(`Unknown issue severity "${severity}".`);
    const result = { path: [...path], code, message: String(message ?? code), severity };
    if (objectId) result.objectId = objectId;
    return result;
}

export function prefixIssues(issues, prefix, extra = {}) {
    return issues.map((entry) => ({ ...entry, ...extra, path: [...prefix, ...entry.path] }));
}

export function hasErrorIssue(issues) {
    return issues.some((entry) => entry.severity === "error");
}

export function formatIssuePath(path) {
    return path.reduce((result, segment) => (
        typeof segment === "number" ? `${result}[${segment}]` : result ? `${result}.${segment}` : String(segment)
    ), "");
}

/**
 * Declarative field descriptor consumed by inspectors and validators.
 * @typedef {{ path: string[], label: string, control: string, units?: string, min?: number, max?: number,
 *   step?: number, options?: ReadonlyArray<string>, group?: string, advanced?: boolean, readOnly?: boolean,
 *   description?: string }} FieldDescriptor
 */

/** @returns {FieldDescriptor} */
export function field({
    path,
    label,
    control = "number",
    units,
    min,
    max,
    step,
    options,
    group,
    advanced = false,
    readOnly = false,
    description,
} = {}) {
    if (!Array.isArray(path) || path.length === 0 || !path.every((segment) => typeof segment === "string" && segment)) {
        throw new TypeError("Field descriptors require a non-empty string path.");
    }
    if (!text(label)) throw new TypeError(`Field "${path.join(".")}" requires a label.`);
    if (!FIELD_CONTROLS.includes(control)) throw new TypeError(`Field "${path.join(".")}" has unknown control "${control}".`);
    if (control === "enum" && (!Array.isArray(options) || options.length === 0)) {
        throw new TypeError(`Enum field "${path.join(".")}" requires options.`);
    }
    const descriptor = { path: Object.freeze([...path]), label: text(label), control };
    if (units !== undefined) descriptor.units = String(units);
    if (min !== undefined) descriptor.min = Number(min);
    if (max !== undefined) descriptor.max = Number(max);
    if (step !== undefined) descriptor.step = Number(step);
    if (options !== undefined) descriptor.options = Object.freeze([...options]);
    if (group !== undefined) descriptor.group = String(group);
    if (advanced) descriptor.advanced = true;
    if (readOnly) descriptor.readOnly = true;
    if (description !== undefined) descriptor.description = String(description);
    return Object.freeze(descriptor);
}

export function getFieldValue(value, path) {
    let current = value;
    for (const segment of path) {
        if (current === null || current === undefined) return undefined;
        current = current[segment];
    }
    return current;
}

/** Return a copy of `value` with `path` set to `next`; never mutates the input. */
export function setFieldValue(value, path, next) {
    if (path.length === 0) return next;
    const [head, ...rest] = path;
    const source = isPlainObject(value) ? value : {};
    return { ...source, [head]: setFieldValue(source[head], rest, next) };
}

/**
 * Report unknown keys on a value. Returns issues instead of throwing so callers
 * can aggregate them with other validation output.
 */
export function unknownKeyIssues(value, allowed, path, code = "option.unknown-key") {
    if (!isPlainObject(value)) return [];
    return Object.keys(value)
        .filter((key) => !allowed.includes(key))
        .map((key) => issue([...path, key], code, `Unknown key "${key}".`));
}

/** Throwing variant for definition-time contracts. */
export function assertKeys(value, allowed, label) {
    if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new TypeError(`${label} has unknown key "${key}".`);
    }
    return value;
}

/**
 * Validate a value against field descriptors: presence, primitive type,
 * numeric range, and enum membership.
 * @param {ReadonlyArray<FieldDescriptor>} fields
 * @returns {ObjectIssue[]}
 */
export function validateFieldConstraints(fields, value, { path = [] } = {}) {
    const issues = [];
    for (const descriptor of fields) {
        const fieldPath = [...path, ...descriptor.path];
        const current = getFieldValue(value, descriptor.path);
        if (descriptor.readOnly) continue;
        if (current === undefined || current === null) {
            issues.push(issue(fieldPath, "option.required", `${descriptor.label} is required.`));
            continue;
        }
        switch (descriptor.control) {
            case "number": {
                if (!Number.isFinite(current)) {
                    issues.push(issue(fieldPath, "option.type", `${descriptor.label} must be a finite number.`));
                    break;
                }
                if (descriptor.min !== undefined && current < descriptor.min) {
                    issues.push(issue(fieldPath, "option.range", `${descriptor.label} must be at least ${descriptor.min}.`));
                }
                if (descriptor.max !== undefined && current > descriptor.max) {
                    issues.push(issue(fieldPath, "option.range", `${descriptor.label} must be at most ${descriptor.max}.`));
                }
                break;
            }
            case "toggle":
                if (typeof current !== "boolean") {
                    issues.push(issue(fieldPath, "option.type", `${descriptor.label} must be true or false.`));
                }
                break;
            case "enum":
                if (!descriptor.options.includes(current)) {
                    issues.push(issue(
                        fieldPath,
                        "option.enum",
                        `${descriptor.label} must be one of: ${descriptor.options.join(", ")}.`,
                    ));
                }
                break;
            case "vector3":
                if (!isPlainObject(current) || !["x", "y", "z"].every((axis) => Number.isFinite(current[axis]))) {
                    issues.push(issue(fieldPath, "option.type", `${descriptor.label} must be a finite {x, y, z} vector.`));
                }
                break;
            case "text":
            case "color":
            case "asset-reference":
                if (typeof current !== "string") {
                    issues.push(issue(fieldPath, "option.type", `${descriptor.label} must be text.`));
                }
                break;
            default:
                break;
        }
    }
    return issues;
}

const CONTRACT_METHODS = Object.freeze(["getDefaults", "getFields", "normalize", "validate"]);

/**
 * Base class for object option contracts. Subclasses must implement all four
 * contract methods; the constructor rejects incomplete subclasses so a type
 * cannot register with a half-implemented options object.
 */
export class ObjectOptions {
    constructor() {
        for (const method of CONTRACT_METHODS) {
            if (typeof this[method] !== "function" || this[method] === ObjectOptions.prototype[method]) {
                throw new TypeError(`${this.constructor.name} must implement ObjectOptions.${method}().`);
            }
        }
    }

    /** @returns {Record<string, unknown>} */
    getDefaults() {
        throw new TypeError("ObjectOptions.getDefaults() is abstract.");
    }

    /**
     * @param {Record<string, unknown>} [context]
     * @returns {ReadonlyArray<FieldDescriptor>}
     */
    getFields(context) {
        throw new TypeError("ObjectOptions.getFields() is abstract.");
    }

    /** Coerce an untrusted value into the option shape. Must not throw on bad input. */
    normalize(value) {
        throw new TypeError("ObjectOptions.normalize() is abstract.");
    }

    /**
     * @param {Record<string, unknown>} value
     * @param {Record<string, unknown>} [context]
     * @returns {ObjectIssue[]}
     */
    validate(value, context) {
        throw new TypeError("ObjectOptions.validate() is abstract.");
    }

    /**
     * Project the option value from the canonical legacy record. ED-01 does
     * not persist type-specific options in the overlay; types whose legacy
     * record is the option value inherit this default.
     */
    fromLegacy(legacyRecord, context) {
        return this.normalize(legacyRecord ?? {});
    }
}

export function isObjectOptions(value) {
    return value instanceof ObjectOptions;
}
