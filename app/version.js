/**
 * Coordinated product version for browser and headless runtimes.
 * Must stay equal to package.json, plugin.json, and the Python package version.
 * Change it with `npm run version:bump`. `npm run release:check` enforces the match.
 */
export const CEV_SIM_VERSION = "0.3.0";

export function isMajorZeroVersion(version = CEV_SIM_VERSION) {
    const major = Number.parseInt(String(version).split(".")[0], 10);
    return Number.isFinite(major) && major === 0;
}

export function getSubVersion() {
    return parseInt(CEV_SIM_VERSION.split(".")[2]);
}

export function getMinorVersion() {
    return parseInt(CEV_SIM_VERSION.split(".")[1]);
}

export function getMajorVersion() {
    return parseInt(CEV_SIM_VERSION.split(".")[0]);
}