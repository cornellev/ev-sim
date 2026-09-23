const INACTIVE = Object.freeze({ active: false, locked: false, label: "" });

let current = null;
let unsubscribe = () => {};
const listeners = new Set();

function emit() {
    for (const listener of listeners) listener();
}

export function attachPerspectiveView(controller) {
    if (!controller || current === controller) return;
    unsubscribe();
    current = controller;
    unsubscribe = controller.subscribe(() => emit());
    emit();
}

export function detachPerspectiveView(controller) {
    if (!current || (controller && current !== controller)) return;
    unsubscribe();
    unsubscribe = () => {};
    current = null;
    emit();
}

export function getPerspectiveViewSnapshot() {
    return current?.getSnapshot?.() ?? INACTIVE;
}

export function subscribePerspectiveView(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
