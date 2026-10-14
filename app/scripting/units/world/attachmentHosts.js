/**
 * Host fields a Derive From Attachment block can read. Kernel-safe.
 * The object id of a road, building, or intersection is the legacy id.
 */

export const ATTACHMENT_HOSTS = Object.freeze({
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

export function normalizeHostType(value) {
    const text = String(value ?? "").trim();
    return ATTACHMENT_HOSTS[text] ? text : null;
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
    const spec = ATTACHMENT_HOSTS[normalizeHostType(hostType) ?? ""];
    const values = {};
    for (const field of spec?.fields ?? hostFields(hostType)) values[field.label] = "";
    if (!spec || !attachment || attachment.typeId !== spec.typeId) {
        return { found: false, values };
    }
    const objectId = text(attachment.objectId);
    const name = text(attachment.name);
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

function collectHostTypes(source, found) {
    for (const node of source?.nodes ?? []) {
        if (node?.type === "DeriveFromAttachmentBlock") {
            found.add(normalizeHostType(node.state?.hostType ?? node.storedData?.hostType) ?? "road");
        }
        if (node?.state?.compiledProgram) collectHostTypes(node.state.compiledProgram, found);
    }
}

/** One host type per script. No derive block means the script can attach to any object. */
export function scriptHostType(source) {
    const found = new Set();
    collectHostTypes(source, found);
    if (found.size > 1) {
        return {
            ok: false,
            hostType: null,
            typeId: null,
            error: `Script derives from more than one host type (${[...found].join(", ")}).`,
        };
    }
    const hostType = found.size === 1 ? [...found][0] : null;
    return {
        ok: true,
        hostType,
        typeId: hostType ? ATTACHMENT_HOSTS[hostType].typeId : null,
        error: null,
    };
}
