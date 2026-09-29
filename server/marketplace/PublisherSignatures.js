import {
    createHash,
    createPrivateKey,
    createPublicKey,
    sign,
    verify,
} from "node:crypto";

import {
    MARKETPLACE_LIMITS,
    MARKETPLACE_RELEASE_PAYLOAD_TYPE,
} from "./MarketplaceContract.js";
import {
    assertMarketplacePublisher,
    assertMarketplaceRelease,
    marketplaceDocumentBytes,
} from "./MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import {
    canonicalMarketplaceBytes,
    parseMarketplaceJsonBytes,
} from "./MarketplaceJson.js";

function invalid(message, path = null, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, message, { path, cause });
}

function exactKeys(value, keys, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${path} must be an object.`, path);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.join("\u0000") !== expected.join("\u0000")) throw invalid(`${path} has unsupported fields.`, path);
}

function decodeCanonicalBase64(value, path, expectedLength = null) {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        throw invalid(`${path} is not canonical base64.`, path);
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || (expectedLength !== null && bytes.byteLength !== expectedLength)) {
        throw invalid(`${path} is not canonical base64.`, path);
    }
    return bytes;
}

export function dssePreAuthenticationEncoding(payloadType, payloadBytes) {
    const type = Buffer.from(String(payloadType), "utf8");
    const payload = Buffer.from(payloadBytes);
    return Buffer.concat([
        Buffer.from(`DSSEv1 ${type.byteLength} `, "ascii"),
        type,
        Buffer.from(` ${payload.byteLength} `, "ascii"),
        payload,
    ]);
}

function publicJwk(key) {
    const publicKey = key?.type === "public" ? key : createPublicKey(key);
    const jwk = publicKey.export({ format: "jwk" });
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
        throw invalid("Publisher key must be Ed25519.");
    }
    return Object.freeze({ crv: "Ed25519", kty: "OKP", x: jwk.x });
}

export function publisherKeyId(key) {
    return createHash("sha256").update(canonicalMarketplaceBytes(publicJwk(key))).digest("hex");
}

export function publisherPublicKey(key) {
    return publicJwk(key).x;
}

export function publisherKeyObject(publicKey) {
    if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(publicKey)) {
        throw invalid("Publisher public key is not canonical Ed25519 base64url.");
    }
    try {
        return createPublicKey({ key: { crv: "Ed25519", kty: "OKP", x: publicKey }, format: "jwk" });
    } catch (error) {
        throw invalid("Publisher public key is invalid.", null, error);
    }
}

export function releaseEnvelopeBytes(envelope) {
    return canonicalMarketplaceBytes(envelope);
}

export function signMarketplaceRelease(releaseInput, privateKeyInput, { keyId = null } = {}) {
    const release = assertMarketplaceRelease(releaseInput);
    const payloadBytes = marketplaceDocumentBytes(release);
    let privateKey;
    try {
        privateKey = privateKeyInput?.type === "private" ? privateKeyInput : createPrivateKey(privateKeyInput);
    } catch (error) {
        throw invalid("Publisher private key is invalid.", null, error);
    }
    if (privateKey.asymmetricKeyType !== "ed25519") throw invalid("Publisher private key must be Ed25519.");
    const resolvedKeyId = publisherKeyId(privateKey);
    if (keyId !== null && keyId !== resolvedKeyId) throw invalid("Publisher key ID does not match the private key.");
    const signature = sign(null, dssePreAuthenticationEncoding(MARKETPLACE_RELEASE_PAYLOAD_TYPE, payloadBytes), privateKey);
    const envelope = Object.freeze({
        payloadType: MARKETPLACE_RELEASE_PAYLOAD_TYPE,
        payload: Buffer.from(payloadBytes).toString("base64"),
        signatures: Object.freeze([{ keyid: resolvedKeyId, sig: signature.toString("base64") }]),
    });
    return Object.freeze({ envelope, bytes: releaseEnvelopeBytes(envelope), release, payloadBytes, keyId: resolvedKeyId });
}

export function parseReleaseEnvelope(input) {
    const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array ? Buffer.from(input) : canonicalMarketplaceBytes(input);
    if (bytes.byteLength > MARKETPLACE_LIMITS.jsonBytes) throw invalid("Publisher release envelope exceeds the JSON byte limit.");
    let envelope;
    try {
        ({ document: envelope } = parseMarketplaceJsonBytes(bytes));
    } catch (error) {
        throw invalid("Publisher release envelope is invalid JSON.", null, error);
    }
    exactKeys(envelope, ["payloadType", "payload", "signatures"], "$envelope");
    if (envelope.payloadType !== MARKETPLACE_RELEASE_PAYLOAD_TYPE) throw invalid("Publisher release payload type is invalid.", "$envelope.payloadType");
    if (!Buffer.from(canonicalMarketplaceBytes(envelope)).equals(bytes)) throw invalid("Publisher release envelope is not canonical.");
    if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) throw invalid("Publisher release envelope must contain exactly one signature.", "$envelope.signatures");
    exactKeys(envelope.signatures[0], ["keyid", "sig"], "$envelope.signatures.0");
    const keyId = envelope.signatures[0].keyid;
    if (typeof keyId !== "string" || !/^[a-f0-9]{64}$/u.test(keyId)) throw invalid("Publisher signature key ID is invalid.");
    const signature = decodeCanonicalBase64(envelope.signatures[0].sig, "$envelope.signatures.0.sig", 64);
    const payloadBytes = decodeCanonicalBase64(envelope.payload, "$envelope.payload");
    let release;
    try {
        const { document } = parseMarketplaceJsonBytes(payloadBytes);
        release = assertMarketplaceRelease(document);
    } catch (error) {
        throw invalid("Publisher release payload is invalid.", null, error);
    }
    if (!Buffer.from(marketplaceDocumentBytes(release)).equals(payloadBytes)) throw invalid("Publisher release payload is not canonical.");
    return Object.freeze({ envelope: Object.freeze(envelope), bytes, release, payloadBytes, keyId, signature });
}

export function verifyMarketplaceReleaseEnvelope(input, publisherInput, { requireActive = false } = {}) {
    const parsed = parseReleaseEnvelope(input);
    const publisher = assertMarketplacePublisher(publisherInput);
    if (parsed.release.publisherId !== publisher.publisherId) throw invalid("Release publisher does not match the signing publisher.");
    const key = publisher.keys.find((entry) => entry.keyId === parsed.keyId);
    if (!key) throw invalid("Publisher signing key is not registered.");
    if (publisherKeyId(publisherKeyObject(key.publicKey)) !== key.keyId) throw invalid("Publisher key ID does not match its public key.");
    if (requireActive && key.status !== "active") throw invalid("Publisher signing key is not active.");
    const valid = verify(
        null,
        dssePreAuthenticationEncoding(MARKETPLACE_RELEASE_PAYLOAD_TYPE, parsed.payloadBytes),
        publisherKeyObject(key.publicKey),
        parsed.signature,
    );
    if (!valid) throw invalid("Publisher release signature is invalid.");
    return Object.freeze({ ...parsed, publisher, publisherKey: key });
}
