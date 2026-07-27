export function selectDirtyGuard(guards) {
    return [...guards].find((guard) => guard?.dirty) || null;
}

export async function applyWorkspaceDecision({ decision, guard, navigate }) {
    if (decision === "stay") return false;
    if (decision === "save") await guard?.save?.();
    if (decision === "discard") await guard?.discard?.();
    navigate();
    return true;
}
