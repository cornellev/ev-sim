import { promises as fs } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import process from "node:process";

import {
    MARKETPLACE_KINDS,
    MARKETPLACE_LIMITS,
    MARKETPLACE_TOKEN_SCOPES,
} from "./MarketplaceContract.js";
import {
    hashMarketplaceDocument,
    hashMarketplaceRelease,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "./MarketplaceContracts.js";
import {
    MARKETPLACE_ERROR_CODES,
    MarketplaceError,
    marketplaceError,
} from "./MarketplaceErrors.js";
import { DEFAULT_STAGING_GRACE_MS } from "./registry/RegistryLayout.js";
import { MarketplaceRegistryService } from "./registry/RegistryService.js";
import { MarketplaceRegistryStore } from "./registry/RegistryStore.js";
import { MarketplaceRegistryHttpServer } from "./registry/RegistryHttpServer.js";
import { RegistryAuthStore } from "./registry/RegistryAuthStore.js";
import {
    publisherKeyId,
    publisherPublicKey,
    signMarketplaceRelease,
} from "./PublisherSignatures.js";

export const REGISTRY_CLI_EXIT = Object.freeze({
    OK: 0,
    INTERNAL: 1,
    USAGE: 2,
    INVALID_INPUT: 3,
    CONFLICT: 4,
    RECOVERY_REQUIRED: 5,
    INTERRUPTED: 130,
});

const VALUE_OPTIONS = new Set([
    "root", "registry-id", "file", "content-kind", "media-type", "track", "kind", "grace-hours",
    "offline-root-key", "current-root-key", "new-root-key", "host", "port",
    "publisher-id", "item-id", "namespace", "scope", "subject", "token-id", "key-id", "private-key", "public-key",
    "output", "status", "release-version", "artifact-sha256", "reason", "tls-key", "tls-cert", "tls-ca",
]);
const FLAG_OPTIONS = new Set(["dry-run", "read-auth", "unsafe-development-lan", "mtls", "writable"]);

const LOCAL_ADMIN_ACTOR = Object.freeze({
    tokenId: "00000000-0000-4000-8000-000000000000",
    subject: "admin",
    publisherId: null,
    namespaces: Object.freeze([]),
    scopes: MARKETPLACE_TOKEN_SCOPES,
});

export function registryCliHelp() {
    return [
        "Equivalent entry points:",
        "  cev-sim-marketplace <command>",
        "  cev-mkt <command>",
        "  cev-sim mkt <command>",
        "",
        "Commands:",
        "  init --root DIR --offline-root-key FILE [--registry-id UUID]",
        "  validate item --file FILE",
        "  validate release --file FILE",
        "  validate artifact --content-kind KIND --file FILE",
        "  validate preview --media-type TYPE --file FILE",
        "  admit artifact --root DIR --content-kind KIND --file FILE",
        "  admit preview --root DIR --media-type TYPE --file FILE",
        "  admit item --root DIR --file FILE",
        "  admit release --root DIR --file DSSE_FILE [--track stable|beta]",
        "  publisher register --root DIR --file PUBLISHER_JSON",
        "  publisher add-key --root DIR --publisher-id ID --file KEY_JSON",
        "  publisher set-key-status --root DIR --publisher-id ID --key-id SHA256 --status retired|revoked",
        "  key generate --private-key FILE --public-key FILE",
        "  sign release --file RELEASE_JSON --private-key FILE --output DSSE_FILE",
        "  token create --root DIR --subject reader|publisher|admin --scope CSV [--publisher-id ID --namespace CSV]",
        "  token revoke --root DIR --token-id UUID",
        "  track set --root DIR --item-id ID --release-version VERSION --track stable|beta",
        "  yank --root DIR --item-id ID --release-version VERSION --artifact-sha256 SHA256 --reason TEXT",
        "  advisory admit --root DIR --file ADVISORY_JSON",
        "  list --root DIR --kind items|releases|blobs",
        "  verify --root DIR",
        "  gc --root DIR --dry-run [--grace-hours N]",
        "  tuf refresh --root DIR",
        "  tuf rotate-root --root DIR --current-root-key FILE --new-root-key FILE",
        "  serve --root DIR [--host HOST] [--port 8080] [--tls-key FILE --tls-cert FILE] [--tls-ca FILE --mtls] [--read-auth] [--writable] [--unsafe-development-lan]",
    ].join("\n");
}

function usage(message) {
    const error = new Error(message);
    error.code = "USAGE";
    return error;
}

function parseArguments(argv) {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
    const command = argv[0];
    const positional = [];
    const options = {};
    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) {
            positional.push(argument);
            continue;
        }
        const key = argument.slice(2);
        if (Object.hasOwn(options, key)) throw usage(`Option --${key} may be supplied only once.`);
        if (FLAG_OPTIONS.has(key)) {
            options[key] = true;
            continue;
        }
        if (!VALUE_OPTIONS.has(key)) throw usage(`Unknown option --${key}.`);
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw usage(`Option --${key} requires a value.`);
        options[key] = value;
        index += 1;
    }
    return { command, positional, options };
}

function exactOptions(options, required, optional = []) {
    const allowed = new Set([...required, ...optional]);
    const unknown = Object.keys(options).find((key) => !allowed.has(key));
    if (unknown) throw usage(`This command does not accept --${unknown}.`);
    const missing = required.find((key) => options[key] === undefined);
    if (missing) throw usage(`This command requires --${missing}.`);
}

async function readInputFile(filePath) {
    let stat;
    try {
        stat = await fs.lstat(filePath);
    } catch (error) {
        error.code = error.code ?? "INVALID_INPUT";
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        const error = new Error("Input must be a regular non-symlink file.");
        error.code = "INVALID_INPUT";
        throw error;
    }
    if (stat.size > MARKETPLACE_LIMITS.catalogBytes) {
        const error = new Error(`Input exceeds ${MARKETPLACE_LIMITS.catalogBytes} bytes.`);
        error.code = "INVALID_INPUT";
        throw error;
    }
    return fs.readFile(filePath);
}

function jsonLine(stream, value) {
    stream.write(`${JSON.stringify(value)}\n`);
}

function csv(value, option, { required = false } = {}) {
    if (value === undefined) {
        if (required) throw usage(`Option --${option} requires at least one comma-separated value.`);
        return [];
    }
    const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (values.length < 1 || new Set(values).size !== values.length) throw usage(`Option --${option} must contain unique comma-separated values.`);
    return values;
}

async function writeExclusive(filePath, bytes, { mode = 0o600 } = {}) {
    const handle = await fs.open(filePath, "wx", mode);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function errorExit(error, signal) {
    if (signal.aborted || error?.name === "AbortError" || error?.code === "ARTIFACT_CANCELLED") return REGISTRY_CLI_EXIT.INTERRUPTED;
    if (error?.code === "USAGE") return REGISTRY_CLI_EXIT.USAGE;
    if (error?.code === "CONFLICT") return REGISTRY_CLI_EXIT.CONFLICT;
    if (error?.code === "RECOVERY_REQUIRED") return REGISTRY_CLI_EXIT.RECOVERY_REQUIRED;
    if (error instanceof MarketplaceError || error?.code === "INVALID_INPUT"
        || error?.code === "ENOENT" || error?.code?.startsWith("ARTIFACT_")) return REGISTRY_CLI_EXIT.INVALID_INPUT;
    return REGISTRY_CLI_EXIT.INTERNAL;
}

function safeError(error, exitCode) {
    return {
        ok: false,
        error: {
            code: error?.code ?? (exitCode === REGISTRY_CLI_EXIT.INTERNAL ? "INTERNAL" : "INVALID_INPUT"),
            message: exitCode === REGISTRY_CLI_EXIT.INTERNAL ? "Marketplace registry command failed." : String(error?.message ?? "Marketplace registry command failed."),
            ...(typeof error?.path === "string" ? { path: error.path } : {}),
        },
    };
}

async function withStore(root, options, operation) {
    const store = await MarketplaceRegistryStore.open(root, options);
    try {
        return await operation(store, new MarketplaceRegistryService(store, options));
    } finally {
        await store.close();
    }
}

async function execute(parsed, signal, { stdout }) {
    const { command, positional, options } = parsed;
    if (command === "init") {
        if (positional.length !== 0) throw usage("init does not accept positional arguments.");
        exactOptions(options, ["root", "offline-root-key"], ["registry-id"]);
        const registry = await MarketplaceRegistryStore.initialize(options.root, {
            registryId: options["registry-id"] ?? null,
            offlineRootKeyPath: options["offline-root-key"],
        });
        await withStore(options.root, {}, async () => {});
        return { ok: true, command: "init", registry };
    }
    if (command === "validate") {
        if (positional.length !== 1) throw usage("validate requires exactly one kind: item, release, artifact, or preview.");
        const kind = positional[0];
        if (kind === "item" || kind === "release") {
            exactOptions(options, ["file"]);
            const document = parseMarketplaceDocument(await readInputFile(options.file));
            const expectedKind = kind === "item" ? MARKETPLACE_KINDS.item : MARKETPLACE_KINDS.release;
            if (document.kind !== expectedKind) {
                throw marketplaceError(
                    MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID,
                    `validate ${kind} requires a ${expectedKind} document.`,
                    { path: "$.kind" },
                );
            }
            return {
                ok: true,
                command: "validate",
                kind,
                sha256: kind === "release" ? hashMarketplaceRelease(document) : hashMarketplaceDocument(document),
                sizeBytes: marketplaceDocumentBytes(document).byteLength,
            };
        }
        const service = new MarketplaceRegistryService(null);
        if (kind === "artifact") {
            exactOptions(options, ["file", "content-kind"]);
            const result = await service.validateArtifact(options.file, { contentKind: options["content-kind"], signal });
            return { ok: true, command: "validate", kind, ...result };
        }
        if (kind === "preview") {
            exactOptions(options, ["file", "media-type"]);
            const result = await service.validatePreview(options.file, { mediaType: options["media-type"], signal });
            return { ok: true, command: "validate", kind, ...result };
        }
        throw usage(`Unknown validation kind ${JSON.stringify(kind)}.`);
    }
    if (command === "admit") {
        if (positional.length !== 1) throw usage("admit requires exactly one kind: item, release, artifact, or preview.");
        const kind = positional[0];
        if (kind === "artifact") {
            exactOptions(options, ["root", "file", "content-kind"]);
            return withStore(options.root, {}, async (_store, service) => ({
                ok: true,
                command: "admit",
                kind,
                ...await service.admitArtifact(options.file, { contentKind: options["content-kind"], signal }),
            }));
        }
        if (kind === "preview") {
            exactOptions(options, ["root", "file", "media-type"]);
            return withStore(options.root, {}, async (_store, service) => ({
                ok: true,
                command: "admit",
                kind,
                ...await service.admitPreview(options.file, { mediaType: options["media-type"], signal }),
            }));
        }
        if (kind === "item") {
            exactOptions(options, ["root", "file"]);
            const bytes = await readInputFile(options.file);
            return withStore(options.root, {}, async (_store, service) => ({ ok: true, command: "admit", kind, ...await service.admitItem(bytes) }));
        }
        if (kind === "release") {
            exactOptions(options, ["root", "file"], ["track"]);
            const bytes = await readInputFile(options.file);
            return withStore(options.root, {}, async (_store, service) => ({
                ok: true,
                command: "admit",
                kind,
                ...await (() => {
                    let value;
                    try { value = JSON.parse(bytes.toString("utf8")); } catch { value = null; }
                    return value?.payloadType
                        ? service.admitReleaseEnvelope(bytes, { actor: LOCAL_ADMIN_ACTOR, track: options.track ?? null })
                        : service.admitRelease(bytes, { track: options.track ?? null });
                })(),
            }));
        }
        throw usage(`Unknown admission kind ${JSON.stringify(kind)}.`);
    }
    if (command === "publisher") {
        if (positional.length !== 1) throw usage("publisher requires register, add-key, or set-key-status.");
        if (positional[0] === "register") {
            exactOptions(options, ["root", "file"]);
            const bytes = await readInputFile(options.file);
            return withStore(options.root, {}, async (_store, service) => ({
                ok: true, command, operation: "register", ...await service.registerPublisher(bytes, { actor: LOCAL_ADMIN_ACTOR }),
            }));
        }
        if (positional[0] === "add-key") {
            exactOptions(options, ["root", "publisher-id", "file"]);
            const key = JSON.parse((await readInputFile(options.file)).toString("utf8"));
            return withStore(options.root, {}, async (_store, service) => ({
                ok: true,
                command,
                operation: "add-key",
                ...await service.addPublisherKey(options["publisher-id"], key, { actor: LOCAL_ADMIN_ACTOR }),
            }));
        }
        if (positional[0] === "set-key-status") {
            exactOptions(options, ["root", "publisher-id", "key-id", "status"]);
            return withStore(options.root, {}, async (_store, service) => ({
                ok: true,
                command,
                operation: "set-key-status",
                ...await service.setPublisherKeyStatus(options["publisher-id"], options["key-id"], options.status, { actor: LOCAL_ADMIN_ACTOR }),
            }));
        }
        throw usage(`Unknown publisher operation ${JSON.stringify(positional[0])}.`);
    }
    if (command === "key") {
        if (positional.length !== 1 || positional[0] !== "generate") throw usage("key requires generate.");
        exactOptions(options, ["private-key", "public-key"]);
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const keyId = publisherKeyId(publicKey);
        const publicRecord = {
            keyId,
            algorithm: "ed25519",
            publicKey: publisherPublicKey(publicKey),
            status: "active",
            createdAt: new Date().toISOString(),
            statusChangedAt: new Date().toISOString(),
        };
        await writeExclusive(options["private-key"], privateKey.export({ format: "pem", type: "pkcs8" }));
        try {
            await writeExclusive(options["public-key"], Buffer.from(`${JSON.stringify(publicRecord)}\n`), { mode: 0o644 });
        } catch (error) {
            await fs.rm(options["private-key"], { force: true });
            throw error;
        }
        return { ok: true, command, operation: "generate", keyId };
    }
    if (command === "sign") {
        if (positional.length !== 1 || positional[0] !== "release") throw usage("sign requires release.");
        exactOptions(options, ["file", "private-key", "output"]);
        const release = parseMarketplaceDocument(await readInputFile(options.file));
        const privateKey = await readInputFile(options["private-key"]);
        const signed = signMarketplaceRelease(release, privateKey);
        await writeExclusive(options.output, signed.bytes, { mode: 0o644 });
        return { ok: true, command, operation: "release", keyId: signed.keyId, releaseHash: hashMarketplaceRelease(signed.release) };
    }
    if (command === "token") {
        if (positional.length !== 1) throw usage("token requires create or revoke.");
        if (positional[0] === "create") {
            exactOptions(options, ["root", "subject", "scope"], ["publisher-id", "namespace"]);
            return withStore(options.root, {}, async (store) => {
                const auth = await RegistryAuthStore.open(store.paths);
                return {
                    ok: true,
                    command,
                    operation: "create",
                    ...await auth.createToken({
                        subject: options.subject,
                        publisherId: options["publisher-id"] ?? null,
                        namespaces: csv(options.namespace, "namespace"),
                        scopes: csv(options.scope, "scope", { required: true }),
                    }),
                };
            });
        }
        if (positional[0] === "revoke") {
            exactOptions(options, ["root", "token-id"]);
            return withStore(options.root, {}, async (store) => {
                const auth = await RegistryAuthStore.open(store.paths);
                return { ok: true, command, operation: "revoke", revoked: await auth.revokeToken(options["token-id"]) };
            });
        }
        throw usage(`Unknown token operation ${JSON.stringify(positional[0])}.`);
    }
    if (command === "track") {
        if (positional.length !== 1 || positional[0] !== "set") throw usage("track requires set.");
        exactOptions(options, ["root", "item-id", "release-version", "track"]);
        return withStore(options.root, {}, async (_store, service) => ({
            ok: true,
            command,
            operation: "set",
            ...await service.setTrack(options["item-id"], options.track, options["release-version"], { actor: LOCAL_ADMIN_ACTOR }),
        }));
    }
    if (command === "yank") {
        if (positional.length !== 0) throw usage("yank does not accept positional arguments.");
        exactOptions(options, ["root", "item-id", "release-version", "artifact-sha256", "reason"]);
        return withStore(options.root, {}, async (_store, service) => ({
            ok: true,
            command,
            ...await service.yankRelease({
                itemId: options["item-id"],
                releaseVersion: options["release-version"],
                artifactSha256: options["artifact-sha256"],
                reason: options.reason,
            }, { actor: LOCAL_ADMIN_ACTOR }),
        }));
    }
    if (command === "advisory") {
        if (positional.length !== 1 || positional[0] !== "admit") throw usage("advisory requires admit.");
        exactOptions(options, ["root", "file"]);
        const bytes = await readInputFile(options.file);
        return withStore(options.root, {}, async (_store, service) => ({
            ok: true, command, operation: "admit", ...await service.admitAdvisory(bytes, { actor: LOCAL_ADMIN_ACTOR }),
        }));
    }
    if (command === "list") {
        if (positional.length !== 0) throw usage("list does not accept positional arguments.");
        exactOptions(options, ["root", "kind"]);
        if (!["items", "releases", "blobs"].includes(options.kind)) throw usage("--kind must be items, releases, or blobs.");
        return withStore(options.root, {}, async (_store, service) => {
            const entries = options.kind === "items"
                ? await service.listItems()
                : options.kind === "releases" ? await service.listReleases() : await service.listBlobs();
            return { ok: true, command: "list", kind: options.kind, entries };
        });
    }
    if (command === "verify") {
        if (positional.length !== 0) throw usage("verify does not accept positional arguments.");
        exactOptions(options, ["root"]);
        return withStore(options.root, {}, async (_store, service) => ({ command: "verify", ...await service.verifyRegistry() }));
    }
    if (command === "gc") {
        if (positional.length !== 0) throw usage("gc does not accept positional arguments.");
        exactOptions(options, ["root", "dry-run"], ["grace-hours"]);
        if (options["dry-run"] !== true) throw usage("gc requires literal --dry-run.");
        const hours = options["grace-hours"] === undefined ? DEFAULT_STAGING_GRACE_MS / 3_600_000 : Number(options["grace-hours"]);
        if (!Number.isFinite(hours) || hours < 0) throw usage("--grace-hours must be a non-negative number.");
        return withStore(options.root, {}, async (_store, service) => ({
            ok: true,
            command: "gc",
            ...await service.planGarbageCollection({ graceMs: hours * 3_600_000 }),
        }));
    }
    if (command === "tuf") {
        if (positional.length !== 1) throw usage("tuf requires exactly one operation: refresh or rotate-root.");
        if (positional[0] === "refresh") {
            exactOptions(options, ["root"]);
            return withStore(options.root, {}, async (store) => {
                if (!store.tufRepository) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "Registry has no TUF repository.");
                const result = await store.mutate(async () => store.tufRepository.refresh(await store.readCatalog()));
                return { ok: true, command: "tuf", operation: "refresh", ...result };
            });
        }
        if (positional[0] === "rotate-root") {
            exactOptions(options, ["root", "current-root-key", "new-root-key"]);
            return withStore(options.root, {}, async (store) => {
                if (!store.tufRepository) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "Registry has no TUF repository.");
                const result = await store.mutate(() => store.tufRepository.rotateRoot({
                    currentRootKeyPath: options["current-root-key"],
                    newRootKeyPath: options["new-root-key"],
                }));
                return { ok: true, command: "tuf", operation: "rotate-root", ...result };
            });
        }
        throw usage(`Unknown tuf operation ${JSON.stringify(positional[0])}.`);
    }
    if (command === "serve") {
        if (positional.length !== 0) throw usage("serve does not accept positional arguments.");
        exactOptions(options, ["root"], [
            "host", "port", "tls-key", "tls-cert", "tls-ca", "mtls", "read-auth", "writable", "unsafe-development-lan",
        ]);
        const port = options.port === undefined ? 8080 : Number(options.port);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw usage("--port must be an integer from 0 through 65535.");
        const hasTls = options["tls-key"] !== undefined || options["tls-cert"] !== undefined || options["tls-ca"] !== undefined || options.mtls === true;
        if (hasTls && (!options["tls-key"] || !options["tls-cert"])) throw usage("TLS requires both --tls-key and --tls-cert.");
        if (options.mtls === true && !options["tls-ca"]) throw usage("--mtls requires --tls-ca.");
        const tls = hasTls ? {
            key: await readInputFile(options["tls-key"]),
            cert: await readInputFile(options["tls-cert"]),
            ...(options["tls-ca"] ? { ca: await readInputFile(options["tls-ca"]) } : {}),
            requestCert: options.mtls === true,
            rejectUnauthorized: options.mtls === true,
            minVersion: "TLSv1.2",
        } : null;
        const server = await MarketplaceRegistryHttpServer.open(options.root, {
            tls,
            readAuthentication: options["read-auth"] === true,
            writable: options.writable === true,
            unsafeDevelopmentLan: options["unsafe-development-lan"] === true,
        });
        try {
            const address = await server.listen({ host: options.host ?? "127.0.0.1", port });
            jsonLine(stdout, {
                ok: true,
                command: "serve",
                registryId: server.reader.registry.registryId,
                address: { host: address.address, port: address.port },
            });
            await new Promise((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener("abort", resolve, { once: true });
            });
            return null;
        } finally {
            await server.close();
        }
    }
    throw usage(`Unknown marketplace command ${JSON.stringify(command)}.`);
}

export async function main(argv = process.argv.slice(2), io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    const abortController = new AbortController();
    const onSignal = () => abortController.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
        const parsed = parseArguments(argv);
        if (parsed.help) {
            jsonLine(stdout, { ok: true, command: "help", help: registryCliHelp() });
            return REGISTRY_CLI_EXIT.OK;
        }
        const result = await execute(parsed, abortController.signal, { stdout });
        if (result !== null) {
            abortController.signal.throwIfAborted();
            jsonLine(stdout, result);
        }
        return REGISTRY_CLI_EXIT.OK;
    } catch (error) {
        const exitCode = errorExit(error, abortController.signal);
        jsonLine(stderr, safeError(error, exitCode));
        return exitCode;
    } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
    }
}
