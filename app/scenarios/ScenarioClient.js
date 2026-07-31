import { storageDelete, storageGet, storagePost, storagePut } from "../client/storageClient.js";

const collection = "scenarios";

export function listScenarios() {
    return storageGet(collection);
}

export function getScenario(id) {
    return storageGet(`${collection}/${encodeURIComponent(id)}`);
}

export function createScenario(scenario) {
    return storagePost(collection, scenario);
}

export function saveScenario(id, scenario, expectedRevision) {
    return storagePut(`${collection}/${encodeURIComponent(id)}`, { scenario, expectedRevision });
}

export function duplicateScenario(id, input) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/duplicate`, input);
}

export function deleteScenario(id, expectedRevision) {
    const revision = expectedRevision === undefined ? "" : `?expectedRevision=${encodeURIComponent(expectedRevision)}`;
    return storageDelete(`${collection}/${encodeURIComponent(id)}${revision}`);
}

export function validateScenarioOnServer(id, scenario) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/validate`, { scenario });
}

export function resolveScenario(id, scenario = null) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/resolve`, scenario ? { scenario } : {});
}

export function verifyScenarioRoute(id, scenario, routeId) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/verify-route`, { scenario, routeId });
}

export function getScenarioCatalog() {
    return storageGet("scenario-catalog");
}

export function saveScenarioCatalog(catalog) {
    return storagePut("scenario-catalog", catalog);
}
