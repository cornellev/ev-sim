import { createPrivateKey, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertMarketplaceId, assertSha256 } from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes } from "../MarketplaceJson.js";
import { publisherKeyId } from "../PublisherSignatures.js";
import { lstatOrNull, writeExclusiveDurable } from "../registry/RegistryFs.js";
import {
    assertCredentialDocument,
    MARKETPLACE_CLIENT_DOCUMENT_VERSION,
    MARKETPLACE_CREDENTIAL_KIND,
} from "./MarketplaceClientLayout.js";
import { assertMarketplaceConnectionDocument } from "./MarketplaceConnectionDocuments.js";

const ENROLLMENT_RESPONSE_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const RESPONSE_KEYS = Object.freeze([
    "publisherId", "displayName", "keyId", "privateKeyPem", "readToken", "writeToken", "bootstrapRootSha256",
]);

function unavailable(message, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, message, { cause });
}

function invalid(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message);
}

export function enrollmentRootMatches(fetched, returned) {
    if (!/^[a-f0-9]{64}$/u.test(fetched) || !/^[a-f0-9]{64}$/u.test(returned)) return false;
    return timingSafeEqual(Buffer.from(fetched, "hex"), Buffer.from(returned, "hex"));
}

async function readLimitedBody(response) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > ENROLLMENT_RESPONSE_BYTES) throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, "Marketplace enrollment response is too large.");
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}

function assertEnrollmentResponse(document) {
    if (!document || typeof document !== "object" || Array.isArray(document)) throw invalid("Marketplace enrollment response is invalid.");
    const keys = Object.keys(document);
    if (keys.length !== RESPONSE_KEYS.length || RESPONSE_KEYS.some((key) => !Object.hasOwn(document, key))) {
        throw invalid("Marketplace enrollment response is invalid.");
    }
    assertMarketplaceId(document.publisherId, "publisherId");
    if (typeof document.displayName !== "string" || !document.displayName.trim() || document.displayName !== document.displayName.trim()
        || document.displayName.length > 256 || document.displayName.includes("\u0000")) {
        throw invalid("Marketplace enrollment response is invalid.");
    }
    assertSha256(document.keyId, "keyId");
    assertSha256(document.bootstrapRootSha256, "bootstrapRootSha256");
    if (typeof document.privateKeyPem !== "string" || typeof document.readToken !== "string" || typeof document.writeToken !== "string"
        || !TOKEN_PATTERN.test(document.readToken) || !TOKEN_PATTERN.test(document.writeToken)) {
        throw invalid("Marketplace enrollment response is invalid.");
    }
    let privateKey;
    try { privateKey = createPrivateKey(document.privateKeyPem); }
    catch { throw invalid("Marketplace enrollment response is invalid."); }
    if (privateKey.asymmetricKeyType !== "ed25519" || publisherKeyId(privateKey) !== document.keyId) {
        throw invalid("Marketplace enrollment response is invalid.");
    }
    return document;
}

export async function requestRegistryEnrollment({ baseUrl, fetchImpl, signal = null }) {
    let response;
    try {
        response = await fetchImpl(new URL("v1/enroll", baseUrl).href, {
            method: "POST",
            redirect: "manual",
            signal,
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw unavailable("Marketplace enrollment request failed.", error);
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await readLimitedBody(response).catch(() => {});
        throw unavailable("Marketplace enrollment refused a redirect.");
    }
    if (response.status === 404) {
        await readLimitedBody(response);
        return null;
    }
    const body = await readLimitedBody(response);
    if (!response.ok) throw unavailable("Marketplace enrollment request failed.");
    let document;
    try { document = JSON.parse(body.toString("utf8")); }
    catch { throw invalid("Marketplace enrollment response is invalid."); }
    return Object.freeze(assertEnrollmentResponse(document));
}

export async function writeEnrollmentBundle({
    connectionsDirectory,
    origin,
    displayName,
    trustedRootSha256,
    publisherId,
    readToken,
    writeToken,
    privateKeyPem,
    keyId,
}) {
    const connection = assertMarketplaceConnectionDocument({
        kind: "cev-sim.marketplace-connection",
        version: 1,
        origin,
        displayName,
        trustedRootSha256,
        readCredentialFile: "read-credential.json",
        autoApprovePublisherIds: [publisherId],
        publishingIdentities: [{
            name: displayName,
            publisherId,
            writeTokenFile: "publisher.token",
            privateKeyFile: "publisher.pk8.pem",
            default: true,
            defaults: { track: "stable", license: "Apache-2.0" },
        }],
    });
    const credential = assertCredentialDocument({
        kind: MARKETPLACE_CREDENTIAL_KIND,
        version: MARKETPLACE_CLIENT_DOCUMENT_VERSION,
        type: "bearer",
        token: readToken,
    });
    const prefix = `e-${keyId.slice(0, 12)}`;
    const directoryName = await lstatOrNull(path.join(connectionsDirectory, prefix)) ? `e-${keyId}` : prefix;
    const output = path.join(connectionsDirectory, directoryName);
    const temporary = path.join(connectionsDirectory, `.${directoryName}.${randomUUID()}.tmp`);
    await fs.mkdir(temporary, { mode: 0o700 });
    try {
        await writeExclusiveDurable(path.join(temporary, "connection.json"), canonicalMarketplaceBytes(connection));
        await writeExclusiveDurable(path.join(temporary, "read-credential.json"), canonicalMarketplaceBytes(credential));
        await writeExclusiveDurable(path.join(temporary, "publisher.token"), Buffer.from(writeToken));
        await writeExclusiveDurable(path.join(temporary, "publisher.pk8.pem"), Buffer.from(privateKeyPem));
        await fs.rename(temporary, output);
        return output;
    } catch (error) {
        await fs.rm(temporary, { recursive: true, force: true });
        throw error;
    }
}
