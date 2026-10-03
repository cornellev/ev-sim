/**
 * Coordinated product version for browser and headless runtimes.
 * Must stay equal to package.json, plugin.json, and the Python package version.
 * Enforced by `npm run release:check`.
 */
export const CEV_SIM_VERSION = "0.2.0";

export function isMajorZeroVersion(version = CEV_SIM_VERSION) {
    const major = Number.parseInt(String(version).split(".")[0], 10);
    return Number.isFinite(major) && major === 0;
}
