import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { stageArtifactStream } from "../../artifacts/ArtifactVerification.js";
import { MARKETPLACE_LIMITS } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { ensureDirectory } from "../registry/RegistryFs.js";
import { MarketplaceFixedOriginFetcher } from "./MarketplaceFixedOriginFetcher.js";

export class MarketplaceArtifactDownloader {
    constructor({ artifactStore, credentialStore, fetchImpl = globalThis.fetch }) {
        this.artifactStore = artifactStore;
        this.credentialStore = credentialStore;
        this.fetchImpl = fetchImpl;
    }

    async obtain({ source, descriptor, workDirectory, signal = null }) {
        const cached = await this.artifactStore.get(descriptor);
        if (cached) return Object.freeze({ handle: cached, downloaded: false });
        await ensureDirectory(workDirectory);
        const destination = path.join(workDirectory, `${descriptor.sha256}.${randomUUID()}.part`);
        const fetcher = new MarketplaceFixedOriginFetcher({
            baseUrl: source.baseUrl,
            bearerToken: await this.credentialStore.readBearer(source.credentialRef),
            fetchImpl: this.fetchImpl,
            signal,
        });
        let staged = null;
        try {
            const stream = await fetcher.fetchBlob(descriptor.sha256);
            staged = await stageArtifactStream(stream, {
                destination,
                signal,
                expectedBytes: descriptor.sizeBytes,
                maxBytes: Math.min(descriptor.sizeBytes, MARKETPLACE_LIMITS.artifactBytes),
            });
            if (staged.sha256 !== descriptor.sha256) {
                await this.artifactStore.quarantine(staged.path, {
                    expectedSha256: descriptor.sha256,
                    actualSha256: staged.sha256,
                    sizeBytes: staged.sizeBytes,
                    reasonCode: "ARTIFACT_HASH_MISMATCH",
                });
                staged = null;
                throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Downloaded marketplace artifact digest does not match its verified descriptor.");
            }
            const handle = await this.artifactStore.publish(staged.path, descriptor);
            staged = null;
            return Object.freeze({ handle, downloaded: true });
        } catch (error) {
            if (signal?.aborted) throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace artifact download was cancelled.");
            if (error instanceof MarketplaceError) throw error;
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace artifact download failed.", { cause: error });
        } finally {
            if (staged?.path) await fs.rm(staged.path, { force: true }).catch(() => {});
            await fs.rm(destination, { force: true }).catch(() => {});
        }
    }
}

