
import { defaultBlockRegistry, registerBlockType } from "./BlockRegistry.js";
import { assertSupportedArtifact, createRuntimeError } from "./runtime/Artifact.js";
import { compileVisualScript } from "./runtime/Compiler.js";
import { createVisualScriptRunner } from "./runtime/Runner.js";
import { captureRuntimeState, restoreRuntimeState } from "./runtime/RuntimeState.js";
import { SignalStore } from "./runtime/SignalStore.js";
import { portsCompatible } from "./types/PortTypes.js";
import {
    findRejectedBinding,
    findUnboundGeneric,
    hasDeclaredPort,
    resolvedPortType
} from "./types/TypeScheme.js";
import { applyBindings, planUnify, recomputeBindings } from "./types/unifyGraph.js";

export { clearBlockTypeRegistryForTests, getRegisteredBlockType, registerBlockType } from "./BlockRegistry.js";

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

class Connection {
    constructor(outputUnit, outputLabel, inputUnit, inputLabel) {
        this.outputUnit = outputUnit;
        this.outputLabel = outputLabel;
        this.inputUnit = inputUnit;
        this.inputLabel = inputLabel;
    }

    /**
     * @returns {{unit: UnitBlock, label: String}}
     */
    getOutput() {
        return { unit: this.outputUnit, label: this.outputLabel };
    }

    getInput() {
        return { unit: this.inputUnit, label: this.inputLabel };
    }

    matches(outputUUID, outputLabel, inputUUID, inputLabel) {
        return this.outputUnit.uuid === outputUUID && this.outputLabel === outputLabel && this.inputUnit.uuid === inputUUID && this.inputLabel === inputLabel;
    }
}

export function storeData(uuid, data) {
    const event = new CustomEvent('data-stored', { detail: { uuid, data } });
    document.dispatchEvent(event);
}

export function reregister(uuid) {
    const event = new CustomEvent('reregister-unit', { detail: { uuid } });
    document.dispatchEvent(event);
}

export function requestUnitReconfiguration(uuid, patch = {}) {
    if (typeof document === "undefined") {
        return { ok: false, error: "Unit reconfiguration requires the scripting editor." };
    }

    const detail = { uuid, patch, result: null };
    document.dispatchEvent(new CustomEvent("reconfigure-unit", { detail }));
    return detail.result || { ok: false, error: `Unit "${uuid}" is not attached to the scripting editor.` };
}



export function usesLazySelectors(manager) {
    return manager?.evaluationPolicy?.lazySelectors === true;
}

export class BlockOutput {
    constructor() {
        this.map = {};
    }

    set(label, type) {
        this.map[label] = type;
        return this;
    }

    setDeclared(unit, label, value) {
        if (unit?.outputType(label) !== undefined) this.map[label] = value;
        return this;
    }

    get(label) {
        if (!Object.keys(this.map).includes(label)) return null;

        return this.map[label];
    }

    has(label) {
        return Object.prototype.hasOwnProperty.call(this.map, label);
    }
}

export class UnitBlock {
    
    constructor(uuid) {
        this.inputs = {};
        this.outputs = {};

        this.manager = null;
        
        this.uuid = uuid;
        this.state = {};

        this.typeMap = {
            outputs: {},
            inputs: {}
        };
        this.typeBindings = {};

        this.register();

        this.updateNofitications = new Set();
    }

    register() {

    }

    typeId() {
        return this.constructor.blockType || this.constructor.name;
    }

    onConnectionsUpdate() {

    }

    reregister() {
        this.typeMap = {
            outputs: {},
            inputs: {}
        };

        this.register();
    }

    /**
     * 
     * @param {ScriptManager} manager 
     */
    setManager(manager) {
        this.manager = manager;
    }

    serializeState() {
        return { ...this.state };
    }

    hydrateState(state = {}) {
        this.state = { ...state };
        this.reregister();
    }

    serializeRuntimeState() {
        return {};
    }

    hydrateRuntimeState() {

    }

    getStateValue(key, domId, fallback = null) {
        if (Object.prototype.hasOwnProperty.call(this.state, key)) {
            return this.state[key];
        }

        if (typeof document !== "undefined" && domId) {
            const value = document.getElementById(domId)?.value;
            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }

        return fallback;
    }

    getProgramPortDefinition() {
        return null;
    }

    getBindingDefinition() {
        return null;
    }

    getEntrypointDefinition() {
        return null;
    }

    resolveInputLabel(label) {
        return label;
    }

    resolveOutputLabel(label) {
        return label;
    }

    registerInput(label, type) {
        this.typeMap.inputs[label] = type;
    }

    editInput(label, newType) {
        if (!this.typeMap.inputs[label]) throw new Error("Input label not found");
        this.typeMap.inputs[label] = newType;
    }

    registerOutput(label, type) {
        this.typeMap.outputs[label] = type;
    }

    editOutput(label, newType) {
        if (!this.typeMap.outputs[label]) throw new Error("Output label not found");
        this.typeMap.outputs[label] = newType;
    }

    inputType(label) {
        return resolvedPortType(this, "inputs", label);
    }

    outputType(label) {
        return resolvedPortType(this, "outputs", label);
    }

    hasInput(label) {
        return !!this.inputs[this.resolveInputLabel(label)];
    }

    hasOutput(label) {
        return !!this.outputs[this.resolveOutputLabel(label)];
    }

    addInput(label, connection) {
        const resolvedLabel = this.resolveInputLabel(label);
        if (this.inputs[resolvedLabel]) throw new Error("Input with this name already exists");
        this.inputs[resolvedLabel] = connection;

        this.notifyUpdate(crypto.randomUUID());
    }

    addOutput(label, connection) {
        const resolvedLabel = this.resolveOutputLabel(label);
        if (!Object.keys(this.outputs).includes(resolvedLabel)) {
            this.outputs[resolvedLabel] = [];
        }
        
        this.outputs[resolvedLabel].push(connection);

        this.notifyUpdate(crypto.randomUUID());
    }

    removeInput(label) {
        const resolvedLabel = this.resolveInputLabel(label);
        if (!this.inputs[resolvedLabel]) return;
        delete this.inputs[resolvedLabel];
        this.notifyUpdate(crypto.randomUUID());
    }

    removeOutputConnection(label, predicate) {
        const resolvedLabel = this.resolveOutputLabel(label);
        if (!Object.keys(this.outputs).includes(resolvedLabel)) return;

        const before = this.outputs[resolvedLabel].length;
        this.outputs[resolvedLabel] = this.outputs[resolvedLabel].filter((connection) => !predicate(connection));

        if (this.outputs[resolvedLabel].length === 0) {
            delete this.outputs[resolvedLabel];
        }

        if (before !== (this.outputs[resolvedLabel]?.length || 0)) {
            this.notifyUpdate(crypto.randomUUID());
        }
    }

    getStoredData() {
        if (!this.manager) return undefined;
        return this.manager.getStoredData(this.uuid);
    }

    notifyUpdate(key) {
        if (key == null) return;
        if (this.updateNofitications.has(key)) return; // prevent infinite loops

        this.updateNofitications.add(key);
        
        this.onConnectionsUpdate();

        for (const output in this.outputs) {
            const connections = this.outputs[output];
            connections.forEach(conn => {
                conn.inputUnit.notifyUpdate(key);
            });
        }
        for (const input in this.inputs) {
            const connection = this.inputs[input];
            connection.getOutput().unit.notifyUpdate(key);
        }
    }

    getInput(label) {
        const resolvedLabel = this.resolveInputLabel(label);
        if (!this.inputs[resolvedLabel]) throw new Error("Input not found");
        const crossOut = this.inputs[resolvedLabel].getOutput();
        if (!crossOut.unit.valid()) return null;

        const blockOutput = this.manager.evaluateUnit(crossOut.unit.uuid);
        if (!blockOutput.has(crossOut.label)) {
            throw new Error(`Block "${crossOut.unit.uuid}" did not produce output "${crossOut.label}".`);
        }

        return blockOutput.get(crossOut.label);
    }

    execute() {
        
    }

    valid() {
        // to be overridden in subclasses, return false to prevent compilation
        return false;
    }
}

export class CompiledProgramUnitBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);
        this.runner = null;
        this.pendingRuntimeState = null;
    }

    register() {
        const compiledProgram = this.state?.compiledProgram;
        const inputPorts = compiledProgram?.interface?.inputs || [];
        const outputPorts = compiledProgram?.interface?.outputs || [];

        inputPorts.forEach((inputPort) => {
            this.registerInput(inputPort.label, inputPort.type);
        });

        outputPorts.forEach((outputPort) => {
            this.registerOutput(outputPort.label, outputPort.type);
        });
    }

    hydrateState(state = {}) {
        this.runner?.dispose?.();
        super.hydrateState(state);
        this.runner = null;
        this.pendingRuntimeState = null;
    }

    serializeRuntimeState() {
        if (this.runner) return this.runner.serializeRuntimeState();
        if (this.pendingRuntimeState) return cloneJson(this.pendingRuntimeState);

        return (this.state?.compiledProgram?.nodes || []).reduce((snapshot, node) => {
            snapshot[node.uuid] = cloneJson(node.runtimeState || {});
            return snapshot;
        }, {});
    }

    hydrateRuntimeState(state = {}) {
        const snapshot = state && typeof state === "object" && Object.keys(state).length > 0
            ? cloneJson(state)
            : null;
        if (this.runner && snapshot) {
            this.runner.hydrateRuntimeState(snapshot);
            this.pendingRuntimeState = null;
            return;
        }
        this.pendingRuntimeState = snapshot;
    }

    valid() {
        const compiledProgram = this.state?.compiledProgram;
        if (!compiledProgram) return false;

        const inputPorts = compiledProgram?.interface?.inputs || [];
        return inputPorts.every((inputPort) => this.hasInput(inputPort.label));
    }

    execute() {
        const compiledProgram = this.state?.compiledProgram;
        if (!compiledProgram) {
            return new BlockOutput();
        }

        assertSupportedArtifact(compiledProgram);

        const inputPorts = compiledProgram?.interface?.inputs || [];
        const providedInputs = {};

        inputPorts.forEach((inputPort) => {
            providedInputs[inputPort.label] = this.getInput(inputPort.label);
        });

        if (!this.runner) {
            this.runner = ScriptManager.createRunner(compiledProgram, {
                signalStore: this.manager?.getSignalStore?.(),
                runtimeContext: this.manager?.getRuntimeContext?.(),
                blockRegistry: this.manager?.getBlockRegistry?.() ?? this.manager?.blockRegistry,
                pluginHost: this.manager?.getPluginHost?.() ?? this.manager?.pluginHost,
                pluginSession: this.manager?.getPluginSession?.() ?? this.manager?.pluginSession,
                scopeId: `${this.manager?.getScopeId?.() ?? this.manager?.scopeId ?? "script"}/compiled:${this.uuid}`,
            });
            if (this.pendingRuntimeState) {
                this.runner.hydrateRuntimeState(this.pendingRuntimeState);
                this.pendingRuntimeState = null;
            }
        } else {
            this.runner.setSignalStore?.(this.manager?.getSignalStore?.());
            this.runner.setRuntimeContext?.(this.manager?.getRuntimeContext?.() || {});
        }

        const run = this.runner.run(providedInputs);
        if (run.status === "failure") {
            const error = new Error(`Imported compiled program failed: ${run.e?.message || "unknown error"}`);
            Object.assign(error, run.e ?? {});
            throw error;
        }

        const output = new BlockOutput();

        const outputPorts = compiledProgram?.interface?.outputs || [];
        outputPorts.forEach((outputPort) => {
            output.set(outputPort.label, run.outputs[outputPort.label]);
        });

        return output;
    }

    dispose() {
        this.runner?.dispose?.();
        this.runner = null;
    }
}

registerBlockType("CompiledProgramUnitBlock", CompiledProgramUnitBlock);

export class LocalScriptProgramBlock extends CompiledProgramUnitBlock {
    static blockType = "LocalScriptProgramBlock";
    static isLocalScriptBlock = true;

    hydrateState(state = {}) {
        super.hydrateState({
            sourceScriptId: state.sourceScriptId || null,
            sourceRevision: state.sourceRevision || null,
            name: state.name || state.compiledProgram?.name || "Local Script",
            compiledProgram: state.compiledProgram || null
        });
    }
}

registerBlockType("LocalScriptProgramBlock", LocalScriptProgramBlock);


// Below, this I made myself

export class ScriptManager {
    constructor({
        blockRegistry = defaultBlockRegistry,
        pluginHost = null,
        pluginSession = null,
        scopeId = "script",
    } = {}) {
        this.blockRegistry = blockRegistry;
        this.pluginHost = pluginHost;
        this.pluginSession = pluginSession;
        this.scopeId = String(scopeId || "script");
        this.pluginLocks = [];
        this.disposed = false;
        this.units = [];

        this.head = null;

        this.storedData = {};
        this.externalInputs = {};
        this.externalOutputs = {};
        this.runtimeContext = {};
        this.signalStore = new SignalStore();
        this.outputMemo = new Map();
        this.evaluating = new Set();
        this.evaluationPolicy = { lazySelectors: true, memoizeExecute: true };
        this.restoreErrors = [];
    }

    _beginEvaluation() {
        this.outputMemo = new Map();
        this.evaluating = new Set();
    }

    pruneRestoreErrors() {
        if (!Array.isArray(this.restoreErrors) || this.restoreErrors.length === 0) {
            this.restoreErrors = [];
            return this.restoreErrors;
        }

        const units = new Map(this.units.map((unit) => [unit.uuid, unit]));
        this.restoreErrors = this.restoreErrors.filter(({ connection }) => {
            const fromUnit = units.get(connection?.from);
            const toUnit = units.get(connection?.to);
            if (!fromUnit || !toUnit) return false;

            const inputLabel = toUnit.resolveInputLabel(connection.input);
            if (toUnit.inputs?.[inputLabel]) return false;

            return true;
        });
        return this.restoreErrors;
    }

    evaluateUnit(uuid) {
        if (this.outputMemo.has(uuid)) {
            return this.outputMemo.get(uuid);
        }

        if (this.evaluating.has(uuid)) {
            throw new Error(`Cycle detected at runtime while evaluating "${uuid}".`);
        }

        const unit = this.units.find((item) => item.uuid === uuid);
        if (!unit) {
            throw new Error(`Runtime node "${uuid}" is not available.`);
        }

        this.evaluating.add(uuid);
        let output;
        try {
            output = unit.execute();
        } finally {
            this.evaluating.delete(uuid);
        }

        if (!output || typeof output.has !== "function" || typeof output.get !== "function") {
            throw new Error(`Block "${uuid}" did not return a BlockOutput.`);
        }

        this.outputMemo.set(uuid, output);
        return output;
    }

    getStoredData(uuid) {
        return this.storedData[uuid];
    }

    storeData(uuid, data) {
        this.storedData[uuid] = data;
        // update
        this.units.find(u => u.uuid === uuid)?.notifyUpdate(crypto.randomUUID());
    }

    reconfigureUnitDetailed(uuid, patch = {}) {
        const unit = this.units.find((candidate) => candidate.uuid === uuid);
        if (!unit) {
            return { ok: false, error: `Unit "${uuid}" not found.` };
        }

        const hasState = Object.prototype.hasOwnProperty.call(patch, "state");
        const hasStoredData = Object.prototype.hasOwnProperty.call(patch, "storedData");
        const hadStoredData = Object.prototype.hasOwnProperty.call(this.storedData, uuid);
        const previousStoredData = cloneJson(this.storedData[uuid]);
        const previousState = cloneJson(unit.serializeState());
        const previousRuntimeState = cloneJson(unit.serializeRuntimeState());
        const previousTypeMap = cloneJson(unit.typeMap);
        const previousBindings = new Map(this.units.map((candidate) => [
            candidate.uuid,
            cloneJson(candidate.typeBindings || {})
        ]));

        const restore = () => {
            unit.state = cloneJson(previousState) || {};
            unit.typeMap = cloneJson(previousTypeMap) || { inputs: {}, outputs: {} };
            if (hadStoredData) this.storedData[uuid] = cloneJson(previousStoredData);
            else delete this.storedData[uuid];
            this.units.forEach((candidate) => {
                candidate.typeBindings = cloneJson(previousBindings.get(candidate.uuid)) || {};
            });
            unit.hydrateRuntimeState(cloneJson(previousRuntimeState));
        };

        try {
            if (hasStoredData) {
                if (patch.storedData === undefined) delete this.storedData[uuid];
                else this.storedData[uuid] = cloneJson(patch.storedData);
            }

            if (hasState) unit.hydrateState(cloneJson(patch.state) || {});
            else unit.reregister();

            const plan = planUnify(this);
            if (!plan.ok) {
                restore();
                return { ok: false, error: plan.error };
            }

            applyBindings(this, plan.bindings);
            this.pruneRestoreErrors();
            unit.notifyUpdate(crypto.randomUUID());

            return {
                ok: true,
                error: null,
                state: cloneJson(unit.serializeState()),
                storedData: cloneJson(this.storedData[uuid]),
                ports: cloneJson(unit.typeMap),
                typeBindings: cloneJson(unit.typeBindings || {})
            };
        } catch (error) {
            restore();
            return { ok: false, error: error?.message || String(error) };
        }
    }

    setRuntimeInputs(inputs = {}) {
        this.externalInputs = inputs || {};
    }

    resolveExternalInput(label, fallback = null) {
        if (Object.prototype.hasOwnProperty.call(this.externalInputs, label)) {
            return this.externalInputs[label];
        }
        return fallback;
    }

    setExternalOutput(label, value) {
        this.externalOutputs[label] = value;
    }

    getExternalOutputs() {
        return { ...this.externalOutputs };
    }

    setRuntimeContext(context = {}) {
        this.runtimeContext = context || {};
    }

    getRuntimeContext() {
        return { ...this.runtimeContext };
    }

    setSignalStore(signalStore) {
        if (signalStore) {
            this.signalStore = signalStore;
        }
    }

    getSignalStore() {
        return this.signalStore;
    }

    getBlockRegistry() {
        return this.blockRegistry;
    }

    getPluginHost() {
        return this.pluginHost;
    }

    getPluginSession() {
        return this.pluginSession;
    }

    getScopeId() {
        return this.scopeId;
    }

    readSignal(path, options = {}) {
        return this.signalStore.read(path, options);
    }

    writeSignal(path, value, options = {}) {
        return this.signalStore.write(path, value, options);
    }

    setSignal(path, value, options = {}) {
        return this.signalStore.set(path, value, options);
    }

    signalExists(path) {
        return this.signalStore.has(path);
    }

    signalAge(path) {
        return this.signalStore.age(path);
    }

    signalChanged(path) {
        return this.signalStore.changed(path);
    }

    recordSignal(path, value, options = {}) {
        return this.signalStore.record(path, value, options);
    }

    getSignalHistory(path) {
        return this.signalStore.history(path);
    }
    
    setHead(uuid) {
        this.head = uuid;
    }

    /**
     * @param {UnitBlock} unit 
     */
    addUnit(unit) {
        if (this.disposed) throw new Error("Cannot add a unit to a disposed ScriptManager.");
        unit.setManager(this);
        this.units.push(unit);
        this.pluginSession?.attachUnit?.(unit, { scopeId: this.scopeId, unitId: unit.uuid });
    }

    connectUnitsDetailed(outputUUID, outputLabel, inputUUID, inputLabel) {
        const outputUnit = this.units.find((unit) => unit.uuid === outputUUID);
        const inputUnit = this.units.find((unit) => unit.uuid === inputUUID);

        if (!outputUnit || !inputUnit) {
            return {
                ok: false,
                error: `Invalid UUIDs for connection "${outputUUID}" -> "${inputUUID}".`
            };
        }

        const resolvedOutputLabel = outputUnit.resolveOutputLabel(outputLabel);
        const resolvedInputLabel = inputUnit.resolveInputLabel(inputLabel);

        if (!hasDeclaredPort(outputUnit, "outputs", resolvedOutputLabel)) {
            return {
                ok: false,
                error: `Missing output port "${outputLabel}" on block "${outputUUID}".`
            };
        }

        if (!hasDeclaredPort(inputUnit, "inputs", resolvedInputLabel)) {
            return {
                ok: false,
                error: `Missing input port "${inputLabel}" on block "${inputUUID}".`
            };
        }

        const existing = (outputUnit.outputs[resolvedOutputLabel] || []).some((connection) =>
            connection.matches(outputUUID, resolvedOutputLabel, inputUUID, resolvedInputLabel)
        );
        if (existing) {
            return { ok: true, error: null };
        }

        if (inputUnit.inputs[resolvedInputLabel]) {
            return {
                ok: false,
                error: `Input "${resolvedInputLabel}" on block "${inputUUID}" already has a connection.`
            };
        }

        const plan = planUnify(this, {
            outputUUID,
            outputLabel: resolvedOutputLabel,
            inputUUID,
            inputLabel: resolvedInputLabel
        });
        if (!plan.ok) {
            return { ok: false, error: plan.error };
        }

        const connection = new Connection(outputUnit, resolvedOutputLabel, inputUnit, resolvedInputLabel);
        outputUnit.addOutput(resolvedOutputLabel, connection);
        inputUnit.addInput(resolvedInputLabel, connection);
        applyBindings(this, plan.bindings);
        this.pruneRestoreErrors();
        return { ok: true, error: null };
    }

    connectUnits(outputUUID, outputLabel, inputUUID, inputLabel) {
        return this.connectUnitsDetailed(outputUUID, outputLabel, inputUUID, inputLabel).ok;
    }

    disconnectUnits(outputUUID, outputLabel, inputUUID, inputLabel) {
        const outputUnit = this.units.find((unit) => unit.uuid === outputUUID);
        const inputUnit = this.units.find((unit) => unit.uuid === inputUUID);

        if (!outputUnit || !inputUnit) {
            return false;
        }

        const resolvedOutputLabel = outputUnit.resolveOutputLabel(outputLabel);
        const resolvedInputLabel = inputUnit.resolveInputLabel(inputLabel);
        let removedConnection = null;
        outputUnit.removeOutputConnection(resolvedOutputLabel, (connection) => {
            const shouldRemove = connection.matches(outputUUID, resolvedOutputLabel, inputUUID, resolvedInputLabel);
            if (shouldRemove) {
                removedConnection = connection;
            }
            return shouldRemove;
        });

        if (!removedConnection) {
            return false;
        }

        if (inputUnit.inputs[resolvedInputLabel] === removedConnection) {
            inputUnit.removeInput(resolvedInputLabel);
        }

        recomputeBindings(this);
        this.pruneRestoreErrors();
        return true;
    }

    execute() {
        if (!this.head) {
            console.error("No head unit set for execution");
            return;
        }

        if (!this.checkValidity()) {
            console.error("Script is not valid, cannot execute");
            return;
        }

        const headUnit = this.units.find(u => u.uuid === this.head);
        if (!headUnit) {
            console.error("Head unit not found");
            return;
        }

        const signalTransaction = this.signalStore.beginTransaction();
        const runtimeState = captureRuntimeState(this.units);
        const pluginTransaction = this.pluginSession?.beginEvaluation?.() ?? null;
        try {
            this._beginEvaluation();
            const result = this.evaluateUnit(headUnit.uuid);
            if (pluginTransaction) {
                this.pluginSession.commitEvaluation(pluginTransaction, this.signalStore);
            }
            this.signalStore.commitTransaction(signalTransaction);
            return result;
        } catch (error) {
            if (pluginTransaction) this.pluginSession.rollbackEvaluation(pluginTransaction);
            this.signalStore.rollbackTransaction(signalTransaction);
            restoreRuntimeState(this.units, runtimeState);
            throw error;
        }
    }

    executeProgram(inputs = {}, options = {}) {
        if (options.signalStore) {
            this.setSignalStore(options.signalStore);
        }

        if (options.signalSnapshot) {
            this.signalStore.hydrate(options.signalSnapshot);
        }

        this.setRuntimeContext(options.context || options.runtimeContext || this.runtimeContext);
        const signalTransaction = this.signalStore.beginTransaction();
        const runtimeState = captureRuntimeState(this.units);
        const pluginTransaction = this.pluginSession?.beginEvaluation?.() ?? null;

        try {
            this.setRuntimeInputs(inputs);
            this.externalOutputs = {};
            this._beginEvaluation();

            const outputUnits = this.units.filter((unit) => unit.constructor.programNodeRole === "output");
            if (outputUnits.length > 0) {
                outputUnits.forEach((unit) => {
                    if (unit.valid()) {
                        this.evaluateUnit(unit.uuid);
                    }
                });
                if (pluginTransaction) {
                    this.pluginSession.commitEvaluation(pluginTransaction, this.signalStore);
                }
                this.signalStore.commitTransaction(signalTransaction);
                return {
                    status: "success",
                    result: null,
                    outputs: this.getExternalOutputs(),
                    signals: this.signalStore.snapshot({ includeHeavy: false }),
                    e: null
                };
            }

            const result = this.execute();
            if (pluginTransaction) {
                this.pluginSession.commitEvaluation(pluginTransaction, this.signalStore);
            }
            this.signalStore.commitTransaction(signalTransaction);
            return {
                status: "success",
                result,
                outputs: this.getExternalOutputs(),
                signals: this.signalStore.snapshot({ includeHeavy: false }),
                e: null
            };
        } catch (err) {
            if (pluginTransaction) this.pluginSession.rollbackEvaluation(pluginTransaction);
            this.signalStore.rollbackTransaction(signalTransaction);
            restoreRuntimeState(this.units, runtimeState);
            return {
                status: "failure",
                result: null,
                outputs: {},
                signals: this.signalStore.snapshot({ includeHeavy: false }),
                e: createRuntimeError(err)
            };
        }
    }

    compile(name = "compiled-program") {
        return compileVisualScript(this, name, (type) => this.blockRegistry.get(type), this.blockRegistry);
    }

    static fromCompiled(compiledProgram) {
        return ScriptManager.createRunner(compiledProgram);
    }

    static runCompiled(compiledProgram, inputs = {}, options = {}) {
        return ScriptManager.createRunner(compiledProgram, options).run(inputs, options);
    }

    static createRunner(compiledProgram, options = {}) {
        const blockRegistry = options.blockRegistry ?? defaultBlockRegistry;
        return createVisualScriptRunner(compiledProgram, (type) => blockRegistry.get(type), {
            ...options,
            blockRegistry,
        });
    }

    static createCompiledProgramBlock(compiledProgram) {
        return class CompiledProgramBlock extends CompiledProgramUnitBlock {
            constructor(uuid) {
                super(uuid);
                this.state = {
                    ...this.state,
                    compiledProgram,
                    name: compiledProgram?.name || "Compiled Program"
                };
                this.reregister();
            }
        }
    }

    removeUnit(uuid) {
        const unit = this.units.find((item) => item.uuid === uuid);
        if (!unit) return;
        unit.dispose?.();

        const incoming = Object.values(unit.inputs);
        incoming.forEach((connection) => {
            const output = connection.getOutput();
            output.unit.removeOutputConnection(output.label, (candidate) => candidate === connection);
            unit.removeInput(connection.inputLabel);
        });

        const outgoing = Object.values(unit.outputs).flat();
        outgoing.forEach((connection) => {
            const input = connection.getInput();
            input.unit.removeInput(input.label);
            unit.removeOutputConnection(connection.outputLabel, (candidate) => candidate === connection);
        });

        this.units = this.units.filter((item) => item.uuid !== uuid);
        delete this.storedData[uuid];

        if (this.head === uuid) {
            this.head = null;
        }

        recomputeBindings(this);
        this.pruneRestoreErrors();
    }

    recomputeBindings() {
        return recomputeBindings(this);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const unit of this.units) unit?.dispose?.();
        this.units = [];
        this.outputMemo.clear();
        this.evaluating.clear();
    }

    checkValidity() {
        const outputUnits = this.units.filter((unit) => unit.constructor.programNodeRole === "output");
        if (!this.head && outputUnits.length === 0) return false;

        const visited = new Set();
        const stack = [];

        if (this.head) {
            stack.push(this.head);
        }

        outputUnits.forEach((unit) => {
            stack.push(unit.uuid);
        });

        while (stack.length > 0) {
            const current = stack.pop();
            if (visited.has(current)) continue;
            visited.add(current);

            const unit = this.units.find(u => u.uuid === current);
            if (!unit) return false; // unit not found

            if (!unit.valid()) return false; // unit is invalid

            if (findUnboundGeneric(unit) || findRejectedBinding(unit)) return false;

            // add connected units to stack
            for (const input in unit.inputs) {
                const connections = unit.inputs[input];
                const output = connections.getOutput();
                const outputType = output.unit.outputType(output.label);
                const inputType = unit.inputType(input);
                if (!outputType || !inputType || !portsCompatible(outputType, inputType)) return false;
                stack.push(output.unit.uuid);
            }
        }

        return true;
    }
    
}
