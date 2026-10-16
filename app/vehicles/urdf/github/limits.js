/** Acquisition budgets for a public GitHub URDF package. */

import { URDF_XML_MAX_BYTES } from "../parseUrdfXml.js";

export const GITHUB_URDF_LIMITS = Object.freeze({
    maxFiles: 256,
    maxFileBytes: 64 * 1024 * 1024,
    maxPackageBytes: 100 * 1024 * 1024,
    maxXmlBytes: URDF_XML_MAX_BYTES,
    maxDependencyDepth: 32,
    maxConcurrent: 4,
    deadlineMs: 120_000,
});

export function githubRequestLimit(limits = GITHUB_URDF_LIMITS) {
    return limits.maxFiles + 8;
}
