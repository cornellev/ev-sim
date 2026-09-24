import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { resolveSensorTransportHostConfig } from "../sensor-transports/SensorTransportConfig.js";
import { resolveRunPackageLimits } from "./VisualAssetPack.js";

export const SUPERVISOR_CONFIG_KIND = "cev-sim.headless-supervisor-config";
export const SUPERVISOR_CONFIG_VERSION = 1;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const PBR_TARGETS = new Set(["local-development", "jetson-agx-orin", "jetson-agx-thor"]);

export const RESOURCE_FIELD_NAMES = Object.freeze([
    "maxRssBytesPerEnvironment",
    "maxHeapBytesPerEnvironment",
    "maxActorsPerEnvironment",
    "maxSensorsPerEnvironment",
    "maxObservationBytes",
    "maxQueueBytes",
    "maxArtifactBytes",
    "stepWallTimeoutMs",
    "episodeWallTimeoutMs",
    "restartBudget",
    "maxSharedMemoryBytesPerEnvironment",
    "maxGpuBytesPerEnvironment",
]);

const SAFETY_LIMITS = Object.freeze({
    maxRssBytesPerEnvironment: 1 * GiB,
    maxHeapBytesPerEnvironment: 512 * MiB,
    maxActorsPerEnvironment: 256,
    maxSensorsPerEnvironment: 64,
    maxObservationBytes: 16 * MiB,
    maxQueueBytes: 16 * MiB,
    maxArtifactBytes: 2 * GiB,
    stepWallTimeoutMs: 30_000,
    episodeWallTimeoutMs: 6 * 60 * 60 * 1000,
    restartBudget: 1,
    maxSharedMemoryBytesPerEnvironment: 128 * MiB,
    maxGpuBytesPerEnvironment: 256 * MiB,
});

const PERMISSIVE_LIMITS = Object.freeze({
    maxRssBytesPerEnvironment: 2 * GiB,
    maxHeapBytesPerEnvironment: 1 * GiB,
    maxActorsPerEnvironment: 1024,
    maxSensorsPerEnvironment: 256,
    maxObservationBytes: 64 * MiB,
    maxQueueBytes: 64 * MiB,
    maxArtifactBytes: 10 * GiB,
    stepWallTimeoutMs: 120_000,
    episodeWallTimeoutMs: 24 * 60 * 60 * 1000,
    restartBudget: 3,
    maxSharedMemoryBytesPerEnvironment: 512 * MiB,
    maxGpuBytesPerEnvironment: 1 * GiB,
});

export const SUPERVISOR_PRESETS = Object.freeze({
    safety: Object.freeze({ maxWorkers: 32, maxRpcMessageBytes: 64 * MiB, limits: SAFETY_LIMITS }),
    permissive: Object.freeze({ maxWorkers: 32, maxRpcMessageBytes: 256 * MiB, limits: PERMISSIVE_LIMITS }),
});

function invalid(message, details = null) {
    return new HeadlessRunnerError("INVALID_REQUEST", message, details);
}

function finiteInteger(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw invalid(`${name} must be an integer in [${minimum}, ${maximum}].`);
    }
    return number;
}

function normalizeLimits(value, fallback, label) {
    const source = value ?? {};
    if (!source || typeof source !== "object" || Array.isArray(source)) throw invalid(`${label} must be an object.`);
    const result = {};
    for (const field of RESOURCE_FIELD_NAMES) {
        result[field] = source[field] === undefined
            ? fallback[field]
            : finiteInteger(source[field], `${label}.${field}`, { minimum: field === "restartBudget" ? 0 : 1 });
    }
    return Object.freeze(result);
}

function normalizeRenderer(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("renderer must be an object.");
    const launchArgs = value.launchArgs ?? [];
    if (!Array.isArray(launchArgs) || launchArgs.some((entry) => typeof entry !== "string" || !entry)) {
        throw invalid("renderer.launchArgs must contain non-empty strings.");
    }
    const pbrTarget = value.pbrTarget ? String(value.pbrTarget) : "local-development";
    if (!PBR_TARGETS.has(pbrTarget)) {
        throw invalid(`renderer.pbrTarget must be one of ${[...PBR_TARGETS].join(", ")}.`);
    }
    return Object.freeze({
        chromiumExecutable: value.chromiumExecutable ? String(value.chromiumExecutable) : "",
        contextPoolSize: finiteInteger(value.contextPoolSize ?? 1, "renderer.contextPoolSize", { maximum: 64 }),
        sceneCacheBytes: finiteInteger(value.sceneCacheBytes ?? 512 * MiB, "renderer.sceneCacheBytes"),
        globalGpuBytes: finiteInteger(value.globalGpuBytes ?? 2 * GiB, "renderer.globalGpuBytes"),
        angle: value.angle ? String(value.angle) : "",
        disableSandbox: Boolean(value.disableSandbox),
        allowSoftwareRenderer: Boolean(value.allowSoftwareRenderer),
        pbrEnabled: value.pbrEnabled === true,
        pbrTarget,
        launchArgs: Object.freeze([...launchArgs]),
    });
}

function normalizeAssetAdmission(value, listener) {
    const supplied = value ?? {};
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        throw invalid("assetAdmission must be an object.");
    }
    const unix = listener.kind === "socket";
    const enabled = supplied.enabled === undefined ? unix : Boolean(supplied.enabled);
    if (enabled && !unix) throw invalid("assetAdmission may only be enabled for a Unix-socket supervisor.");
    const prefix = unix ? listener.path : "";
    const inboxDir = String(supplied.inboxDir ?? (unix ? `${prefix}.run-package-inbox` : ""));
    const storageDir = String(supplied.storageDir ?? (unix ? `${prefix}.asset-store` : ""));
    const registryPath = String(supplied.registryPath ?? (unix ? `${prefix}.visual-source-registry.json` : ""));
    if (enabled && (!inboxDir || !storageDir || !registryPath)) {
        throw invalid("Enabled assetAdmission requires inboxDir, storageDir, and registryPath.");
    }
    return Object.freeze({
        enabled,
        inboxDir,
        storageDir,
        registryPath,
        unusedTtlMs: finiteInteger(supplied.unusedTtlMs ?? 60 * 60 * 1000, "assetAdmission.unusedTtlMs"),
        limits: resolveRunPackageLimits(supplied.limits ?? {}),
    });
}

export async function readSupervisorConfig(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        throw invalid(`Could not read supervisor config ${filePath}: ${error.message}`);
    }
}

const SUPERVISOR_CONFIG_ENV_NAMES = Object.freeze([
    "CEV_SIM_HEADLESS_SUPERVISOR_CONFIG",
    "CEV_SIM_SUPERVISOR_CONFIG",
]);

function projectEnvMode(env) {
    if (env.NODE_ENV === "test") return "test";
    if (env.NODE_ENV === "production") return "production";
    return "development";
}

function parseEnvFile(text) {
    const values = {};
    for (const line of String(text).split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
        if (!match) continue;
        let value = match[2].trim();
        const comment = value.match(/\s+#/);
        if (comment && !(value.startsWith('"') || value.startsWith("'"))) value = value.slice(0, comment.index).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    }
    return values;
}

/** Fill empty keys from `.env*` files. An existing process value wins. */
export async function applyProjectEnvFiles(env, root) {
    const mode = projectEnvMode(env);
    const names = [
        `.env.${mode}.local`,
        mode === "test" ? null : ".env.local",
        `.env.${mode}`,
        ".env",
    ].filter(Boolean);
    for (const name of names) {
        let text = "";
        try {
            text = await fs.readFile(path.join(root, name), "utf8");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            continue;
        }
        for (const [key, value] of Object.entries(parseEnvFile(text))) {
            if (!String(env[key] || "").trim()) env[key] = value;
        }
    }
    return env;
}

function supervisorConfigSelection(env) {
    for (const name of SUPERVISOR_CONFIG_ENV_NAMES) {
        const value = String(env[name] || "").trim();
        if (value) return { name, value };
    }
    return null;
}

function configCandidates(value, root) {
    if (path.isAbsolute(value)) return [value];
    const fromRoot = path.resolve(root, value);
    const fromCwd = path.resolve(value);
    return fromRoot === fromCwd ? [fromRoot] : [fromRoot, fromCwd];
}

/**
 * Read the supervisor document named by CEV_SIM_HEADLESS_SUPERVISOR_CONFIG,
 * or CEV_SIM_SUPERVISOR_CONFIG. The value is a JSON path, or inline JSON.
 * Relative paths resolve from the repository root.
 */
export async function readSupervisorConfigFromEnv(env = process.env, root = process.cwd()) {
    await applyProjectEnvFiles(env, root);
    const selected = supervisorConfigSelection(env);
    if (!selected) return null;
    if (selected.value.startsWith("{")) {
        try {
            return JSON.parse(selected.value);
        } catch (error) {
            throw invalid(`${selected.name} is not valid JSON: ${error.message}`);
        }
    }
    const candidates = configCandidates(selected.value, root);
    let lastError = null;
    for (const candidate of candidates) {
        try {
            return await readSupervisorConfig(candidate);
        } catch (error) {
            lastError = error;
        }
    }
    throw invalid(
        `${selected.name} could not be read. Tried ${candidates.join(", ")}. ${lastError?.message || ""}`.trim(),
    );
}

export function parseTcpAddress(value) {
    const text = String(value || "").trim();
    const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(text);
    const regular = /^([^:]+):(\d+)$/.exec(text);
    const match = ipv6 || regular;
    if (!match) throw invalid("TCP listener must use host:port (IPv6 addresses require brackets).");
    const port = finiteInteger(match[2], "TCP port", { minimum: 1, maximum: 65_535 });
    const host = match[1];
    return { host, port, address: net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}` };
}

export function isLoopbackHost(host) {
    const normalized = String(host || "").trim().toLowerCase();
    if (normalized === "localhost" || normalized === "::1") return true;
    if (net.isIP(normalized) === 4) return normalized.startsWith("127.");
    return false;
}

export function resolveSupervisorConfig(options = {}) {
    const supplied = options.config ?? {};
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw invalid("Supervisor config must be an object.");
    if (options.config !== undefined && supplied.kind !== SUPERVISOR_CONFIG_KIND) {
        throw invalid(`Supervisor config kind must be ${SUPERVISOR_CONFIG_KIND}.`);
    }
    if (options.config !== undefined && Number(supplied.version) !== SUPERVISOR_CONFIG_VERSION) {
        throw invalid(`Supervisor config version must be ${SUPERVISOR_CONFIG_VERSION}.`);
    }
    const presetName = String(options.preset ?? supplied.preset ?? "safety").toLowerCase();
    const preset = SUPERVISOR_PRESETS[presetName];
    if (!preset) throw invalid(`Unknown supervisor preset ${presetName}.`);
    const defaults = normalizeLimits(supplied.defaultLimits, preset.limits, "defaultLimits");
    const ceilings = normalizeLimits(supplied.hardCeilings, preset.limits, "hardCeilings");
    for (const field of RESOURCE_FIELD_NAMES) {
        if (defaults[field] > ceilings[field]) throw invalid(`defaultLimits.${field} exceeds hardCeilings.${field}.`);
    }
    const socket = options.socket ?? supplied.socket ?? null;
    const tcpValue = options.tcp ?? supplied.tcp ?? null;
    if (Boolean(socket) === Boolean(tcpValue)) throw invalid("Exactly one supervisor listener (--socket or --tcp) is required.");
    const tcp = tcpValue ? parseTcpAddress(tcpValue) : null;
    const allowRemoteTcp = Boolean(options.allowRemoteTcp ?? supplied.allowRemoteTcp ?? false);
    if (tcp && !allowRemoteTcp && !isLoopbackHost(tcp.host)) {
        throw invalid(`Refusing insecure non-loopback TCP listener ${tcp.address}; pass --allow-remote-tcp to opt in.`);
    }
    const listener = socket ? { kind: "socket", path: String(socket) } : { kind: "tcp", ...tcp };
    const packetTransports = options.packetTransports ?? supplied.packetTransports ?? null;
    return Object.freeze({
        kind: SUPERVISOR_CONFIG_KIND,
        version: SUPERVISOR_CONFIG_VERSION,
        preset: presetName,
        maxWorkers: finiteInteger(supplied.maxWorkers ?? preset.maxWorkers, "maxWorkers", { maximum: 1024 }),
        maxRpcMessageBytes: finiteInteger(supplied.maxRpcMessageBytes ?? preset.maxRpcMessageBytes, "maxRpcMessageBytes"),
        defaultLimits: defaults,
        hardCeilings: ceilings,
        memoryPollIntervalMs: finiteInteger(supplied.memoryPollIntervalMs ?? 250, "memoryPollIntervalMs"),
        shutdownGraceMs: finiteInteger(supplied.shutdownGraceMs ?? 5_000, "shutdownGraceMs"),
        killGraceMs: finiteInteger(supplied.killGraceMs ?? 5_000, "killGraceMs"),
        listener,
        allowRemoteTcp,
        renderer: normalizeRenderer(supplied.renderer),
        assetAdmission: normalizeAssetAdmission(supplied.assetAdmission, listener),
        packetTransports: packetTransports
            ? resolveSensorTransportHostConfig(packetTransports)
            : null,
    });
}

export function resolveBatchResourceLimits(request = {}, config) {
    const limits = {};
    for (const field of RESOURCE_FIELD_NAMES) {
        const requested = Number(request?.[field] ?? 0);
        if (!Number.isFinite(requested) || requested < 0 || !Number.isSafeInteger(requested)) {
            throw invalid(`resource_limits.${field} must be a non-negative safe integer.`);
        }
        const selected = requested === 0 ? config.defaultLimits[field] : requested;
        if (selected > config.hardCeilings[field]) {
            throw invalid(
                `resource_limits.${field}=${selected} exceeds the configured ceiling ${config.hardCeilings[field]}.`,
                { field, requested: selected, ceiling: config.hardCeilings[field] },
            );
        }
        limits[field] = selected;
    }
    return Object.freeze(limits);
}
