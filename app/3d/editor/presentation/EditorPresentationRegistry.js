/**
 * EditorPresentationRegistry: per-type icons, menu options, inspector
 * sections, and optional previews for the hierarchy and inspector. Hierarchy
 * and inspector consume presentations exclusively, so a new object type
 * appears in both by registering one, without editing those components.
 *
 * Pure JavaScript (icons and renderers are opaque values supplied by the
 * browser module that registers them). Unregistered types fall back to a
 * default presentation derived from the object type's capabilities and
 * fields.
 */

import { objectTypeRegistry } from "../objects/ObjectTypeRegistry.js";
import { legacyIndex, readObjectOptionValue, readObjectTransform } from "../objects/objectGraph.js";
import { GROUP_TYPE_ID } from "../objects/types/group.js";
import { text } from "../objects/ObjectOptions.js";

export const MENU_OPTION_IDS = Object.freeze({
    RENAME: "rename",
    DUPLICATE: "duplicate",
    GROUP: "group",
    UNGROUP: "ungroup",
    DELETE: "delete",
    HIDE: "hide",
    SHOW: "show",
    LOCK: "lock",
    UNLOCK: "unlock",
    FRAME: "frame",
});

export const SECTION_IDS = Object.freeze({
    OBJECT: "object",
    TRANSFORM: "transform",
    OPTIONS: "options",
    UNSUPPORTED: "unsupported",
});

function definitionFor(objectRegistry, record) {
    return objectRegistry.get(record?.typeId, record?.typeVersion) ?? objectRegistry.get(record?.typeId) ?? null;
}

function capabilitiesFor(objectRegistry, record) {
    const definition = definitionFor(objectRegistry, record);
    return definition?.getCapabilities?.(record) ?? { selectable: true, transformable: false, deletable: false, groupable: false, hasOptions: false };
}

/**
 * Standard menu options derived from capabilities. `ctx` supplies
 * `{ record, records, commands, bus, selection, document, focus }`.
 */
export function defaultMenuOptions(ctx, { objectRegistry = objectTypeRegistry } = {}) {
    const record = ctx?.record ?? null;
    if (!record) return [];
    const records = Array.isArray(ctx.records) && ctx.records.length > 0 ? ctx.records : [record];
    const ids = records.map((entry) => String(entry.id));
    const caps = records.map((entry) => capabilitiesFor(objectRegistry, entry));
    const every = (key) => caps.every((entry) => entry?.[key] === true);
    const allGroups = records.every((entry) => entry.typeId === GROUP_TYPE_ID);
    const anyHidden = records.some((entry) => entry.components?.editorHidden === true);
    const anyLocked = records.some((entry) => entry.components?.locked === true);
    const run = (factory, args) => () => ctx.bus?.execute?.(factory(args));
    const commands = ctx.commands ?? {};
    const options = [];
    if (records.length === 1 && typeof ctx.beginRename === "function") {
        options.push({ id: MENU_OPTION_IDS.RENAME, label: "Rename", shortcut: "Enter", run: () => ctx.beginRename(record.id) });
    }
    if (typeof ctx.focus === "function") {
        options.push({ id: MENU_OPTION_IDS.FRAME, label: "Frame selection", shortcut: "F", run: () => ctx.focus(ids) });
    }
    if (commands.duplicateObjects) {
        options.push({ id: MENU_OPTION_IDS.DUPLICATE, label: "Duplicate", shortcut: "Mod+D", disabled: !every("deletable"), run: run(commands.duplicateObjects, { objectIds: ids }) });
    }
    if (commands.groupObjects) {
        options.push({ id: MENU_OPTION_IDS.GROUP, label: "Group", shortcut: "Mod+G", disabled: !every("groupable"), run: run(commands.groupObjects, { objectIds: ids }) });
    }
    if (commands.ungroupObjects && allGroups) {
        options.push({ id: MENU_OPTION_IDS.UNGROUP, label: "Ungroup", shortcut: "Shift+Mod+G", run: run(commands.ungroupObjects, { objectIds: ids }) });
    }
    if (commands.setObjectsHidden) {
        options.push(anyHidden
            ? { id: MENU_OPTION_IDS.SHOW, label: "Show", run: run(commands.setObjectsHidden, { objectIds: ids, hidden: false }) }
            : { id: MENU_OPTION_IDS.HIDE, label: "Hide", run: run(commands.setObjectsHidden, { objectIds: ids, hidden: true }) });
    }
    if (commands.setObjectsLocked) {
        options.push(anyLocked
            ? { id: MENU_OPTION_IDS.UNLOCK, label: "Unlock", run: run(commands.setObjectsLocked, { objectIds: ids, locked: false }) }
            : { id: MENU_OPTION_IDS.LOCK, label: "Lock", run: run(commands.setObjectsLocked, { objectIds: ids, locked: true }) });
    }
    if (commands.deleteObjects) {
        options.push({ id: MENU_OPTION_IDS.DELETE, label: "Delete", shortcut: "Delete", danger: true, disabled: !every("deletable") || anyLocked, run: run(commands.deleteObjects, { objectIds: ids }) });
    }
    return options;
}

/**
 * Field values for a record projected through its options (`fromLegacy`).
 * `fields` are the descriptors that apply to the current value (types may
 * hide groups by mode); `allFields` is the complete descriptor list.
 */
export function readObjectFieldValues(record, document, { objectRegistry = objectTypeRegistry, sky = null } = {}) {
    const definition = definitionFor(objectRegistry, record);
    if (!definition?.options) return { fields: [], allFields: [], values: null };
    const index = document?.index?.() ?? legacyIndex(document?.snapshot?.() ?? document ?? {});
    const resolvedSky = sky ?? document?.sky ?? null;
    const values = readObjectOptionValue(record, index, objectRegistry, { sky: resolvedSky });
    return {
        fields: [...definition.options.getFields({ record, value: values })],
        allFields: [...definition.options.getFields({ record })],
        values,
    };
}

/** Standard inspector sections: object record, transform, options, unsupported notice. */
export function defaultInspectorSections(ctx, { objectRegistry = objectTypeRegistry } = {}) {
    const record = ctx?.record ?? null;
    if (!record) return [];
    const definition = definitionFor(objectRegistry, record);
    const sections = [{ id: SECTION_IDS.OBJECT, title: "Object", kind: "object", record }];
    if (!definition) {
        sections.push({ id: SECTION_IDS.UNSUPPORTED, title: "Unsupported type", kind: "unsupported", typeId: record.typeId, typeVersion: record.typeVersion });
        return sections;
    }
    const transform = ctx.document ? readObjectTransform(record, ctx.document, objectRegistry, { sky: ctx.sky ?? null }) : null;
    if (transform) {
        sections.push({ id: SECTION_IDS.TRANSFORM, title: "Transform", kind: "transform", transform, editable: record.typeId === GROUP_TYPE_ID });
    }
    if (definition.options) {
        const { fields, values } = readObjectFieldValues(record, ctx.document, { objectRegistry, sky: ctx.sky ?? null });
        if (fields.length > 0) sections.push({ id: SECTION_IDS.OPTIONS, title: "Options", kind: "options", fields, values });
    }
    return sections;
}

export function createDefaultPresentation(typeId, { objectRegistry = objectTypeRegistry } = {}) {
    const definition = objectRegistry.get(typeId);
    return Object.freeze({
        typeId: text(typeId, "unknown"),
        label: definition?.label ?? text(typeId, "Object"),
        icon: null,
        supported: Boolean(definition),
        getMenuOptions: (ctx) => defaultMenuOptions(ctx, { objectRegistry }),
        getInspectorSections: (ctx) => defaultInspectorSections(ctx, { objectRegistry }),
        renderPreview: null,
    });
}

export class EditorPresentationRegistry {
    constructor({ objectRegistry = objectTypeRegistry } = {}) {
        this.objectRegistry = objectRegistry;
        this.presentations = new Map();
        this.subscribers = new Set();
    }

    /**
     * @param {string} typeId
     * @param {{ icon?: any, label?: string, getMenuOptions?: Function, getInspectorSections?: Function, renderPreview?: Function }} presentation
     */
    register(typeId, presentation = {}) {
        const id = text(typeId);
        if (!id) throw new TypeError("Presentations require a typeId.");
        const fallback = createDefaultPresentation(id, { objectRegistry: this.objectRegistry });
        const merged = Object.freeze({
            typeId: id,
            label: text(presentation.label, fallback.label),
            icon: presentation.icon ?? null,
            supported: Boolean(this.objectRegistry.get(id)),
            getMenuOptions: typeof presentation.getMenuOptions === "function"
                ? (ctx) => presentation.getMenuOptions(ctx, fallback.getMenuOptions(ctx))
                : fallback.getMenuOptions,
            getInspectorSections: typeof presentation.getInspectorSections === "function"
                ? (ctx) => presentation.getInspectorSections(ctx, fallback.getInspectorSections(ctx))
                : fallback.getInspectorSections,
            renderPreview: typeof presentation.renderPreview === "function" ? presentation.renderPreview : null,
        });
        this.presentations.set(id, merged);
        this.notify();
        return merged;
    }

    unregister(typeId) {
        const removed = this.presentations.delete(text(typeId));
        if (removed) this.notify();
        return removed;
    }

    has(typeId) {
        return this.presentations.has(text(typeId));
    }

    /** Registered presentation or the default one for the type. */
    get(typeId) {
        return this.presentations.get(text(typeId)) ?? createDefaultPresentation(text(typeId), { objectRegistry: this.objectRegistry });
    }

    forRecord(record) {
        return this.get(record?.typeId);
    }

    list() {
        return [...this.presentations.values()].sort((left, right) => left.typeId.localeCompare(right.typeId));
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.list());
        return () => this.subscribers.delete(callback);
    }

    notify() {
        const list = this.list();
        this.subscribers.forEach((callback) => callback(list));
    }
}

export const editorPresentationRegistry = new EditorPresentationRegistry();

export function createEditorPresentationRegistry(options) {
    return new EditorPresentationRegistry(options);
}
