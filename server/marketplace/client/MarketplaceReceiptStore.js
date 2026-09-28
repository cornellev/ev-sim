import { promises as fs } from "node:fs";
import path from "node:path";

import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import {
    assertMarketplaceInstallReceipt,
    hashMarketplaceDocument,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertSha256 } from "../MarketplaceFormats.js";
import {
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";

function receiptPath(paths, receiptHash) {
    assertSha256(receiptHash, "receiptHash");
    return path.join(paths.receipts, `${receiptHash}.json`);
}

function exactReleaseKey(receipt) {
    return `${receipt.sourceId}\u0000${receipt.release.itemId}\u0000${receipt.release.releaseVersion}\u0000${receipt.release.artifactSha256}`;
}

export class MarketplaceReceiptStore {
    constructor(paths) {
        this.paths = paths;
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.receipts);
        const store = new MarketplaceReceiptStore(paths);
        await store.recover();
        return store;
    }

    async publish(receipt) {
        const document = assertMarketplaceInstallReceipt(receipt);
        const hash = hashMarketplaceDocument(document);
        const destination = receiptPath(this.paths, hash);
        const bytes = marketplaceDocumentBytes(document);
        if (await lstatOrNull(destination)) {
            const existing = await readRegularBytes(destination, { maxBytes: 16 * 1024 * 1024 });
            if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Immutable marketplace receipt does not match its content hash.");
            }
            return Object.freeze({ hash, created: false, document });
        }
        try {
            await writeExclusiveDurable(destination, bytes);
            return Object.freeze({ hash, created: true, document });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = await readRegularBytes(destination, { maxBytes: 16 * 1024 * 1024 });
            if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Concurrent marketplace receipt publication disagreed.");
            }
            return Object.freeze({ hash, created: false, document });
        }
    }

    async read(receiptHash) {
        const filePath = receiptPath(this.paths, receiptHash);
        if (!await lstatOrNull(filePath)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace receipt was not found.");
        }
        const bytes = await readRegularBytes(filePath, { maxBytes: 16 * 1024 * 1024 });
        const receipt = assertMarketplaceInstallReceipt(parseMarketplaceDocument(bytes));
        if (hashMarketplaceDocument(receipt) !== receiptHash
            || !Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(receipt)))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace receipt is not canonical or has the wrong hash.");
        }
        return receipt;
    }

    async listForRelease(release) {
        const key = `${release.sourceId}\u0000${release.itemId}\u0000${release.releaseVersion}\u0000${release.artifactSha256}`;
        const matches = [];
        for (const entry of await fs.readdir(this.paths.receipts, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace receipt store contains an unexpected node.");
            }
            const hash = entry.name.slice(0, -5);
            const receipt = await this.read(hash);
            if (exactReleaseKey(receipt) === key) matches.push({ hash, installedAt: receipt.installedAt });
        }
        matches.sort((left, right) => compareUtf8(left.installedAt, right.installedAt) || compareUtf8(left.hash, right.hash));
        return Object.freeze(matches.map((entry) => entry.hash));
    }

    async recover() {
        for (const entry of await fs.readdir(this.paths.receipts, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace receipt store contains an unexpected node.");
            }
            await this.read(entry.name.slice(0, -5));
        }
    }
}
