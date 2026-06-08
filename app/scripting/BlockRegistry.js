const BLOCK_TYPE_REGISTRY = new Map();

export function registerBlockType(typeId, blockClass) {
    if (!typeId || !blockClass) return;
    blockClass.blockType = typeId;
    BLOCK_TYPE_REGISTRY.set(typeId, blockClass);
}

export function getRegisteredBlockType(typeId) {
    return BLOCK_TYPE_REGISTRY.get(typeId) || null;
}

export function clearBlockTypeRegistryForTests() {
    BLOCK_TYPE_REGISTRY.clear();
}

