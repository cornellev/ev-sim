import { HeadlessEpisodeError } from "./HeadlessErrors.js";
import { canonicalEpisodeOverrides, initialStateWithStartPose } from "../kernel/SimulationHashes.js";
import { pavementPoseIssue } from "../world/DriveAreas.js";

export { initialStateWithStartPose };

export function episodeOverridesFromSpec(spec = {}) {
    return canonicalEpisodeOverrides(spec.overrides);
}

function finiteAxis(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export function manifestStartPose(resolvedRun) {
    const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    const vehicle = (resolvedRun?.manifest?.initialState?.vehicles || []).find((entry) => entry.id === egoId)
        ?? resolvedRun?.manifest?.initialState?.vehicles?.[0];
    return {
        x: finiteAxis(vehicle?.pose?.position?.x),
        z: finiteAxis(vehicle?.pose?.position?.z),
        yaw: finiteAxis(vehicle?.pose?.rotation?.y),
    };
}

export function assertStartPoseClear(resolvedRun, startPose) {
    const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    const vehicle = (resolvedRun?.vehicles || []).find((entry) => entry.actorId === egoId) ?? resolvedRun?.vehicles?.[0];
    const size = vehicle?.manifest?.boundingBox?.size;
    if (!size?.x || !size?.z) {
        throw new HeadlessEpisodeError("BUNDLE_INVALID", "A start pose override requires the ego footprint.");
    }
    const issue = pavementPoseIssue(resolvedRun?.world?.description, startPose, size);
    if (issue) throw new HeadlessEpisodeError("INVALID_REQUEST", issue);
}

export function goalReached(pose, goal) {
    if (!pose || !goal) return false;
    const distance = Math.hypot(pose.x - goal.x, pose.z - goal.z);
    if (distance > goal.positionToleranceM) return false;
    if (goal.yaw == null || !Number.isFinite(goal.yaw)) return true;
    const delta = Math.atan2(Math.sin(pose.yaw - goal.yaw), Math.cos(pose.yaw - goal.yaw));
    return Math.abs(delta) <= goal.yawToleranceRad;
}
