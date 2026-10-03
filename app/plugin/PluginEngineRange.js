import semver from "semver";

import { CEV_SIM_VERSION } from "../version.js";

/**
 * Default `engines.cevSim` / marketplace compatibility range for a host version.
 * 0.x hosts admit the current minor only (`0.2.0` → `>=0.2.0 <0.3.0`).
 * 1.x+ hosts admit the current major (`1.2.3` → `>=1.0.0 <2.0.0`).
 */
export function defaultCevSimEngineRange(simulatorVersion = CEV_SIM_VERSION) {
    const parsed = semver.parse(simulatorVersion, { loose: false });
    if (!parsed) {
        throw new TypeError(`Simulator version must be valid SemVer; received ${JSON.stringify(simulatorVersion)}.`);
    }
    if (parsed.major === 0) {
        return `>=${parsed.version} <0.${parsed.minor + 1}.0`;
    }
    return `>=${parsed.major}.0.0 <${parsed.major + 1}.0.0`;
}

/** Engine range for fixtures/examples verified across the 0.1 and 0.2 alpha lines. */
export const MIGRATION_CEV_SIM_ENGINE_RANGE = ">=0.1.0 <0.3.0";
