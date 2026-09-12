/**
 * Registry of environment object types.
 *
 * A type definition supplies behavior around plain persisted records: option
 * contracts, capability flags, a transform binding, dependencies, metric
 * compilation, and record migration. Definitions are frozen on registration
 * and keyed by `typeId@version`. Mirrors `SensorTypeRegistry` and
 * `RenderSceneProviderRegistry`. Kernel-safe.
 */

import { isObjectOptions, isPlainObject, issue, text } from "./ObjectOptions.js";
import { TRANSFORM_ISSUE_CODES } from "./transformDelta.js";

export const OBJECT_TYPE_ERROR_CODES = Object.freeze({
    INVALID_DEFINITION: "OBJECT_TYPE_INVALID_DEFINITION",
    DUPLICATE: "OBJECT_TYPE_DUPLICATE",
    NOT_FOUND: "OBJECT_TYPE_NOT_FOUND",
    CREATE_UNAVAILABLE: "OBJECT_TYPE_CREATE_UNAVAILABLE",
    NOT_IMPLEMENTED: "OBJECT_TYPE_NOT_IMPLEMENTED",
});

export class ObjectTypeError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "ObjectTypeError";
        this.code = code;
        this.details = details;
    }
}

export const REQUIRED_TYPE_METHODS = Object.freeze([
    "create",
    "getCapabilities",
    "getTransformBinding",
    "getDependencies",
    "compileMetric",
    "migrate",
]);

export const LEGACY_DOMAINS = Object.freeze([
    "features",
    "buildings",
    "roads.edges",
    "roads.nodes",
    "earth",
    "sky",
]);

export const OBJECT_LAYERS = Object.freeze(["props", "roads", "buildings", "environment"]);

export const DEFAULT_CAPABILITIES = Object.freeze({
    selectable: true,
    transformable: false,
    deletable: false,
    groupable: false,
    hasOptions: false,
});

/**
 * Transform binding returned by types without a transform. `plan()` reports
 * the object as not transformable so planners reject the gesture atomically.
 */
export const NO_TRANSFORM_BINDING = Object.freeze({
    kind: "none",
    read() {
        return null;
    },
    plan(_delta, context = {}) {
        return {
            steps: [],
            issues: [issue(
                ["transform"],
                TRANSFORM_ISSUE_CODES.NOT_TRANSFORMABLE,
                "This object has no transform.",
                { objectId: context.record?.id ?? null },
            )],
        };
    },
});

export function objectTypeKey(typeId, version) {
    return `${typeId}@${version}`;
}

/**
 * @typedef {{ typeId: string, version: number, label: string,
 *   catalog: { label: string, kind: string, layer: string, mapColor?: string },
 *   legacy: { domain: string, idField: string } | null,
 *   options: import("./ObjectOptions.js").ObjectOptions,
 *   create(input: object, context: object): object,
 *   getCapabilities(record: object): object,
 *   getTransformBinding(record: object): { kind: string, read(legacy: object, context: object): object|null,
 *     plan(delta: { matrix: number[] }, context: object): { steps: object[], issues: object[] } },
 *   getDependencies(record: object, context?: object): Array<{ kind: string, id: string }>,
 *   compileMetric(record: object, context: object): object|null,
 *   migrate(record: object, fromVersion: number): object }} ObjectTypeDefinition
 */

/**
 * Fill standard implementations so a complete definition needs only the
 * members that differ from the defaults. The registry still verifies the
 * result, so the helper cannot mask a missing `options` or `typeId`.
 * @returns {ObjectTypeDefinition}
 */
export function defineObjectType(spec = {}) {
    const typeId = text(spec.typeId);
    const capabilities = Object.freeze({ ...DEFAULT_CAPABILITIES, ...(spec.capabilities ?? {}) });
    return {
        ...spec,
        typeId,
        version: spec.version ?? 1,
        label: text(spec.label, typeId),
        catalog: Object.freeze({
            label: text(spec.catalog?.label, text(spec.label, typeId)),
            kind: text(spec.catalog?.kind, typeId),
            layer: text(spec.catalog?.layer, "environment"),
            ...(spec.catalog?.mapColor ? { mapColor: String(spec.catalog.mapColor) } : {}),
        }),
        legacy: spec.legacy ?? null,
        capabilities,
        create: spec.create ?? (() => {
            throw new ObjectTypeError(
                OBJECT_TYPE_ERROR_CODES.CREATE_UNAVAILABLE,
                `Object type "${typeId}" cannot be created directly in this milestone.`,
                { typeId },
            );
        }),
        getCapabilities: spec.getCapabilities ?? (() => capabilities),
        getTransformBinding: spec.getTransformBinding ?? (() => NO_TRANSFORM_BINDING),
        getDependencies: spec.getDependencies ?? (() => []),
        compileMetric: spec.compileMetric ?? (() => null),
        migrate: spec.migrate ?? ((record) => record),
    };
}

function invalid(typeId, message) {
    return new ObjectTypeError(
        OBJECT_TYPE_ERROR_CODES.INVALID_DEFINITION,
        typeId ? `Object type "${typeId}": ${message}` : message,
        { typeId: typeId || null },
    );
}

export class ObjectTypeRegistry {
    constructor() {
        /** @type {Map<string, Readonly<ObjectTypeDefinition>>} */
        this.definitions = new Map();
        /** @type {Map<string, number>} */
        this.latestVersions = new Map();
    }

    /** @returns {Readonly<ObjectTypeDefinition>} */
    register(definition) {
        if (!isPlainObject(definition)) throw invalid(null, "Object type definitions must be objects.");
        const typeId = text(definition.typeId);
        if (!typeId) throw invalid(null, "Object type definitions require a typeId.");
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(typeId)) {
            throw invalid(typeId, "typeId must be lowercase letters, digits, dots, or hyphens.");
        }
        const version = definition.version;
        if (!Number.isInteger(version) || version <= 0) throw invalid(typeId, "version must be a positive integer.");
        if (!text(definition.label)) throw invalid(typeId, "label is required.");
        if (!isObjectOptions(definition.options)) throw invalid(typeId, "options must extend ObjectOptions.");
        for (const method of REQUIRED_TYPE_METHODS) {
            if (typeof definition[method] !== "function") throw invalid(typeId, `${method}() is required.`);
        }
        if (!isPlainObject(definition.catalog) || !text(definition.catalog.label) || !text(definition.catalog.kind)) {
            throw invalid(typeId, "catalog requires label and kind.");
        }
        if (!OBJECT_LAYERS.includes(definition.catalog.layer)) {
            throw invalid(typeId, `catalog.layer must be one of ${OBJECT_LAYERS.join(", ")}.`);
        }
        if (definition.legacy !== null && definition.legacy !== undefined) {
            if (!isPlainObject(definition.legacy) || !LEGACY_DOMAINS.includes(definition.legacy.domain)) {
                throw invalid(typeId, `legacy.domain must be one of ${LEGACY_DOMAINS.join(", ")}.`);
            }
            if (!text(definition.legacy.idField)) throw invalid(typeId, "legacy.idField is required.");
        }
        const key = objectTypeKey(typeId, version);
        if (this.definitions.has(key)) {
            throw new ObjectTypeError(
                OBJECT_TYPE_ERROR_CODES.DUPLICATE,
                `Object type "${key}" is already registered.`,
                { typeId, version },
            );
        }
        const normalized = Object.freeze({
            ...definition,
            typeId,
            version,
            key,
            legacy: definition.legacy ? Object.freeze({ ...definition.legacy }) : null,
        });
        this.definitions.set(key, normalized);
        if ((this.latestVersions.get(typeId) ?? 0) < version) this.latestVersions.set(typeId, version);
        return normalized;
    }

    /** Latest version when `version` is omitted; exact version otherwise. */
    get(typeId, version) {
        const id = text(typeId);
        if (!id) return null;
        const resolved = version === undefined || version === null ? this.latestVersions.get(id) : version;
        if (resolved === undefined) return null;
        return this.definitions.get(objectTypeKey(id, resolved)) ?? null;
    }

    has(typeId, version) {
        return this.get(typeId, version) !== null;
    }

    require(typeId, version) {
        const definition = this.get(typeId, version);
        if (!definition) {
            throw new ObjectTypeError(
                OBJECT_TYPE_ERROR_CODES.NOT_FOUND,
                version === undefined
                    ? `Object type "${typeId}" is not registered.`
                    : `Object type "${objectTypeKey(typeId, version)}" is not registered.`,
                { typeId, version: version ?? null },
            );
        }
        return definition;
    }

    /** Latest version of every type, sorted by typeId. */
    list() {
        return [...this.latestVersions.keys()]
            .sort()
            .map((typeId) => this.get(typeId));
    }

    listAll() {
        return [...this.definitions.values()].sort((left, right) => (
            left.typeId === right.typeId ? left.version - right.version : left.typeId < right.typeId ? -1 : 1
        ));
    }
}

export const objectTypeRegistry = new ObjectTypeRegistry();

export function registerObjectType(definition) {
    return objectTypeRegistry.register(definition);
}

export function getObjectType(typeId, version) {
    return objectTypeRegistry.get(typeId, version);
}

export function listObjectTypes() {
    return objectTypeRegistry.list();
}
