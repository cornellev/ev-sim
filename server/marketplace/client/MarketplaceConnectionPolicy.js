import { promises as fs } from "node:fs";
import { createPrivateKey } from "node:crypto";
import path from "node:path";

import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { lstatOrNull, readRegularBytes } from "../registry/RegistryFs.js";
import { assertCredentialDocument, marketplaceClientPaths, parseLocalDocument } from "./MarketplaceClientLayout.js";
import { parseMarketplaceConnectionDocument } from "./MarketplaceConnectionDocuments.js";

const CONNECTION_FILE = "connection.json";
const MAX_CONNECTION_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 1024 * 1024;

function configError(message, pathName = null, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, message, { path: pathName, cause });
}

async function requirePrivateDirectory(directory) {
    const stat = await lstatOrNull(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw configError("Marketplace connection bundle must be an owner-only regular directory.", directory);
    }
}

async function readPrivateFile(bundleDirectory, relativePath, { maxBytes = MAX_SECRET_BYTES, utf8 = false } = {}) {
    const filePath = path.resolve(bundleDirectory, relativePath);
    const relative = path.relative(bundleDirectory, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw configError("Marketplace connection file escapes its bundle.", filePath);
    const stat = await lstatOrNull(filePath);
    if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw configError("Marketplace connection file must be an owner-only regular file.", filePath);
    }
    const bytes = await readRegularBytes(filePath, { maxBytes });
    return utf8 ? bytes.toString("utf8") : bytes;
}

function publicConnection(connection, index) {
    return Object.freeze({
        origin: connection.document.origin,
        displayName: connection.document.displayName,
        trustedRootSha256: connection.document.trustedRootSha256,
        priority: (index + 1) * 10,
        autoApprovePublisherIds: Object.freeze([...connection.document.autoApprovePublisherIds]),
        publishingIdentities: Object.freeze(connection.document.publishingIdentities.map((identity) => Object.freeze({
            name: identity.name,
            publisherId: identity.publisherId,
            default: identity.default,
            defaults: identity.defaults,
        }))),
    });
}

export class MarketplaceConnectionPolicy {
    constructor(directory, connections) {
        this.directory = directory;
        this.connections = connections;
        this.byOrigin = new Map(connections.map((entry) => [entry.document.origin, entry]));
    }

    static async open(dataDir, { directory = null } = {}) {
        const paths = marketplaceClientPaths(dataDir);
        const resolved = path.resolve(directory ?? paths.connections);
        const exists = await lstatOrNull(resolved);
        if (!exists) {
            if (directory) throw configError("Configured Marketplace connection directory does not exist.", resolved);
            await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
            await fs.chmod(resolved, 0o700);
        }
        await requirePrivateDirectory(resolved);
        const entries = [];
        for (const dirent of await fs.readdir(resolved, { withFileTypes: true })) {
            const bundleDirectory = path.join(resolved, dirent.name);
            if (!dirent.isDirectory() || dirent.isSymbolicLink()) throw configError("Marketplace connection directory contains an unexpected node.", bundleDirectory);
            await requirePrivateDirectory(bundleDirectory);
            const bytes = await readPrivateFile(bundleDirectory, CONNECTION_FILE, { maxBytes: MAX_CONNECTION_BYTES });
            const document = parseMarketplaceConnectionDocument(bytes);
            const credentialBytes = await readPrivateFile(bundleDirectory, document.readCredentialFile, { maxBytes: MAX_SECRET_BYTES });
            const credential = parseLocalDocument(credentialBytes, assertCredentialDocument);
            const identities = [];
            for (const identity of document.publishingIdentities) {
                const writeToken = (await readPrivateFile(bundleDirectory, identity.writeTokenFile, { maxBytes: 8 * 1024, utf8: true })).trim();
                const privateKeyPem = await readPrivateFile(bundleDirectory, identity.privateKeyFile, { maxBytes: 96 * 1024, utf8: true });
                if (!writeToken || /[\u0000-\u0020\u007f]/u.test(writeToken)) throw configError("Marketplace publisher token is invalid.", bundleDirectory);
                let privateKey;
                try { privateKey = createPrivateKey(privateKeyPem); }
                catch (error) { throw configError("Marketplace publisher private key is invalid.", identity.privateKeyFile, error); }
                if (privateKey.asymmetricKeyType !== "ed25519") throw configError("Marketplace publisher private key must be Ed25519.", identity.privateKeyFile);
                identities.push(Object.freeze({ ...identity, writeToken, privateKeyPem }));
            }
            entries.push(Object.freeze({ bundleDirectory, document, credential, identities: Object.freeze(identities) }));
        }
        entries.sort((left, right) => left.document.origin.localeCompare(right.document.origin));
        const origins = new Set();
        for (const entry of entries) {
            if (origins.has(entry.document.origin)) throw configError("Marketplace connection origins must be unique.", entry.bundleDirectory);
            origins.add(entry.document.origin);
        }
        return new MarketplaceConnectionPolicy(resolved, Object.freeze(entries));
    }

    list() {
        return Object.freeze(this.connections.map(publicConnection));
    }

    find(origin) {
        const entry = this.byOrigin.get(origin);
        if (!entry) return null;
        const index = this.connections.indexOf(entry);
        return Object.freeze({
            ...publicConnection(entry, index),
            credential: entry.credential,
            identities: entry.identities,
        });
    }
}
