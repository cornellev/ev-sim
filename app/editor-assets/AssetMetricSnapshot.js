/** Pure ED-07 environment snapshot helpers for immutable asset metrics. */

import { hashAssetMetric, normalizeAssetMetric, validateAssetMetric } from "./AssetDefinition.js";
import { assetBindingRevisionVersion, readAssetBinding } from "./AssetBackedObject.js";

export const ASSET_METRICS_DOMAIN_VERSION = 1;

export function assetMetricKey(assetId, revision) {
    return `${String(assetId)}@${Number(revision)}`;
}

export function normalizeAssetMetricDefinition(value = {}) {
    const metric = normalizeAssetMetric({
        version: ASSET_METRICS_DOMAIN_VERSION,
        collision: value.collision,
        lidar: value.lidar,
    });
    return {
        assetId: String(value.assetId ?? "").trim(),
        revision: Number(value.revision),
        metricHash: String(value.metricHash ?? "").trim(),
        collision: metric.collision,
        lidar: metric.lidar,
    };
}

export function assetMetricDefinitionFromRevision(assetId, revision) {
    if (revision?.version !== 2) return null;
    return normalizeAssetMetricDefinition({
        assetId,
        revision: revision.revision,
        metricHash: revision.metricHash,
        collision: revision.metric?.collision,
        lidar: revision.metric?.lidar,
    });
}

export function validateAssetMetricDefinition(value = {}, path = []) {
    const issues = [];
    if (typeof value?.assetId !== "string" || !value.assetId.trim()) {
        issues.push({ path: [...path, "assetId"], code: "asset-metric.asset-id", message: "Asset metric definitions require an asset id.", severity: "error" });
    }
    if (!Number.isInteger(value?.revision) || value.revision <= 0) {
        issues.push({ path: [...path, "revision"], code: "asset-metric.revision", message: "Asset metric definitions require a positive revision.", severity: "error" });
    }
    const metric = { version: ASSET_METRICS_DOMAIN_VERSION, collision: value?.collision, lidar: value?.lidar };
    issues.push(...validateAssetMetric(metric).map((entry) => ({ ...entry, path: [...path, "metric", ...(entry.path ?? [])] })));
    if (issues.length === 0 && value.metricHash !== hashAssetMetric(metric)) {
        issues.push({ path: [...path, "metricHash"], code: "asset-metric.hash", message: "Asset metric hash does not match its canonical metric content.", severity: "error" });
    }
    return issues;
}

export function referencedV2AssetPins(document) {
    const pins = new Map();
    for (const record of document?.objects ?? []) {
        if (assetBindingRevisionVersion(record) !== 2) continue;
        const asset = readAssetBinding(record);
        if (!asset?.assetId || !Number.isInteger(asset.revision)) continue;
        pins.set(assetMetricKey(asset.assetId, asset.revision), {
            assetId: asset.assetId,
            revision: asset.revision,
        });
    }
    return pins;
}

export function validateAssetMetricsDomain(document) {
    const issues = [];
    const definitions = document?.assetMetrics?.definitions ?? [];
    if (document?.assetMetrics && document.assetMetrics.version !== ASSET_METRICS_DOMAIN_VERSION) {
        issues.push({ path: ["assetMetrics", "version"], code: "asset-metric.version", message: `Asset metrics version must be ${ASSET_METRICS_DOMAIN_VERSION}.`, severity: "error" });
    }
    const pins = referencedV2AssetPins(document);
    const seen = new Set();
    definitions.forEach((definition, index) => {
        const key = assetMetricKey(definition?.assetId, definition?.revision);
        if (seen.has(key)) issues.push({ path: ["assetMetrics", "definitions", index], code: "asset-metric.duplicate", message: `Asset metric definition "${key}" occurs more than once.`, severity: "error" });
        seen.add(key);
        issues.push(...validateAssetMetricDefinition(definition, ["assetMetrics", "definitions", index]));
        if (!pins.has(key)) issues.push({ path: ["assetMetrics", "definitions", index], code: "asset-metric.unused", message: `Asset metric definition "${key}" has no matching v2 instance.`, severity: "error" });
    });
    for (const [key, pin] of pins) {
        if (!seen.has(key)) issues.push({ path: ["assetMetrics", "definitions"], code: "asset-metric.missing", message: `Asset metric definition "${assetMetricKey(pin.assetId, pin.revision)}" is missing.`, severity: "error" });
    }
    return issues;
}

/** Mutate definitions inside an existing command transaction. */
export function reconcileAssetMetricDefinitions(document, additions = []) {
    const pins = referencedV2AssetPins(document);
    if (!document.assetMetrics && pins.size === 0 && additions.length === 0) return;
    const candidates = new Map((document.assetMetrics?.definitions ?? []).map((entry) => [assetMetricKey(entry.assetId, entry.revision), entry]));
    for (const definition of additions) {
        const normalized = normalizeAssetMetricDefinition(definition);
        candidates.set(assetMetricKey(normalized.assetId, normalized.revision), normalized);
    }
    const replacements = new Map();
    for (const [key, definition] of candidates) replacements.set(key, pins.has(key) ? definition : null);
    for (const key of pins.keys()) {
        if (!candidates.has(key)) throw new TypeError(`Asset metric definition "${key}" is required by a v2 instance.`);
    }
    document.replaceDomainRecords("assetMetrics.definitions", replacements, { notify: false });
}
