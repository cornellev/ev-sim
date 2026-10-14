/**
 * Host fields an attachment block can read. Kernel-safe.
 * The object id of a road, building, or intersection is the legacy id.
 * `general` matches any selected object and is not a scene-object type.
 */

export const ATTACHMENT_HOSTS = Object.freeze({
    general: Object.freeze({
        typeId: null,
        label: "General",
        fields: Object.freeze([
            Object.freeze({ label: "objectId", type: "string" }),
            Object.freeze({ label: "name", type: "string" }),
        ]),
    }),
    road: Object.freeze({
        typeId: "road",
        label: "Road",
        fields: Object.freeze([
            Object.freeze({ label: "edgeId", type: "road_id" }),
            Object.freeze({ label: "name", type: "string" }),
        ]),
    }),
    group: Object.freeze({
        typeId: "group",
        label: "Group",
        fields: Object.freeze([
            Object.freeze({ label: "objectId", type: "string" }),
            Object.freeze({ label: "name", type: "string" }),
        ]),
    }),
    building: Object.freeze({
        typeId: "building",
        label: "Building",
        fields: Object.freeze([
            Object.freeze({ label: "buildingId", type: "string" }),
            Object.freeze({ label: "name", type: "string" }),
        ]),
    }),
    intersection: Object.freeze({
        typeId: "intersection",
        label: "Intersection",
        fields: Object.freeze([
            Object.freeze({ label: "nodeId", type: "string" }),
            Object.freeze({ label: "name", type: "string" }),
        ]),
    }),
    "builtin-prop": Object.freeze({
        typeId: "builtin-prop",
        label: "Prop",
        fields: Object.freeze([
            Object.freeze({ label: "objectId", type: "string" }),
            Object.freeze({ label: "assetId", type: "string" }),
            Object.freeze({ label: "name", type: "string" }),
        ]),
    }),
    "asset-instance": Object.freeze({
        typeId: "asset-instance",
        label: "Asset",
        fields: Object.freeze([
            Object.freeze({ label: "objectId", type: "string" }),
            Object.freeze({ label: "assetId", type: "string" }),
            Object.freeze({ label: "name", type: "string" }),
        ]),
    }),
});

export const ATTACHMENT_HOST_TYPE_IDS = Object.freeze(Object.keys(ATTACHMENT_HOSTS));

/** Placeable attachment blocks. The value is the host id they declare. */
export const ATTACHMENT_BLOCK_HOSTS = Object.freeze({
    GeneralAttachmentBlock: "general",
    RoadAttachmentBlock: "road",
    GroupAttachmentBlock: "group",
    BuildingAttachmentBlock: "building",
    IntersectionAttachmentBlock: "intersection",
    PropAttachmentBlock: "builtin-prop",
    AssetAttachmentBlock: "asset-instance",
});

export function normalizeHostType(value) {
    const text = String(value ?? "").trim();
    return ATTACHMENT_HOSTS[text] ? text : null;
}

/** Unique host type ids. Unknown entries are dropped. */
export function hostTypeList(value) {
    if (!Array.isArray(value)) return [];
    const found = [];
    for (const entry of value) {
        const host = normalizeHostType(entry);
        if (host && !found.includes(host)) found.push(host);
    }
    return found;
}

function sceneObjectHost(hostType) {
    const host = normalizeHostType(hostType);
    return host && ATTACHMENT_HOSTS[host].typeId ? host : null;
}

/** Allowed types on a program input. Empty means any object. General is not a scene type. */
export function programInputHostTypes(port) {
    const listed = hostTypeList(port?.sceneTypes).map(sceneObjectHost).filter(Boolean);
    if (listed.length > 0) return listed;
    const single = sceneObjectHost(port?.sceneType);
    return single ? [single] : [];
}

export function hostTypePhrase(types) {
    return types.join(" or ");
}

export function hostFields(hostType) {
    return ATTACHMENT_HOSTS[normalizeHostType(hostType)]?.fields ?? [];
}

function text(value) {
    return value == null ? "" : String(value);
}

/**
 * @param {string} hostType
 * @param {{ typeId?: string, objectId?: string, name?: string, edgeId?: string, buildingId?: string, nodeId?: string, assetId?: string }|null} attachment
 */
export function readAttachmentFields(hostType, attachment) {
    const normalized = normalizeHostType(hostType);
    const spec = ATTACHMENT_HOSTS[normalized ?? ""];
    const values = {};
    for (const field of spec?.fields ?? []) values[field.label] = "";
    if (!spec || !attachment) return { found: false, values };
    if (normalized !== "general" && attachment.typeId !== spec.typeId) {
        return { found: false, values };
    }
    const objectId = text(attachment.objectId);
    const name = text(attachment.name);
    if (normalized === "general") {
        values.objectId = objectId;
        values.name = name;
        return { found: true, values };
    }
    if (spec.typeId === "road") {
        values.edgeId = text(attachment.edgeId || objectId);
        values.name = name;
    } else if (spec.typeId === "group") {
        values.objectId = objectId;
        values.name = name;
    } else if (spec.typeId === "building") {
        values.buildingId = text(attachment.buildingId || objectId);
        values.name = name;
    } else if (spec.typeId === "intersection") {
        values.nodeId = text(attachment.nodeId || objectId);
        values.name = name;
    } else {
        values.objectId = objectId;
        values.assetId = text(attachment.assetId);
        values.name = name;
    }
    return { found: true, values };
}

function declaredHost(node) {
    if (node?.type === "DeriveFromAttachmentBlock") {
        return normalizeHostType(node.state?.hostType ?? node.storedData?.hostType) ?? "road";
    }
    return ATTACHMENT_BLOCK_HOSTS[node?.type] ?? null;
}

function collectHostTypes(source, found) {
    for (const node of source?.nodes ?? []) {
        const host = declaredHost(node);
        if (host) found.add(host);
        if (node?.state?.compiledProgram) collectHostTypes(node.state.compiledProgram, found);
    }
}

/**
 * One attachment host per script.
 * No attachment block, or only General Attachment, fits any object.
 */
export function scriptHostType(source) {
    const found = new Set();
    collectHostTypes(source, found);
    if (found.size > 1) {
        return {
            ok: false,
            hostType: null,
            typeId: null,
            error: `Script declares more than one attachment host (${[...found].join(", ")}).`,
        };
    }
    const hostType = found.size === 1 ? [...found][0] : null;
    const typeId = hostType ? ATTACHMENT_HOSTS[hostType]?.typeId ?? null : null;
    return {
        ok: true,
        hostType,
        typeId,
        error: null,
    };
}
