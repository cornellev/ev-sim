import { promises as fs } from "node:fs";
import path from "node:path";

import { PLUGIN_ERROR_CODES, pluginError } from "../../app/plugin/PluginErrors.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { planPluginRetarget } from "../../app/plugin/PluginRetarget.js";
import { installDetectedPlugin } from "./localPlugins.js";
import { localBuildsPath } from "./plantBuild.js";

function emptyUpdated() {
    return { vehicles: [], scripts: [], runManifests: [] };
}

function manualOnly(entry) {
    return entry?.ownership?.manual === true && (entry.ownership.marketplace?.length ?? 0) === 0;
}

function sortedIds(documents) {
    return documents.map((document) => document.id).sort((left, right) => left.localeCompare(right));
}

async function readOptional(filePath) {
    if (!filePath) return null;
    try {
        return await fs.readFile(filePath);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function restoreOptional(filePath, bytes) {
    if (!filePath) return;
    if (bytes === null) {
        await fs.rm(filePath, { force: true });
        return;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
}

async function loadById(list, read) {
    const documents = [];
    for (const summary of await list()) {
        const document = await read(summary.id);
        if (document) documents.push(document);
    }
    return documents;
}

function packageDeclarations(verified) {
    return {
        pluginId: verified.document.id,
        version: verified.document.version,
        packageHash: verified.resource.packageHash,
        runtimeHash: verified.resource.runtimeHash,
        sensorTypes: (verified.document.sensorTypes ?? []).map((entry) => entry.type),
        plants: (verified.document.plants ?? []).map((entry) => entry.id),
        unitTypes: (verified.document.units ?? []).map((entry) => entry.type),
        capabilities: [...(verified.document.capabilities ?? [])],
    };
}

/**
 * Pack or rebuild a detected local plugin, replace its other manual library
 * rows, and retarget saved vehicle, script, and run-manifest pins.
 *
 * @param {{
 *   plugins: { snapshotWithOwners: () => Promise<{ packages: object[], revision: number }>, root?: string },
 *   installPluginFromDirectory: (directory: string) => Promise<object>,
 *   getPluginPackage: (packageHash: string) => Promise<object>,
 *   listPluginLibrary: () => Promise<{ revision: number, packages: object[] }>,
 *   listVehicleManifests: () => Promise<Array<{ id: string }>>,
 *   getVehicleManifest: (id: string) => Promise<object|null>,
 *   putVehicleManifest: (id: string, input: object) => Promise<unknown>,
 *   listScripts: () => Promise<object[]>,
 *   putScript: (document: object) => Promise<unknown>,
 *   listRunManifests: () => Promise<Array<{ id: string }>>,
 *   getRunManifest: (id: string) => Promise<object|null>,
 *   putRunManifest: (id: string, input: object) => Promise<unknown>,
 *   removePluginFromLibrary: (pluginId: string, packageHash: string) => Promise<unknown>,
 * }} storage
 * @param {string} directory
 * @param {string} [root]
 * @param {object} [options]
 */
export async function reimportDetectedPlugin(storage, directory, root, options = {}) {
    const storeRoot = options.storeRoot || storage.plugins?.root;
    const buildsFile = storeRoot ? localBuildsPath(storeRoot) : null;
    const previousBuilds = await readOptional(buildsFile);
    const before = await storage.plugins.snapshotWithOwners();
    const metadata = await installDetectedPlugin(storage, directory, root, options);
    const after = await storage.plugins.snapshotWithOwners();
    const addedManual = !before.packages.some((entry) => entry.pluginId === metadata.pluginId
        && entry.packageHash === metadata.packageHash
        && entry.ownership?.manual === true);
    const superseded = after.packages.filter((entry) => entry.pluginId === metadata.pluginId
        && entry.packageHash !== metadata.packageHash
        && manualOnly(entry));
    if (superseded.length === 0) {
        return {
            unchanged: !addedManual,
            package: metadata,
            revision: after.revision,
            updated: emptyUpdated(),
        };
    }

    const verified = verifyPluginPackage(await storage.getPluginPackage(metadata.packageHash));
    const plan = planPluginRetarget({
        vehicles: await loadById(() => storage.listVehicleManifests(), (id) => storage.getVehicleManifest(id)),
        scripts: await storage.listScripts(),
        runManifests: await loadById(() => storage.listRunManifests(), (id) => storage.getRunManifest(id)),
        superseded: superseded.map((entry) => ({ packageHash: entry.packageHash, runtimeHash: entry.runtimeHash })),
        next: packageDeclarations(verified),
    });
    if (!plan.ok) {
        await rollbackImport({ storage, metadata, addedManual, buildsFile, previousBuilds });
        const detail = plan.rejections.map((entry) => entry.message).join("; ");
        throw pluginError(
            PLUGIN_ERROR_CODES.DOCUMENT_INVALID,
            `Cannot reimport "${metadata.pluginId}" because ${detail}.`,
            { pluginId: metadata.pluginId, packageHash: metadata.packageHash, details: { documents: plan.rejections } },
        );
    }

    for (const manifest of plan.vehicles) {
        await storage.putVehicleManifest(manifest.id, { manifest, expectedRevision: manifest.revision });
    }
    for (const manifest of plan.runManifests) {
        await storage.putRunManifest(manifest.id, { manifest, expectedRevision: manifest.revision });
    }
    const updatedAt = new Date().toISOString();
    for (const document of plan.scripts) {
        await storage.putScript({ ...document, updatedAt });
    }
    for (const entry of superseded) {
        await storage.removePluginFromLibrary(entry.pluginId, entry.packageHash);
    }
    const library = await storage.listPluginLibrary();
    return {
        unchanged: false,
        package: metadata,
        revision: library.revision,
        updated: {
            vehicles: sortedIds(plan.vehicles),
            scripts: sortedIds(plan.scripts),
            runManifests: sortedIds(plan.runManifests),
        },
    };
}

async function rollbackImport({ storage, metadata, addedManual, buildsFile, previousBuilds }) {
    try {
        if (addedManual) await storage.removePluginFromLibrary(metadata.pluginId, metadata.packageHash);
    } finally {
        await restoreOptional(buildsFile, previousBuilds);
    }
}
