import { Key, Signature } from "@tufjs/models";
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { lstatOrNull, readRegularBytes, writeExclusiveDurable } from "./RegistryFs.js";

export const TUF_KEY_TYPE = "ed25519";
export const TUF_KEY_SCHEME = "ed25519";
const { canonicalize } = createRequire(import.meta.url)("@tufjs/canonical-json");

function invalid(message, filePath = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, message, { path: filePath });
}

async function assertOutsideRegistry(filePath, registryRoot) {
    if (!registryRoot) return;
    const resolved = path.resolve(filePath);
    const root = await fs.realpath(registryRoot).catch(() => path.resolve(registryRoot));
    const parent = await fs.realpath(path.dirname(resolved)).catch(() => path.resolve(path.dirname(resolved)));
    const actual = path.join(parent, path.basename(resolved));
    if (actual === root || actual.startsWith(`${root}${path.sep}`)) {
        throw invalid("The offline root private key must be outside the registry root.", resolved);
    }
}

function rawPublicHex(privateKey) {
    const jwk = createPublicKey(privateKey).export({ format: "jwk" });
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
        throw invalid("TUF private key is not Ed25519.");
    }
    return Buffer.from(jwk.x, "base64url").toString("hex");
}

export function tufPublicKey(privateKey) {
    const keyData = {
        keytype: TUF_KEY_TYPE,
        scheme: TUF_KEY_SCHEME,
        keyval: { public: rawPublicHex(privateKey) },
    };
    const keyID = createHash("sha256").update(Buffer.from(canonicalize(keyData))).digest("hex");
    return new Key({
        keyID,
        keyType: TUF_KEY_TYPE,
        scheme: TUF_KEY_SCHEME,
        keyVal: { public: keyData.keyval.public },
    });
}

export function tufKeyId(privateKey) {
    return tufPublicKey(privateKey).keyID;
}

export function generatePrivateKey() {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ format: "pem", type: "pkcs8" });
}

export async function loadPrivateKey(filePath, { requirePrivateMode = true, registryRoot = null } = {}) {
    await assertOutsideRegistry(filePath, registryRoot);
    const stat = await fs.lstat(filePath).catch((error) => {
        if (error.code === "ENOENT") throw invalid("TUF private key file does not exist.", filePath);
        throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("TUF private key must be a regular non-symlink file.", filePath);
    if (requirePrivateMode && (stat.mode & 0o077) !== 0) throw invalid("TUF private key permissions must not grant group or other access.", filePath);
    try {
        const key = createPrivateKey(await readRegularBytes(filePath, { maxBytes: 64 * 1024 }));
        if (key.asymmetricKeyType !== "ed25519") throw invalid("TUF private key is not Ed25519.", filePath);
        return key;
    } catch (error) {
        if (error?.code === MARKETPLACE_ERROR_CODES.CONFIG_INVALID) throw error;
        throw invalid(`Unable to read TUF private key: ${error.message}`, filePath);
    }
}

export async function ensurePrivateKey(filePath, { registryRoot = null } = {}) {
    const resolved = path.resolve(filePath);
    await assertOutsideRegistry(resolved, registryRoot);
    const existing = await lstatOrNull(resolved);
    if (!existing) {
        await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
        await assertOutsideRegistry(resolved, registryRoot);
        await writeExclusiveDurable(resolved, generatePrivateKey());
    }
    return Object.freeze({ path: resolved, privateKey: await loadPrivateKey(resolved, { registryRoot }) });
}

export function tufSigner(privateKey) {
    const keyID = tufKeyId(privateKey);
    return (bytes) => new Signature({
        keyID,
        sig: sign(null, bytes, privateKey).toString("hex"),
    });
}

export function signTufMetadata(metadata, privateKey, { append = true } = {}) {
    metadata.sign(tufSigner(privateKey), append);
    return metadata;
}
