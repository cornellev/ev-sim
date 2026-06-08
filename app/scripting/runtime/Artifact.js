export const VISUAL_SCRIPT_KIND = "sensor-fusion.visual-script.program";
export const VISUAL_SCRIPT_VERSION = 2;
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
            stack: error.stack || null
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

    if (artifact.kind !== VISUAL_SCRIPT_KIND || artifact.version !== VISUAL_SCRIPT_VERSION) {
        throw new Error(`Unsupported compiled program artifact. Expected ${VISUAL_SCRIPT_KIND} v${VISUAL_SCRIPT_VERSION}.`);
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
}
