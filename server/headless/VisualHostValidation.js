import os from "node:os";

import { VISUAL_BYTES } from "../../app/simulation/visual/VisualScaleProfile.js";

export const VISUAL_HOST_ROLES = Object.freeze({
    x64Nvidia: "x64-nvidia",
    jetsonArm64: "jetson-arm64",
    jetsonAgxOrin: "jetson-agx-orin",
    jetsonAgxThor: "jetson-agx-thor",
});

const ORIN_MODELS = ["jetson agx orin"];
const THOR_MODELS = ["jetson agx thor"];
const UNSUPPORTED_ORIN = ["orin nx", "orin nano"];

export function evaluateVisualHostRole(report, { requireGpu = false } = {}) {
    const role = String(report?.role ?? "");
    const checks = { ...(report?.checks ?? {}) };
    const reasons = [];
    const model = String(report?.jetson?.model ?? "").replaceAll("\0", "").trim().toLowerCase();
    const architecture = report?.architecture ?? os.arch();
    const totalMemory = Number(report?.operatingSystem?.totalMemoryBytes ?? os.totalmem());
    const gpu = report?.gpuPreflight ?? {};
    const chromium = report?.runtimes?.chromium?.available === true;
    const configuredChromium = Boolean(report?.configuration?.renderer?.chromiumExecutable || report?.runtimes?.chromium?.output);
    const l4t = Boolean(report?.jetson?.l4tRelease || report?.jetson?.jetpack?.available);
    const powerMode = Boolean(report?.jetson?.powerMode?.available || report?.jetson?.powerMode?.output);
    const devices = report?.graphics?.deviceNodes ?? [];
    const deviceAccess = devices.length === 0
        ? architecture !== "arm64"
        : devices.every((device) => device.readable && (device.characterDevice !== false));

    if (role === VISUAL_HOST_ROLES.jetsonAgxOrin || role === VISUAL_HOST_ROLES.jetsonAgxThor) {
        checks.supportedArchitecture = architecture === "arm64";
        if (!checks.supportedArchitecture) reasons.push("Jetson AGX roles require arm64.");
        checks.jetsonModel = role === VISUAL_HOST_ROLES.jetsonAgxOrin
            ? matchesAny(model, ORIN_MODELS) && !matchesAny(model, UNSUPPORTED_ORIN)
            : matchesAny(model, THOR_MODELS);
        if (!checks.jetsonModel) {
            reasons.push(role === VISUAL_HOST_ROLES.jetsonAgxOrin
                ? "Host model must match Jetson AGX Orin; Orin NX/Nano are unsupported."
                : "Host model must match Jetson AGX Thor.");
        }
        const minimum = role === VISUAL_HOST_ROLES.jetsonAgxOrin
            ? 32 * VISUAL_BYTES.GiB
            : 64 * VISUAL_BYTES.GiB;
        checks.unifiedMemory = totalMemory >= minimum;
        if (!checks.unifiedMemory) {
            reasons.push(`Unified memory ${totalMemory} is below the ${minimum} byte minimum.`);
        }
        checks.jetpack = l4t;
        if (!checks.jetpack) reasons.push("JetPack/L4T release data is required.");
        checks.powerMode = powerMode;
        if (!checks.powerMode) reasons.push("nvpmodel power-mode report is required.");
        checks.devicePermissions = deviceAccess;
        if (!checks.devicePermissions) reasons.push("GPU device nodes must be readable character devices.");
        checks.configuredChromium = chromium && configuredChromium;
        if (!checks.configuredChromium) reasons.push("Configured Chromium is required.");
        checks.hardwareWebgl2 = gpu.available === true && gpu.production === true;
        if (!checks.hardwareWebgl2) {
            reasons.push("Hardware WebGL2 production preflight is required; software WebGL does not satisfy this role.");
        }
        checks.gpuRequirement = gpu.available === true;
        checks.telemetry = Boolean(report?.graphics?.nvidia?.available || report?.jetson?.tegrastats?.available);
    }

    if (role === VISUAL_HOST_ROLES.x64Nvidia && requireGpu) {
        checks.supportedArchitecture = architecture === "x64";
        checks.hardwareWebgl2 = gpu.available === true && gpu.production === true;
        checks.gpuRequirement = gpu.available === true;
        if (!checks.hardwareWebgl2) reasons.push("x64 NVIDIA visual-scale requires production hardware WebGL2.");
    }

    if (requireGpu && gpu.available !== true) {
        checks.gpuRequirement = false;
        reasons.push("GPU preflight is required for this host role.");
    }

    const passed = Object.values(checks).every(Boolean);
    return {
        role,
        checks,
        reasons,
        passed,
        capabilitySkipDisallowed: role === VISUAL_HOST_ROLES.jetsonAgxOrin
            || role === VISUAL_HOST_ROLES.jetsonAgxThor
            || (role === VISUAL_HOST_ROLES.x64Nvidia && requireGpu),
    };
}

function matchesAny(value, needles) {
    return needles.some((needle) => value.includes(needle));
}
