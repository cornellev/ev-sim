import { getRunSessionController } from "../../simulation/RunSessionController";

function invokeRunControl(data, manifestAction, legacyAction) {
    const sim = data?.simulation?.();
    const runState = getRunSessionController().getSnapshot();
    const result = runState.activeRunId ? manifestAction() : legacyAction(sim);
    result?.catch?.((error) => console.warn("Run control failed", error));
    return result;
}

export function playSimulation(data) {
    const runController = getRunSessionController();
    return invokeRunControl(data, () => runController.play(), (sim) => sim?.play());
}

export function pauseSimulation(data) {
    const runController = getRunSessionController();
    return invokeRunControl(data, () => runController.pause(), (sim) => sim?.pause());
}
