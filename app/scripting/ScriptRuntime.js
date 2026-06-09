import { assertSupportedArtifact } from "./runtime/Artifact.js";
import { isCompiledArtifact, isEditorDocument, normalizeScriptDocument } from "./EditorDocument.js";
import { getScriptDocument } from "./ScriptStorage.js";
import { ScriptManager } from "./ScriptManager.js";
import { SignalStore } from "./runtime/SignalStore.js";

function isPlainObject(value) {
    return Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value);
}

function looksLikeUrl(value) {
    if (value instanceof URL) return true;
    if (typeof value !== "string") return false;

    return /^(https?:|data:|blob:)/i.test(value)
        || value.startsWith("/")
        || value.startsWith("./")
        || value.startsWith("../")
        || value.includes("/")
        || value.endsWith(".json");
}

function normalizeLocalId(value) {
    if (typeof value !== "string") return null;
    return value.startsWith("local:") ? value.slice("local:".length) : value;
}

async function maybeRegisterBlocks(options = {}) {
    if (typeof options.registerBlocks === "function") {
        await options.registerBlocks();
    }

    const shouldRegisterBuiltIns = options.registerBuiltIns
        ?? (typeof window !== "undefined");

    if (!shouldRegisterBuiltIns) return;

    const { registerBuiltInBlocks } = await import("./registerBuiltInBlocks.js");
    registerBuiltInBlocks();
}

async function fetchJson(source, options = {}) {
    const fetcher = options.fetcher || globalThis.fetch;
    if (typeof fetcher !== "function") {
        throw new Error("Cannot load script from URL because fetch is not available.");
    }

    const response = await fetcher(String(source));
    if (!response?.ok) {
        const status = response?.status ? ` ${response.status}` : "";
        const statusText = response?.statusText ? ` ${response.statusText}` : "";
        throw new Error(`Could not load visual script from URL:${status}${statusText}`);
    }

    if (typeof response.json === "function") {
        return response.json();
    }

    if (typeof response.text === "function") {
        return JSON.parse(await response.text());
    }

    throw new Error("URL loader did not return a JSON-capable response.");
}

async function getLocalScriptDocument(id, options = {}) {
    const getDocument = options.getDocument || getScriptDocument;
    const document = await getDocument(id);

    if (!document) {
        throw new Error(`Local visual script "${id}" was not found.`);
    }

    return document;
}

function artifactFromDocument(document) {
    const normalized = normalizeScriptDocument(document);
    if (!normalized.latestValidArtifact) {
        throw new Error(`Visual script "${normalized.name}" does not have a latest valid compiled artifact.`);
    }

    return normalized.latestValidArtifact;
}

function artifactFromValue(value) {
    if (isCompiledArtifact(value)) {
        return value;
    }

    if (isEditorDocument(value)) {
        return artifactFromDocument(value);
    }

    throw new Error("Unsupported visual script source. Expected a compiled artifact or editor document.");
}

async function resolveArtifact(source, options = {}) {
    if (source instanceof URL || (typeof source === "string" && looksLikeUrl(source))) {
        return artifactFromValue(await fetchJson(source, options));
    }

    if (typeof source === "string") {
        return artifactFromDocument(await getLocalScriptDocument(normalizeLocalId(source), options));
    }

    if (isPlainObject(source) && source.localId) {
        return artifactFromDocument(await getLocalScriptDocument(source.localId, options));
    }

    if (isPlainObject(source) && source.id && !source.kind) {
        return artifactFromDocument(await getLocalScriptDocument(source.id, options));
    }

    return artifactFromValue(source);
}

function positionalInputsToObject(inputPorts, values) {
    return inputPorts.reduce((inputs, inputPort, index) => {
        inputs[inputPort.label] = values[index];
        return inputs;
    }, {});
}

function normalizeRunInputs(artifact, args) {
    if (args.length === 0) return {};

    if (args.length === 1 && isPlainObject(args[0])) {
        return args[0];
    }

    return positionalInputsToObject(artifact.interface.inputs || [], args);
}

export class LoadedVisualScript {
    constructor(artifact, options = {}) {
        assertSupportedArtifact(artifact);

        this.artifact = artifact;
        this.name = artifact.name;
        this.interface = artifact.interface;
        this.signalStore = options.signalStore || new SignalStore(options.signalSnapshot || {});
        this.runtimeContext = options.runtimeContext || options.context || {};
        this.runner = options.runner || ScriptManager.createRunner(artifact, {
            signalStore: this.signalStore,
            runtimeContext: this.runtimeContext
        });
    }

    runResult(...inputs) {
        return this.runner.run(normalizeRunInputs(this.artifact, inputs), {
            signalStore: this.signalStore,
            runtimeContext: this.runtimeContext
        });
    }

    run(...inputs) {
        const result = this.runResult(...inputs);
        if (result.status === "failure") {
            throw new Error(result.e?.message || "Visual script execution failed.");
        }

        return result.outputs;
    }

    getSignalStore() {
        return this.signalStore;
    }

    setSignal(path, value, options = {}) {
        return this.signalStore.set(path, value, options);
    }

    readSignal(path, options = {}) {
        return this.signalStore.read(path, options);
    }
}

export function createLoadedScript(artifact, options = {}) {
    return new LoadedVisualScript(artifact, options);
}

export async function loadScript(source, options = {}) {
    await maybeRegisterBlocks(options);
    const artifact = await resolveArtifact(source, options);
    return createLoadedScript(artifact, options);
}
