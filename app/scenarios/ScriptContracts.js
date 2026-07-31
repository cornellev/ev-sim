export const SCENARIO_SCRIPT_CONTRACTS = Object.freeze({
    FINISH: Object.freeze({
        id: "finish-predicate",
        inputs: Object.freeze([{ label: "time", type: "float64" }]),
        outputs: Object.freeze([{ label: "finished", type: "boolean" }]),
    }),
    EXPECTED_OUTCOME: Object.freeze({
        id: "expected-outcome",
        inputs: Object.freeze([{ label: "time", type: "float64" }]),
        outputs: Object.freeze([{ label: "passed", type: "boolean" }]),
    }),
});

function normalizePorts(ports) {
    return (Array.isArray(ports) ? ports : []).map((port) => ({
        label: String(port?.label ?? ""),
        type: String(port?.type ?? ""),
    }));
}

export function validateScriptContract(artifact, contract) {
    const issues = [];
    const inputs = normalizePorts(artifact?.interface?.inputs);
    const outputs = normalizePorts(artifact?.interface?.outputs);
    const validate = (actual, expected, direction) => {
        if (actual.length !== expected.length) {
            issues.push(`${direction} must contain exactly ${expected.length} port${expected.length === 1 ? "" : "s"}.`);
            return;
        }
        expected.forEach((port, index) => {
            if (actual[index]?.label !== port.label || actual[index]?.type !== port.type) {
                issues.push(`${direction}[${index}] must be ${port.label}: ${port.type}.`);
            }
        });
    };
    validate(inputs, contract.inputs, "inputs");
    validate(outputs, contract.outputs, "outputs");
    return { ok: issues.length === 0, issues, contract: contract.id };
}

export function assertScriptContract(artifact, contract, scriptId = "script") {
    const validation = validateScriptContract(artifact, contract);
    if (!validation.ok) {
        throw new Error(`Visual script "${scriptId}" does not satisfy ${contract.id}: ${validation.issues.join(" ")}`);
    }
    return validation;
}

export function invokeBooleanScript(script, contract, timeSeconds, inputs = {}) {
    const output = script.run({ ...inputs, time: Number(timeSeconds) || 0 });
    const label = contract.outputs[0].label;
    if (typeof output?.[label] !== "boolean") {
        throw new Error(`Visual script returned ${typeof output?.[label]} for ${label}; expected boolean.`);
    }
    return output[label];
}

function hashText(value) {
    const text = String(value ?? "scenario");
    let state = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        state ^= text.charCodeAt(index);
        state = Math.imul(state, 0x01000193);
    }
    return state >>> 0;
}

/**
 * Return an isolated deterministic RNG stream for a run-scoped script.
 * Streams are keyed so adding a different script does not perturb an existing
 * script's sequence.
 */
export function createScenarioRandom(seed, streamId = "default") {
    let state = hashText(`${String(seed ?? "0")}\u0000${String(streamId)}`);
    return () => {
        let value = (state += 0x6d2b79f5);
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

export function scriptRuntimeContext(seed, streamId, extra = {}) {
    return {
        ...extra,
        seed: String(seed ?? "0"),
        streamId: String(streamId ?? "default"),
        random: createScenarioRandom(seed, streamId),
    };
}
