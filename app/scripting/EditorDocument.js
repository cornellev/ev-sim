import { VISUAL_SCRIPT_KIND, VISUAL_SCRIPT_VERSION } from "./runtime/Artifact.js";

export const EDITOR_DOCUMENT_KIND = "sensor-fusion.visual-script.editor-document";
export const EDITOR_DOCUMENT_VERSION = 1;

export function createDocumentId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return `script-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function nowIso() {
    return new Date().toISOString();
}

export function isCompiledArtifact(value) {
    return Boolean(value)
        && typeof value === "object"
        && value.kind === VISUAL_SCRIPT_KIND
        && value.version === VISUAL_SCRIPT_VERSION;
}

export function isEditorDocument(value) {
    return Boolean(value)
        && typeof value === "object"
        && value.kind === EDITOR_DOCUMENT_KIND
        && value.version === EDITOR_DOCUMENT_VERSION;
}

export function createEmptyGraph(outputNodeConfig = null) {
    return {
        head: "head-uuid",
        outputNodeConfig,
        nodes: [],
        connections: []
    };
}

export function createScriptDocument({
    id = createDocumentId(),
    name = "Untitled Script",
    graph = createEmptyGraph(),
    latestValidArtifact = null,
    compileStatus = null,
    sourceType = "editable",
    createdAt = nowIso(),
    updatedAt = createdAt
} = {}) {
    const validArtifact = isCompiledArtifact(latestValidArtifact) ? latestValidArtifact : null;

    return {
        kind: EDITOR_DOCUMENT_KIND,
        version: EDITOR_DOCUMENT_VERSION,
        id,
        name: normalizeDocumentName(name),
        sourceType,
        editable: sourceType === "editable",
        createdAt,
        updatedAt,
        graph,
        latestValidArtifact: validArtifact,
        compileStatus: compileStatus || {
            valid: Boolean(validArtifact),
            error: null,
            artifactUpdatedAt: validArtifact ? updatedAt : null
        }
    };
}

export function createArtifactOnlyDocument(artifact, { id = createDocumentId(), name = null } = {}) {
    if (!isCompiledArtifact(artifact)) {
        throw new Error("Cannot create an artifact-only document from an unsupported artifact.");
    }

    const timestamp = nowIso();
    return createScriptDocument({
        id,
        name: name || artifact.name || "Imported Program",
        graph: null,
        latestValidArtifact: artifact,
        sourceType: "artifact",
        createdAt: timestamp,
        updatedAt: timestamp,
        compileStatus: {
            valid: true,
            error: null,
            artifactUpdatedAt: timestamp
        }
    });
}

export function normalizeDocumentName(name) {
    const trimmed = String(name || "").trim();
    return trimmed.length > 0 ? trimmed : "Untitled Script";
}

export function normalizeScriptDocument(document) {
    if (!isEditorDocument(document)) {
        throw new Error("Unsupported editable script document.");
    }

    return createScriptDocument({
        ...document,
        id: document.id || createDocumentId(),
        name: document.name,
        graph: document.editable === false ? null : (document.graph || createEmptyGraph()),
        sourceType: document.sourceType || (document.editable === false ? "artifact" : "editable"),
        createdAt: document.createdAt || nowIso(),
        updatedAt: document.updatedAt || document.createdAt || nowIso(),
        latestValidArtifact: document.latestValidArtifact,
        compileStatus: document.compileStatus
    });
}

export function summarizeScriptDocument(document) {
    const artifact = document.latestValidArtifact;
    const inputs = artifact?.interface?.inputs?.length || 0;
    const outputs = artifact?.interface?.outputs?.length || 0;
    const updatedAt = document.updatedAt || document.createdAt || null;

    return {
        id: document.id,
        name: document.name,
        sourceType: document.sourceType || (document.editable === false ? "artifact" : "editable"),
        editable: document.editable !== false,
        valid: Boolean(document.compileStatus?.valid),
        error: document.compileStatus?.error || null,
        inputs,
        outputs,
        updatedAt
    };
}

