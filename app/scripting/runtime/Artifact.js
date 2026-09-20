import { normalizePluginRequirements } from "../../plugin/PluginRequirements.js";

export const VISUAL_SCRIPT_KIND = "cev-sim.visual-script.program";
export const VISUAL_SCRIPT_VERSION = 3;
export const SUPPORTED_ARTIFACT_VERSIONS = Object.freeze([2, 3]);
export const FAILURE_NODE_ID = "__visual_script_failure__";

export function createFailureNode() {
    return {
        uuid: FAILURE_NODE_ID,
        type: "FailureNode"
    };
}

export function createRuntimeError(error) {
    if (error && typeof error === "object") {
        return {
            name: error.name || "Error",
            message: error.message || String(error),
            stack: error.stack || null,
            ...(error.code ? { code: error.code } : {}),
            ...(error.pluginId ? { pluginId: error.pluginId } : {}),
            ...(error.packageHash ? { packageHash: error.packageHash } : {}),
            ...(error.contributionId ? { contributionId: error.contributionId } : {}),
            ...(error.path ? { path: error.path } : {}),
            ...(error.details !== undefined && error.details !== null ? { details: error.details } : {}),
            ...(error.scopeId ? { scopeId: error.scopeId } : {}),
            ...(error.unitId ? { unitId: error.unitId } : {}),
            ...(error.hook ? { hook: error.hook } : {}),
            ...(error.requiresReset === true ? { requiresReset: true } : {}),
        };
    }

    return {
        name: "Error",
        message: String(error),
        stack: null
    };
}

export function assertSupportedArtifact(artifact) {
    if (!artifact || typeof artifact !== "object") {
        throw new Error("Compiled program artifact must be an object.");
    }

    if (artifact.kind !== VISUAL_SCRIPT_KIND || !SUPPORTED_ARTIFACT_VERSIONS.includes(artifact.version)) {
        throw new Error(`Unsupported compiled program artifact. Expected ${VISUAL_SCRIPT_KIND} version ${SUPPORTED_ARTIFACT_VERSIONS.join(" or ")}.`);
    }

    if (!Array.isArray(artifact.Q) || !Array.isArray(artifact.nodes)) {
        throw new Error("Compiled program artifact is missing its node tables.");
    }

    if (!artifact.transitions || !Array.isArray(artifact.transitions.success) || !Array.isArray(artifact.transitions.failure)) {
        throw new Error("Compiled program artifact is missing transition tables.");
    }

    if (artifact.transitions.failure.length > 0) {
        throw new Error("Compiled program artifacts cannot contain failure transitions.");
    }

    if (!artifact.reverseSuccess || typeof artifact.reverseSuccess !== "object") {
        throw new Error("Compiled program artifact is missing reverse success transitions.");
    }

    if (!artifact.interface || !Array.isArray(artifact.interface.inputs) || !Array.isArray(artifact.interface.outputs)) {
        throw new Error("Compiled program artifact is missing its interface definition.");
    }
    normalizePluginRequirements(artifact.pluginRequirements);
}
