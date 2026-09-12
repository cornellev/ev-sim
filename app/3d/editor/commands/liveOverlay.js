/**
 * Keep the in-session object overlay complete after a committed command:
 * records appear for legacy entities a command created without one, and
 * records whose legacy counterpart vanished (a removed edge, a demoted
 * junction) are dropped. After this, save-time reconciliation is a no-op.
 */

import { reconcileObjectGraph } from "../objects/objectGraph.js";
import { objectTypeRegistry } from "../objects/ObjectTypeRegistry.js";

/**
 * @returns {{ added: string[], orphaned: string[] }}
 */
export function reconcileLiveOverlay(document, registry = objectTypeRegistry, sky = null) {
    const { records, added, orphaned } = reconcileObjectGraph(document.snapshot(), document.objects, registry, { sky });
    if (added.length > 0 || orphaned.length > 0) {
        document.replaceObjectGraph(records, { notify: false });
    }
    return { added, orphaned };
}
