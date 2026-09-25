export class BlockRegistryError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "BlockRegistryError";
        this.code = code;
        this.details = details;
    }
}

function normalizeOwnership(ownership) {
    if (ownership === "builtin") return "builtin";
    if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) {
        throw new BlockRegistryError("REGISTRY_OWNER_INVALID", "Block ownership must be built-in or a plugin identity.");
    }
    const normalized = {
        pluginId: String(ownership.pluginId ?? "").trim(),
        version: String(ownership.version ?? "").trim(),
        runtimeHash: String(ownership.runtimeHash ?? "").trim(),
    };
    if (!normalized.pluginId || !normalized.version || !/^[a-f0-9]{64}$/.test(normalized.runtimeHash)) {
        throw new BlockRegistryError("REGISTRY_OWNER_INVALID", "Plugin block ownership is incomplete.", normalized);
    }
    return Object.freeze(normalized);
}

function sameOwnership(left, right) {
    if (left === "builtin" || right === "builtin") return left === right;
    return left.pluginId === right.pluginId
        && left.version === right.version
        && left.runtimeHash === right.runtimeHash;
}

export class BlockRegistry {
    #entries = new Map();
    #sealed = false;

    constructor({ entries = [], allowPlugins = true } = {}) {
        this.allowPlugins = allowPlugins !== false;
        for (const entry of entries) {
            this.register(entry.type, entry.blockClass, entry.ownership);
        }
    }

    register(type, blockClass, ownership = "builtin") {
        const typeId = String(type ?? "").trim();
        if (!typeId || typeof blockClass !== "function") {
            throw new BlockRegistryError("REGISTRY_DEFINITION_INVALID", "A block type and class are required.");
        }
        if (this.#sealed) {
            throw new BlockRegistryError("REGISTRY_SEALED", `Block registry is sealed; cannot register "${typeId}".`);
        }
        const owner = normalizeOwnership(ownership);
        if (owner !== "builtin" && !this.allowPlugins) {
            throw new BlockRegistryError("REGISTRY_PLUGIN_FORBIDDEN", "The default block registry accepts built-ins only.");
        }
        const current = this.#entries.get(typeId);
        if (current) {
            if (current.ownership === "builtin" && owner === "builtin" && current.blockClass === blockClass) {
                return current.blockClass;
            }
            throw new BlockRegistryError(
                "REGISTRY_CONFLICT",
                `Block type "${typeId}" is already registered.`,
                { type: typeId, existingOwnership: current.ownership, attemptedOwnership: owner },
            );
        }
        blockClass.blockType = typeId;
        this.#entries.set(typeId, Object.freeze({ type: typeId, blockClass, ownership: owner }));
        return blockClass;
    }

    ensureBuiltin(type, blockClass) {
        const typeId = String(type ?? "").trim();
        if (!typeId || typeof blockClass !== "function") {
            throw new BlockRegistryError("REGISTRY_DEFINITION_INVALID", "A block type and class are required.");
        }
        if (this.#sealed) {
            throw new BlockRegistryError("REGISTRY_SEALED", `Block registry is sealed; cannot register "${typeId}".`);
        }
        const current = this.#entries.get(typeId);
        if (!current) return this.register(typeId, blockClass, "builtin");
        if (current.ownership !== "builtin") {
            throw new BlockRegistryError(
                "REGISTRY_CONFLICT",
                `Block type "${typeId}" is already registered.`,
                { type: typeId, existingOwnership: current.ownership, attemptedOwnership: "builtin" },
            );
        }
        if (current.blockClass === blockClass) return current.blockClass;
        blockClass.blockType = typeId;
        this.#entries.set(typeId, Object.freeze({ type: typeId, blockClass, ownership: "builtin" }));
        return blockClass;
    }

    get(type) {
        return this.#entries.get(String(type ?? ""))?.blockClass ?? null;
    }

    has(type) {
        return this.#entries.has(String(type ?? ""));
    }

    snapshot() {
        return Object.freeze([...this.#entries.values()].map((entry) => Object.freeze({
            type: entry.type,
            blockClass: entry.blockClass,
            ownership: entry.ownership === "builtin" ? "builtin" : Object.freeze({ ...entry.ownership }),
        })));
    }

    seal() {
        this.#sealed = true;
        return this;
    }

    clearForTests() {
        this.#entries.clear();
        this.#sealed = false;
    }
}

export const defaultBlockRegistry = new BlockRegistry({ allowPlugins: false });

export function registerBlockType(typeId, blockClass) {
    if (!typeId || !blockClass) return;
    defaultBlockRegistry.register(typeId, blockClass, "builtin");
}

export function getRegisteredBlockType(typeId) {
    return defaultBlockRegistry.get(typeId);
}

export function clearBlockTypeRegistryForTests() {
    defaultBlockRegistry.clearForTests();
}
