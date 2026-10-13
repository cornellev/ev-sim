/**
 * One axle edit against a captured manifest. The editor undo stack records
 * the commit; this controller does not keep its own history.
 */

import { canonicalStringify } from "../../simulation/canonicalJson.js";
import { cloneJson } from "../../util/cloneJson.js";
import { applyAxlePatch } from "../document/vehicleCommands.js";

export function createAxleGesture(manifest, { axle } = {}) {
    const capture = cloneJson(manifest);
    let latest = capture;
    let issues = [];
    let ok = true;

    const result = (changed = false) => ({
        ok,
        changed,
        manifest: cloneJson(latest),
        issues: issues.slice(),
    });

    return {
        axle,
        capture() {
            return cloneJson(capture);
        },
        preview(patch = {}) {
            const applied = applyAxlePatch(capture, { axle, patch });
            if (!applied.ok) {
                latest = capture;
                ok = false;
                issues = applied.issues ?? [];
                return result(false);
            }
            latest = applied.manifest;
            ok = true;
            issues = [];
            return result(canonicalStringify(latest) !== canonicalStringify(capture));
        },
        commit() {
            return result(ok && canonicalStringify(latest) !== canonicalStringify(capture));
        },
    };
}
