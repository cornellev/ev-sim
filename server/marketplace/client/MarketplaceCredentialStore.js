import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import {
    MARKETPLACE_CLIENT_DOCUMENT_VERSION,
    MARKETPLACE_CREDENTIAL_KIND,
    assertCredentialDocument,
    credentialPath,
    localDocumentBytes,
    marketplaceClientPaths,
    parseLocalDocument,
} from "./MarketplaceClientLayout.js";

function recovery(message, pathName = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName });
}

export class MarketplaceCredentialStore {
    constructor(paths) {
        this.paths = paths;
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.root);
        await ensureDirectory(paths.credentials);
        return new MarketplaceCredentialStore(paths);
    }

    async stageCredential(credential) {
        const document = assertCredentialDocument({
            kind: MARKETPLACE_CREDENTIAL_KIND,
            version: MARKETPLACE_CLIENT_DOCUMENT_VERSION,
            ...credential,
        });
        const credentialRef = randomUUID();
        await writeExclusiveDurable(
            credentialPath(this.paths, credentialRef),
            localDocumentBytes(document, assertCredentialDocument),
        );
        return credentialRef;
    }

    stageBearer(token) {
        return this.stageCredential({ type: "bearer", token });
    }

    async readCredential(credentialRef) {
        if (credentialRef === null || credentialRef === undefined) return null;
        const filePath = credentialPath(this.paths, credentialRef);
        const stat = await lstatOrNull(filePath);
        if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
            throw recovery("Marketplace credential must be an owner-only regular file.", filePath);
        }
        const bytes = await readRegularBytes(filePath, { maxBytes: 16 * 1024 });
        const document = parseLocalDocument(bytes, assertCredentialDocument);
        const canonical = localDocumentBytes(document, assertCredentialDocument);
        if (!Buffer.from(bytes).equals(Buffer.from(canonical))) {
            throw recovery("Marketplace credential document is not canonical.", filePath);
        }
        const { kind: _kind, version: _version, ...credential } = document;
        return credential;
    }

    async readBearer(credentialRef) {
        return (await this.readCredential(credentialRef))?.token ?? null;
    }

    async remove(credentialRef) {
        if (!credentialRef) return false;
        const filePath = credentialPath(this.paths, credentialRef);
        const existing = await lstatOrNull(filePath);
        if (!existing) return false;
        if (!existing.isFile() || existing.isSymbolicLink()) throw recovery("Marketplace credential path is not a regular file.", filePath);
        await fs.rm(filePath);
        return true;
    }

    async recover(referencedRefs) {
        const referenced = new Set(referencedRefs);
        for (const credentialRef of referenced) await this.readBearer(credentialRef);
        for (const entry of await fs.readdir(this.paths.credentials, { withFileTypes: true })) {
            const filePath = path.join(this.paths.credentials, entry.name);
            if (entry.isSymbolicLink() || !entry.isFile()) throw recovery("Marketplace credential directory contains a hostile node.", filePath);
            const match = /^([a-f0-9-]{36})\.json$/u.exec(entry.name);
            if (!match) throw recovery("Marketplace credential directory contains an unexpected filename.", filePath);
            if (!referenced.has(match[1])) await fs.rm(filePath);
        }
    }
}
