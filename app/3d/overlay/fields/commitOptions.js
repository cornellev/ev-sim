import { objectCommands } from "../../editor/commands/index.js";

/**
 * Commit option edits for the selection: one record → `setObjectOptions`,
 * several → `setObjectsOptions` (atomic). Returns the bus result so callers
 * can map `issues` back to fields.
 */
export function commitObjectOptions({ data, objectIds = [], patch, label = "Edit options" }) {
    const bus = data?.commands?.();
    if (!bus) return { ok: false, issues: [], error: "No command bus." };
    const ids = [...objectIds].map(String);
    const command = ids.length > 1
        ? objectCommands.setObjectsOptions({ objectIds: ids, patch, label })
        : objectCommands.setObjectOptions({ objectId: ids[0], patch, label });
    const result = bus.execute(command);
    data?.simulation?.()?.render?.();
    return result;
}
