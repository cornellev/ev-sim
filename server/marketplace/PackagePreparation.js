import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "./MarketplaceJson.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const STAGING_NAME = /^e[0-9]{6}$/u;

function invalid(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message);
}

function digest(value, label) {
    if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} is not a lowercase SHA-256 digest.`);
    return value;
}

function exactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is not an object.`);
    const expected = new Set(keys);
    if (keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !expected.has(key))) {
        invalid(`${label} has an invalid shape.`);
    }
}

function normalizedEntries(entries) {
    return entries.map(({ name, stagingName, sizeBytes, sha256 }) => ({ name, stagingName, sizeBytes, sha256 }));
}

export function packagePreparationHash({ archiveSha256, manifestSha256, entries }) {
    return createHash("sha256").update(canonicalMarketplaceBytes({
        archiveSha256: digest(archiveSha256, "Preparation archive hash"),
        manifestSha256: digest(manifestSha256, "Preparation manifest hash"),
        entries: normalizedEntries(entries),
    })).digest("hex");
}

export function createPackagePreparationIndex({ kind, archiveSha256, manifestSha256, entries }) {
    const normalized = normalizedEntries(entries);
    const preparationHash = packagePreparationHash({ archiveSha256, manifestSha256, entries: normalized });
    return {
        preparationHash,
        index: {
            kind,
            version: 1,
            preparationHash,
            archiveSha256,
            manifestSha256,
            entries: normalized,
        },
    };
}

async function verifyFile(filePath, descriptor) {
    const node = await fs.lstat(filePath);
    if (!node.isFile() || node.isSymbolicLink()) invalid(`Prepared entry ${descriptor.name} is not a regular file.`);
    const handle = await fs.open(filePath, "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== node.dev || stat.ino !== node.ino || stat.size !== descriptor.sizeBytes) {
            invalid(`Prepared entry ${descriptor.name} has changed size or type.`);
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < stat.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
            if (bytesRead === 0) invalid(`Prepared entry ${descriptor.name} ended before its declared size.`);
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        if (hash.digest("hex") !== descriptor.sha256) invalid(`Prepared entry ${descriptor.name} failed its content hash.`);
    } finally {
        await handle.close();
    }
}

export async function readPackagePreparation({
    workDirectory,
    directoryName,
    preparationHash,
    archiveSha256 = null,
    kind,
    manifestName = "manifest.json",
    recordPrefix = "records/sha256/",
    blobPrefix = "blobs/sha256/",
}) {
    digest(preparationHash, "Preparation hash");
    const preparationDir = path.join(workDirectory, directoryName, preparationHash);
    const indexBytes = await fs.readFile(path.join(preparationDir, "preparation.json"));
    const { document } = parseMarketplaceJsonBytes(indexBytes);
    exactKeys(document, ["kind", "version", "preparationHash", "archiveSha256", "manifestSha256", "entries"], "Preparation index");
    if (document.kind !== kind || document.version !== 1
        || !indexBytes.equals(Buffer.from(canonicalMarketplaceBytes(document)))) invalid("Package preparation index is not canonical or has the wrong contract.");
    digest(document.archiveSha256, "Preparation archive hash");
    digest(document.manifestSha256, "Preparation manifest hash");
    if (document.preparationHash !== preparationHash
        || (archiveSha256 && document.archiveSha256 !== archiveSha256)) invalid("Package preparation identity does not match the frozen plan.");
    if (!Array.isArray(document.entries) || Object.keys(document.entries).length !== document.entries.length || document.entries.length === 0) {
        invalid("Package preparation entries must be a non-empty dense array.");
    }
    const names = new Set();
    const stagingNames = new Set();
    const entries = document.entries.map((entry, index) => {
        exactKeys(entry, ["name", "stagingName", "sizeBytes", "sha256"], `Preparation entry ${index}`);
        if (typeof entry.name !== "string" || !STAGING_NAME.test(entry.stagingName)
            || entry.stagingName !== `e${String(index).padStart(6, "0")}`
            || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) invalid(`Preparation entry ${index} has invalid metadata.`);
        digest(entry.sha256, `Preparation entry ${index} hash`);
        if (names.has(entry.name) || stagingNames.has(entry.stagingName)) invalid("Package preparation contains duplicate entry identities.");
        names.add(entry.name);
        stagingNames.add(entry.stagingName);
        if (index === 0) {
            if (entry.name !== manifestName || entry.sha256 !== document.manifestSha256) invalid("Package preparation manifest identity is invalid.");
        } else {
            const prefix = entry.name.startsWith(recordPrefix) ? recordPrefix
                : entry.name.startsWith(blobPrefix) ? blobPrefix : null;
            if (!prefix || entry.name.slice(prefix.length) !== entry.sha256) invalid(`Prepared entry ${entry.name} is outside its digest namespace.`);
        }
        return { ...entry, path: path.join(preparationDir, entry.stagingName) };
    });
    const expectedNames = [
        manifestName,
        ...entries.slice(1).filter((entry) => entry.name.startsWith(recordPrefix)).map((entry) => entry.name).sort(compareUtf8),
        ...entries.slice(1).filter((entry) => entry.name.startsWith(blobPrefix)).map((entry) => entry.name).sort(compareUtf8),
    ];
    if (expectedNames.length !== entries.length || entries.some((entry, index) => entry.name !== expectedNames[index])) {
        invalid("Package preparation entries are not in canonical namespace order.");
    }
    if (packagePreparationHash(document) !== preparationHash) invalid("Package preparation hash does not authenticate its index entries.");
    for (const entry of entries) await verifyFile(entry.path, entry);
    const byName = new Map(entries.map((entry) => [entry.name, Object.freeze(entry)]));
    return Object.freeze({
        preparationDir,
        document,
        entries: Object.freeze([...byName.values()]),
        entry(name) {
            const descriptor = byName.get(name);
            if (!descriptor) invalid(`Prepared package entry ${name} is missing.`);
            return descriptor;
        },
    });
}
