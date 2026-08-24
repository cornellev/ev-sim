import {
    storageDelete,
    storageGet,
    storagePatch,
    storagePost,
    storagePut,
} from "../../client/storageClient.js";

const ACTIVE_ENVIRONMENT_SETTING = "activeEnvironmentId";

export function listEnvironments() {
    return storageGet("environments");
}

export function getEnvironmentManifest(environmentId) {
    return storageGet(`environments/${encodeURIComponent(environmentId)}`);
}

export function saveEnvironmentManifest(environmentId, manifest) {
    return storagePut(`environments/${encodeURIComponent(environmentId)}`, manifest);
}

export function createEnvironment(input) {
    return storagePost("environments", input);
}

export function duplicateEnvironment(sourceId, input) {
    return storagePost(`environments/${encodeURIComponent(sourceId)}/duplicate`, input);
}

export function renameEnvironment(environmentId, name) {
    return storagePatch(`environments/${encodeURIComponent(environmentId)}`, { name });
}

export function changeEnvironmentId(environmentId, nextEnvironmentId) {
    return storagePatch(`environments/${encodeURIComponent(environmentId)}/id`, {
        id: nextEnvironmentId,
    });
}

export function deleteEnvironment(environmentId) {
    return storageDelete(`environments/${encodeURIComponent(environmentId)}`);
}

export async function getActiveEnvironmentId() {
    const result = await storageGet(`settings/${ACTIVE_ENVIRONMENT_SETTING}`);
    return result?.value || "igvc";
}

export async function setActiveEnvironmentId(environmentId) {
    await storagePut(`settings/${ACTIVE_ENVIRONMENT_SETTING}`, { value: environmentId });
    return environmentId;
}

export function environmentIdFromName(name) {
    const slug = String(name ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || `environment-${Date.now().toString(36)}`;
}

