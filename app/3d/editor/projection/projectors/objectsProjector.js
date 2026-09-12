/**
 * Object records: editor visibility (`editorHidden`, inherited through
 * groups) and labels. Groups have no runtime object; their state projects
 * onto descendants' entities.
 */

import { descendantIds, indexObjectsById, parentIdOf } from "../../commands/objectMutations.js";
import { entityIdForObject } from "../../selection/selectionIds.js";

export function isObjectHidden(byId, id) {
    let cursor = byId.get(String(id));
    const seen = new Set();
    while (cursor) {
        if (cursor.components?.editorHidden === true) return true;
        const parent = parentIdOf(cursor);
        if (parent === null || seen.has(parent)) return false;
        seen.add(parent);
        cursor = byId.get(parent);
    }
    return false;
}

export function createObjectsProjector() {
    return {
        id: "objects",
        apply({ changeSet, registry, document }) {
            const domain = changeSet.domains?.objects;
            if (!domain || !registry) return;
            const byId = indexObjectsById(document.objects);
            const affected = new Set();
            for (const id of domain.after.keys()) {
                affected.add(String(id));
                for (const descendant of descendantIds(byId, id)) affected.add(descendant);
            }
            let labelsChanged = false;
            for (const id of affected) {
                const record = byId.get(id);
                if (!record) continue;
                const entityId = entityIdForObject(record, registry);
                if (!entityId) continue;
                const entity = registry.getEntity(entityId);
                if (!entity) continue;
                const hidden = isObjectHidden(byId, id);
                if ((entity.visible === false) !== hidden) registry.setEntityVisible(entityId, !hidden);
                if (record.name && entity.label !== record.name) {
                    entity.label = record.name;
                    labelsChanged = true;
                }
            }
            if (labelsChanged) registry.notify();
        },
    };
}
