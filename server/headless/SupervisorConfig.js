import { promises as fs } from "node:fs";
import net from "node:net";

import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";

export const SUPERVISOR_CONFIG_KIND = "cev-sim.headless-supervisor-config";
export const SUPERVISOR_CONFIG_VERSION = 1;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

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

export async function readSupervisorConfig(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        throw invalid(`Could not read supervisor config ${filePath}: ${error.message}`);
    }
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
        listener: socket ? { kind: "socket", path: String(socket) } : { kind: "tcp", ...tcp },
        allowRemoteTcp,
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
