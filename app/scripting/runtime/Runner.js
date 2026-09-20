import { assertSupportedArtifact, createRuntimeError } from "./Artifact.js";
import { captureRuntimeState, restoreRuntimeState } from "./RuntimeState.js";
import { SignalStore } from "./SignalStore.js";
import { assertArtifactPluginRequirements } from "../../plugin/PluginRequirements.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../../plugin/PluginErrors.js";

function makeBlockOutputMap(blockOutput) {
    if (blockOutput?.map && typeof blockOutput.map === "object") {
        return blockOutput.map;
    }

    return {};
}

function freezeArtifactCopy(artifact) {
    return JSON.parse(JSON.stringify(artifact));
}

export class VisualScriptRunner {
    constructor(artifact, getBlockClass, options = {}) {
        assertSupportedArtifact(artifact);

        this.artifact = freezeArtifactCopy(artifact);
        this.getBlockClass = getBlockClass;
        this.blockRegistry = options.blockRegistry ?? null;
        this.pluginHost = options.pluginHost ?? null;
        this.pluginSession = options.pluginSession ?? null;
        this.scopeId = String(options.scopeId || "runner");
        this.disposed = false;
        this.units = new Map();
        this.storedData = {};
        this.externalInputs = {};
        this.externalOutputs = {};
        this.runtimeContext = options.runtimeContext || {};
        this.signalStore = options.signalStore || new SignalStore(options.signalSnapshot || {});

        if (this.blockRegistry) {
            try {
                assertArtifactPluginRequirements(this.artifact, this.blockRegistry, this.pluginSession?.plugins ?? null);
            } catch (error) {
                if (error?.code) throw error;
                throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, error.message, {
                    scopeId: this.scopeId,
                    requiresReset: true,
                    cause: error,
                });
            }
        }
        try {
            this._hydrateUnits();
            this._hydrateRuntimeConnections();
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    _createRuntimeManager() {
        return {
            getStoredData: (uuid) => this.storedData[uuid],
            storeData: (uuid, data) => {
                this.storedData[uuid] = data;
            },
            resolveExternalInput: (label, fallback = null) => {
                if (Object.prototype.hasOwnProperty.call(this.externalInputs, label)) {
                    return this.externalInputs[label];
                }
                return fallback;
            },
            setExternalOutput: (label, value) => {
                this.externalOutputs[label] = value;
            },
            getExternalOutputs: () => ({ ...this.externalOutputs }),
            getRuntimeContext: () => ({ ...this.runtimeContext }),
            setRuntimeContext: (context = {}) => {
                this.runtimeContext = context || {};
            },
            getSignalStore: () => this.signalStore,
            readSignal: (path, options = {}) => this.signalStore.read(path, options),
            writeSignal: (path, value, options = {}) => this.signalStore.write(path, value, options),
            setSignal: (path, value, options = {}) => this.signalStore.set(path, value, options),
            signalExists: (path) => this.signalStore.has(path),
            signalAge: (path) => this.signalStore.age(path),
            signalChanged: (path) => this.signalStore.changed(path),
            recordSignal: (path, value, options = {}) => this.signalStore.record(path, value, options),
            getSignalHistory: (path) => this.signalStore.history(path),
            getBlockRegistry: () => this.blockRegistry,
            getPluginHost: () => this.pluginHost,
            getPluginSession: () => this.pluginSession,
            getScopeId: () => this.scopeId,
            blockRegistry: this.blockRegistry,
            pluginHost: this.pluginHost,
            pluginSession: this.pluginSession,
            scopeId: this.scopeId,
            evaluationPolicy: {
                lazySelectors: this.artifact.version >= 3,
                memoizeExecute: true
            }
        };
    }

    setSignalStore(signalStore) {
        if (signalStore) {
            this.signalStore = signalStore;
        }
    }

    getSignalStore() {
        return this.signalStore;
    }

    setRuntimeContext(context = {}) {
        this.runtimeContext = context || {};
    }

    _hydrateUnits() {
        const runtimeManager = this._createRuntimeManager();

        this.artifact.nodes.forEach((node) => {
            const UnitClass = this.getBlockClass(node.type);
            if (!UnitClass) {
                throw new Error(`Unknown block type "${node.type}". Register it before running.`);
            }

            if (node.storedData !== undefined) {
                this.storedData[node.uuid] = node.storedData;
            }

            const unit = new UnitClass(node.uuid);
            unit.setManager(runtimeManager);
            this.pluginSession?.attachUnit?.(unit, { scopeId: this.scopeId, unitId: node.uuid });

            if (node.state) {
                unit.hydrateState(node.state);
            }

            if (node.runtimeState && typeof unit.hydrateRuntimeState === "function") {
                unit.hydrateRuntimeState(node.runtimeState);
            }

            if (node.ports && typeof node.ports === "object") {
                unit.typeMap = {
                    inputs: { ...(node.ports.inputs || {}) },
                    outputs: { ...(node.ports.outputs || {}) }
                };
            }

            this.units.set(node.uuid, unit);
        });
    }

    _hydrateRuntimeConnections() {
        this.units.forEach((unit) => {
            unit.inputs = {};
            unit.outputs = {};
            unit.getInput = (label) => this._resolveInput(unit.uuid, label);
        });

        this.artifact.transitions.success.forEach((transition) => {
            const outputUnit = this.units.get(transition.from);
            const inputUnit = this.units.get(transition.to);

            if (!outputUnit || !inputUnit) {
                throw new Error(`Transition references missing node: ${transition.from} -> ${transition.to}.`);
            }

            if (!outputUnit.outputs[transition.output]) {
                outputUnit.outputs[transition.output] = [];
            }

            outputUnit.outputs[transition.output].push(transition);
            inputUnit.inputs[transition.input] = transition;
        });
    }

    _resolveInput(unitUUID, inputLabel) {
        const reverse = this.artifact.reverseSuccess?.[unitUUID]?.[inputLabel];
        if (!reverse) {
            throw new Error(`Input "${inputLabel}" is not connected on block "${unitUUID}".`);
        }

        const blockOutput = this._evaluateNode(reverse.from);
        if (!blockOutput.has(reverse.output)) {
            throw new Error(`Block "${reverse.from}" did not produce output "${reverse.output}".`);
        }

        return blockOutput.get(reverse.output);
    }

    _evaluateNode(uuid) {
        if (this.outputMemo.has(uuid)) {
            return this.outputMemo.get(uuid);
        }

        if (this.evaluating.has(uuid)) {
            throw new Error(`Cycle detected at runtime while evaluating "${uuid}".`);
        }

        const unit = this.units.get(uuid);
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

    _syncRuntimeState() {
        this.artifact.nodes = this.artifact.nodes.map((node) => {
            const unit = this.units.get(node.uuid);
            if (!unit || typeof unit.serializeRuntimeState !== "function") return node;

            return {
                ...node,
                runtimeState: unit.serializeRuntimeState()
            };
        });
    }

    hydrateRuntimeState(stateByUuid = {}) {
        restoreRuntimeState(this.units, stateByUuid);
        this._syncRuntimeState();
    }

    run(inputs = {}, options = {}) {
        if (this.disposed) throw new Error("Cannot run a disposed visual-script runner.");
        if (options.signalStore) {
            this.setSignalStore(options.signalStore);
        }

        if (options.signalSnapshot) {
            this.signalStore.hydrate(options.signalSnapshot);
        }

        if (options.context || options.runtimeContext) {
            this.setRuntimeContext(options.context || options.runtimeContext);
        }

        this.externalInputs = inputs || {};
        this.externalOutputs = {};
        this.outputMemo = new Map();
        this.evaluating = new Set();
        const signalTransaction = this.signalStore.beginTransaction();
        const runtimeState = captureRuntimeState(this.units);
        const pluginTransaction = this.pluginSession?.beginEvaluation?.() ?? null;

        try {
            let result = null;

            if (this.artifact.interface.outputs.length > 0) {
                this.artifact.finalStates.forEach((uuid) => {
                    this._evaluateNode(uuid);
                });
            } else {
                const head = this.artifact.head || this.artifact.finalStates[0];
                result = this._evaluateNode(head);
            }

            this._syncRuntimeState();
            if (pluginTransaction) {
                this.pluginSession.commitEvaluation(pluginTransaction, this.signalStore);
            }
            this.signalStore.commitTransaction(signalTransaction);

            return {
                status: "success",
                outputs: { ...this.externalOutputs },
                result,
                signals: this.signalStore.snapshot({ includeHeavy: false }),
                e: null
            };
        } catch (error) {
            if (pluginTransaction) this.pluginSession.rollbackEvaluation(pluginTransaction);
            this.signalStore.rollbackTransaction(signalTransaction);
            restoreRuntimeState(this.units, runtimeState);
            this._syncRuntimeState();

            return {
                status: "failure",
                outputs: {},
                result: null,
                signals: this.signalStore.snapshot({ includeHeavy: false }),
                e: createRuntimeError(error)
            };
        }
    }

    serializeRuntimeState() {
        return this.artifact.nodes.reduce((state, node) => {
            state[node.uuid] = node.runtimeState || {};
            return state;
        }, {});
    }

    getOutputSnapshot(uuid) {
        const output = this.outputMemo?.get(uuid);
        return makeBlockOutputMap(output);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const unit of this.units.values()) unit?.dispose?.();
        this.units.clear();
        this.outputMemo?.clear?.();
        this.evaluating?.clear?.();
    }
}

export function createVisualScriptRunner(artifact, getBlockClass, options = {}) {
    return new VisualScriptRunner(artifact, getBlockClass, options);
}
