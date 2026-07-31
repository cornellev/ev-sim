import {
    asObject,
    canonicalStringify,
    catalogLookup,
    cloneValue,
    hasCatalog,
    isPlainObject,
    stableHash,
    trimmedText,
} from "./ExperimentUtils.js";
import {
    normalizeMetricDefinitions,
    validateMetricDefinition,
} from "./MetricReducers.js";

export const EXPERIMENT_SUITE_KIND = "cev-sim.experiment-suite";
export const EXPERIMENT_SUITE_VERSION = 1;

export const EXPERIMENT_PARAMETER_TYPES = Object.freeze(["float64", "int32", "boolean", "string"]);
export const EXPERIMENT_PARAMETER_TARGETS = Object.freeze(["scalar-field", "script-input", "scenario-signal"]);

function normalizeIdSelection(value, fallback = []) {
    const selected = Array.isArray(value) ? value : fallback;
    return selected.map((entry) => trimmedText(isPlainObject(entry) ? entry.id : entry)).filter(Boolean);
}

function normalizeSeed(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") return trimmedText(value);
    return null;
}

function normalizeRange(value) {
    if (!isPlainObject(value)) return null;
    const start = Number(value.start);
    const stop = Number(value.stop ?? value.end);
    const step = Number(value.step);
    return {
        start: Number.isFinite(start) ? start : null,
        stop: Number.isFinite(stop) ? stop : null,
        step: Number.isFinite(step) ? step : null,
    };
}

export function normalizeParameterSweep(value = {}) {
    const source = asObject(value);
    return {
        parameterId: trimmedText(source.parameterId || source.id),
        values: (Array.isArray(source.values) ? source.values : []).map(cloneValue),
        range: normalizeRange(source.range),
    };
}

export function normalizeExperimentSuite(value = {}, { allowMissingKind = false } = {}) {
    const source = asObject(value);
    if (!allowMissingKind && source.kind !== undefined && source.kind !== EXPERIMENT_SUITE_KIND) {
        throw new Error(`Unsupported experiment suite kind: ${JSON.stringify(source.kind)}.`);
    }
    if (source.version !== undefined && Number(source.version) !== EXPERIMENT_SUITE_VERSION) {
        throw new Error(`Unsupported experiment suite version ${source.version}; expected ${EXPERIMENT_SUITE_VERSION}.`);
    }
    const selection = asObject(source.selection);
    const matrix = asObject(source.matrix);
    const scenarioIds = normalizeIdSelection(source.scenarioIds ?? selection.scenarioIds ?? source.scenarios);
    const manifestIds = normalizeIdSelection(source.manifestIds ?? selection.manifestIds ?? source.manifests);
    const exclusionValues = source.exclusions ?? matrix.exclusions;
    const execution = asObject(source.execution);
    const failurePolicy = execution.failurePolicy === "fail-fast"
        || execution.failFast === true
        || execution.continueOnFailure === false
        ? "fail-fast"
        : "continue";
    return {
        kind: EXPERIMENT_SUITE_KIND,
        version: EXPERIMENT_SUITE_VERSION,
        id: trimmedText(source.id, "untitled-suite"),
        name: trimmedText(source.name, "Untitled Experiment Suite"),
        description: trimmedText(source.description),
        scenarioIds,
        manifestIds,
        exclusions: (Array.isArray(exclusionValues) ? exclusionValues : []).map((entry) => ({
            scenarioId: trimmedText(entry?.scenarioId),
            manifestId: trimmedText(entry?.manifestId),
            reason: trimmedText(entry?.reason),
        })),
        seeds: (Array.isArray(source.seeds) ? source.seeds : ["42"]).map(normalizeSeed),
        sweeps: (Array.isArray(source.sweeps) ? source.sweeps : []).map(normalizeParameterSweep),
        metrics: normalizeMetricDefinitions(source.metrics),
        execution: {
            failurePolicy,
            continueOnFailure: failurePolicy === "continue",
        },
    };
}

export function createDefaultExperimentSuite(overrides = {}) {
    return normalizeExperimentSuite({
        kind: EXPERIMENT_SUITE_KIND,
        version: EXPERIMENT_SUITE_VERSION,
        id: "new-experiment-suite",
        name: "New Experiment Suite",
        description: "",
        scenarioIds: [],
        manifestIds: [],
        exclusions: [],
        seeds: ["42"],
        sweeps: [],
        metrics: [
            { id: "passed", source: { kind: "builtin", metric: "passed" } },
            { id: "duration", source: { kind: "builtin", metric: "duration" } },
        ],
        execution: { failurePolicy: "continue" },
        ...overrides,
    }, { allowMissingKind: true });
}

function parameterType(value) {
    const aliases = {
        number: "float64",
        float: "float64",
        integer: "int32",
        int: "int32",
        bool: "boolean",
    };
    const requested = trimmedText(value, "float64").toLowerCase();
    return aliases[requested] || requested;
}

export function normalizeParameterDeclaration(value = {}) {
    const source = asObject(value);
    const targetSource = asObject(source.target);
    const requestedKind = trimmedText(targetSource.kind || source.targetKind, "scalar-field");
    const targetKind = requestedKind === "field" ? "scalar-field" : requestedKind;
    const type = parameterType(source.type);
    const minimum = Number(source.minimum ?? source.min);
    const maximum = Number(source.maximum ?? source.max);
    return {
        id: trimmedText(source.id || source.parameterId),
        name: trimmedText(source.name, source.id || source.parameterId),
        type,
        default: cloneValue(source.default ?? source.defaultValue ?? null),
        minimum: Number.isFinite(minimum) ? minimum : null,
        maximum: Number.isFinite(maximum) ? maximum : null,
        allowedValues: Array.isArray(source.allowedValues ?? source.enum)
            ? (source.allowedValues ?? source.enum).map(cloneValue)
            : [],
        target: {
            kind: targetKind,
            path: trimmedText(targetSource.path || source.path),
            scriptId: trimmedText(targetSource.scriptId),
            input: trimmedText(targetSource.input),
        },
    };
}

export function validateParameterDeclaration(value, path = "parameters.0") {
    const declaration = normalizeParameterDeclaration(value);
    const issues = [];
    if (!declaration.id) issues.push({ path: `${path}.id`, message: "A parameter id is required." });
    if (!EXPERIMENT_PARAMETER_TYPES.includes(declaration.type)) {
        issues.push({ path: `${path}.type`, message: `Unsupported parameter type "${declaration.type}".` });
    }
    if (!EXPERIMENT_PARAMETER_TARGETS.includes(declaration.target.kind)) {
        issues.push({ path: `${path}.target.kind`, message: `Unsupported parameter target "${declaration.target.kind}".` });
    } else if (declaration.target.kind === "script-input") {
        if (!declaration.target.scriptId || !declaration.target.input) {
            issues.push({ path: `${path}.target`, message: "Script input targets require scriptId and input." });
        }
    } else if (!declaration.target.path) {
        issues.push({ path: `${path}.target.path`, message: `${declaration.target.kind} targets require a path.` });
    }
    if (declaration.minimum !== null && declaration.maximum !== null && declaration.minimum > declaration.maximum) {
        issues.push({ path: `${path}`, message: "Parameter minimum must not exceed its maximum." });
    }
    if (declaration.default !== null) {
        const validation = validateParameterValue(declaration.default, declaration);
        if (!validation.ok) issues.push({ path: `${path}.default`, message: validation.message });
    }
    for (const [index, allowedValue] of declaration.allowedValues.entries()) {
        const validation = validateParameterValue(allowedValue, { ...declaration, allowedValues: [] });
        if (!validation.ok) issues.push({ path: `${path}.allowedValues.${index}`, message: validation.message });
    }
    return { ok: issues.length === 0, declaration, issues };
}

export function validateParameterValue(value, declarationValue) {
    const declaration = normalizeParameterDeclaration(declarationValue);
    let validType = false;
    if (declaration.type === "float64") validType = typeof value === "number" && Number.isFinite(value);
    if (declaration.type === "int32") {
        validType = Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
    }
    if (declaration.type === "boolean") validType = typeof value === "boolean";
    if (declaration.type === "string") validType = typeof value === "string";
    if (!validType) return { ok: false, message: `Expected a ${declaration.type} value.` };
    if (typeof value === "number" && declaration.minimum !== null && value < declaration.minimum) {
        return { ok: false, message: `Value must be at least ${declaration.minimum}.` };
    }
    if (typeof value === "number" && declaration.maximum !== null && value > declaration.maximum) {
        return { ok: false, message: `Value must be at most ${declaration.maximum}.` };
    }
    if (declaration.allowedValues.length > 0
        && !declaration.allowedValues.some((allowed) => canonicalStringify(allowed) === canonicalStringify(value))) {
        return { ok: false, message: "Value is not in the parameter's allowed values." };
    }
    return { ok: true, message: null };
}

function duplicateIssues(values, path, identity = (value) => value) {
    const issues = [];
    const seen = new Set();
    for (const [index, value] of values.entries()) {
        const key = identity(value);
        if (seen.has(key)) issues.push({ path: `${path}.${index}`, message: `Duplicate value ${JSON.stringify(key)}.` });
        seen.add(key);
    }
    return issues;
}

function validateSuiteStructure(value) {
    let suite;
    try {
        suite = normalizeExperimentSuite(value);
    } catch (error) {
        return { ok: false, suite: null, issues: [{ path: "", message: error.message }] };
    }
    const issues = [];
    if (suite.scenarioIds.length === 0) issues.push({ path: "scenarioIds", message: "Select at least one scenario." });
    if (suite.manifestIds.length === 0) issues.push({ path: "manifestIds", message: "Select at least one run manifest." });
    if (suite.seeds.length === 0 || suite.seeds.some((seed) => seed === "" || seed === null)) {
        issues.push({ path: "seeds", message: "Provide at least one non-empty seed." });
    }
    issues.push(...duplicateIssues(suite.scenarioIds, "scenarioIds"));
    issues.push(...duplicateIssues(suite.manifestIds, "manifestIds"));
    issues.push(...duplicateIssues(suite.seeds, "seeds", canonicalStringify));
    issues.push(...duplicateIssues(suite.sweeps, "sweeps", (sweep) => sweep.parameterId));
    issues.push(...duplicateIssues(suite.metrics, "metrics", (metric) => metric.id));

    const selectedScenarios = new Set(suite.scenarioIds);
    const selectedManifests = new Set(suite.manifestIds);
    for (const [index, exclusion] of suite.exclusions.entries()) {
        if (!selectedScenarios.has(exclusion.scenarioId)) {
            issues.push({ path: `exclusions.${index}.scenarioId`, message: "Excluded scenario is not selected." });
        }
        if (!selectedManifests.has(exclusion.manifestId)) {
            issues.push({ path: `exclusions.${index}.manifestId`, message: "Excluded manifest is not selected." });
        }
    }
    issues.push(...duplicateIssues(
        suite.exclusions,
        "exclusions",
        (entry) => `${entry.scenarioId}\u0000${entry.manifestId}`,
    ));

    for (const [index, sweep] of suite.sweeps.entries()) {
        if (!sweep.parameterId) issues.push({ path: `sweeps.${index}.parameterId`, message: "A declared parameter id is required." });
        issues.push(...duplicateIssues(sweep.values, `sweeps.${index}.values`, canonicalStringify));
        try {
            if (expandSweepValues(sweep).length === 0) {
                issues.push({ path: `sweeps.${index}`, message: "A parameter sweep requires at least one value." });
            }
        } catch (error) {
            issues.push({ path: `sweeps.${index}`, message: error.message });
        }
    }
    for (const [index, metric] of suite.metrics.entries()) {
        issues.push(...validateMetricDefinition(metric, `metrics.${index}`).issues);
    }
    return { ok: issues.length === 0, suite, issues };
}

export function validateExperimentSuite(value, options = null) {
    const structure = validateSuiteStructure(value);
    if (!structure.ok || !options) return structure;
    const matrix = planExperimentCases(structure.suite, options, { skipStructureValidation: true });
    return {
        ok: matrix.ok,
        suite: structure.suite,
        issues: matrix.issues,
        matrix,
    };
}

export function expandSweepValues(value, { maximumValues = 10_000 } = {}) {
    const sweep = normalizeParameterSweep(value);
    if (sweep.values.length > 0) return sweep.values.map(cloneValue);
    if (!sweep.range) return [];
    const { start, stop, step } = sweep.range;
    if (![start, stop, step].every(Number.isFinite)) throw new Error("Sweep ranges require finite start, stop, and step values.");
    if (step === 0) throw new Error("Sweep range step must not be zero.");
    if ((stop > start && step < 0) || (stop < start && step > 0)) {
        throw new Error("Sweep range step must advance from start toward stop.");
    }
    const result = [];
    const epsilon = Math.abs(step) * 1e-10;
    for (let valueAtIndex = start, index = 0;
        step > 0 ? valueAtIndex <= stop + epsilon : valueAtIndex >= stop - epsilon;
        valueAtIndex = start + (++index * step)) {
        if (result.length >= maximumValues) throw new Error(`Sweep range exceeds the ${maximumValues} value limit.`);
        result.push(Number(valueAtIndex.toPrecision(15)));
    }
    return result;
}

function documentDeclarations(document) {
    const source = asObject(document);
    const candidates = [source.parameters, source.experimentParameters, source.experiment?.parameters];
    return candidates.flatMap((values) => Array.isArray(values) ? values : []);
}

function optionDeclarations(value) {
    if (value instanceof Map) return [...value.values()];
    if (Array.isArray(value)) return value;
    if (isPlainObject(value)) return Object.values(value);
    return [];
}

export function collectParameterDeclarations({ scenario = null, manifest = null, declarations = [] } = {}) {
    const values = [
        ...optionDeclarations(declarations),
        ...documentDeclarations(scenario),
        ...documentDeclarations(manifest),
    ];
    const parameters = new Map();
    const issues = [];
    for (const [index, value] of values.entries()) {
        const validation = validateParameterDeclaration(value, `parameters.${index}`);
        issues.push(...validation.issues);
        if (!validation.declaration.id) continue;
        if (parameters.has(validation.declaration.id)) {
            const previous = parameters.get(validation.declaration.id);
            if (canonicalStringify(previous) !== canonicalStringify(validation.declaration)) {
                issues.push({
                    path: `parameters.${index}.id`,
                    message: `Parameter "${validation.declaration.id}" has conflicting declarations.`,
                });
            }
            continue;
        }
        parameters.set(validation.declaration.id, validation.declaration);
    }
    return { ok: issues.length === 0, parameters, issues };
}

function exclusionKey(scenarioId, manifestId) {
    return `${scenarioId}\u0000${manifestId}`;
}

function compatibleResult(value) {
    if (value === undefined || value === true) return { ok: true, reason: "" };
    if (value === false) return { ok: false, reason: "Scenario and manifest are incompatible." };
    if (typeof value === "string") return { ok: false, reason: value };
    if (isPlainObject(value)) return { ok: value.ok !== false, reason: trimmedText(value.reason || value.message) };
    return { ok: Boolean(value), reason: "Scenario and manifest are incompatible." };
}

function parameterVectors(sweeps) {
    let vectors = [{}];
    for (const sweep of sweeps) {
        const values = expandSweepValues(sweep);
        vectors = vectors.flatMap((vector) => values.map((value) => ({
            ...vector,
            [sweep.parameterId]: cloneValue(value),
        })));
    }
    return vectors;
}

export function experimentCaseKey(value = {}) {
    const source = asObject(value);
    return canonicalStringify({
        scenarioId: trimmedText(source.scenarioId),
        manifestId: trimmedText(source.manifestId),
        seed: source.seed,
        parameters: asObject(source.parameters ?? source.parameterValues),
    });
}

export function planExperimentCases(value, options = {}, internal = {}) {
    const structure = internal.skipStructureValidation
        ? { ok: true, suite: normalizeExperimentSuite(value), issues: [] }
        : validateSuiteStructure(value);
    if (!structure.suite) return { ok: false, suite: null, cases: [], excluded: [], incompatible: [], issues: structure.issues };
    const suite = structure.suite;
    const issues = [...structure.issues];
    const cases = [];
    const excluded = [];
    const incompatible = [];
    const exclusions = new Map(suite.exclusions.map((entry) => [exclusionKey(entry.scenarioId, entry.manifestId), entry]));
    const scenarioCatalogProvided = hasCatalog(options.scenarios);
    const manifestCatalogProvided = hasCatalog(options.manifests);

    for (const scenarioId of suite.scenarioIds) {
        for (const manifestId of suite.manifestIds) {
            const cell = { scenarioId, manifestId };
            const exclusion = exclusions.get(exclusionKey(scenarioId, manifestId));
            if (exclusion) {
                excluded.push({ ...cell, reason: exclusion.reason });
                continue;
            }
            const scenario = catalogLookup(options.scenarios, scenarioId);
            const manifest = catalogLookup(options.manifests, manifestId);
            if (scenarioCatalogProvided && !scenario) {
                incompatible.push({ ...cell, reason: `Scenario "${scenarioId}" does not exist.` });
                continue;
            }
            if (manifestCatalogProvided && !manifest) {
                incompatible.push({ ...cell, reason: `Run manifest "${manifestId}" does not exist.` });
                continue;
            }
            if (typeof options.isCompatible === "function") {
                let compatibility;
                try {
                    compatibility = compatibleResult(options.isCompatible({ scenario, manifest, scenarioId, manifestId }));
                } catch (error) {
                    compatibility = { ok: false, reason: error.message };
                }
                if (!compatibility.ok) {
                    incompatible.push({ ...cell, reason: compatibility.reason || "Scenario and manifest are incompatible." });
                    continue;
                }
            }
            const declarations = collectParameterDeclarations({
                scenario,
                manifest,
                declarations: options.parameterDeclarations,
            });
            const cellProblems = declarations.issues.map((issue) => issue.message);
            const resolvedSweeps = [];
            for (const sweep of suite.sweeps) {
                const declaration = declarations.parameters.get(sweep.parameterId);
                if (!declaration) {
                    cellProblems.push(`Parameter "${sweep.parameterId}" is not declared by this scenario or run manifest.`);
                    continue;
                }
                let values = [];
                try {
                    values = expandSweepValues(sweep);
                } catch (error) {
                    cellProblems.push(error.message);
                    continue;
                }
                for (const parameterValue of values) {
                    const validation = validateParameterValue(parameterValue, declaration);
                    if (!validation.ok) {
                        cellProblems.push(`Parameter "${sweep.parameterId}": ${validation.message}`);
                    }
                }
                resolvedSweeps.push({ ...sweep, values, range: null });
            }
            if (cellProblems.length > 0) {
                incompatible.push({ ...cell, reason: [...new Set(cellProblems)].join(" ") });
                continue;
            }

            const vectors = parameterVectors(resolvedSweeps);
            for (const seed of suite.seeds) {
                for (const parameters of vectors) {
                    const identity = { scenarioId, manifestId, seed, parameters };
                    const key = experimentCaseKey(identity);
                    cases.push({
                        id: `case-${stableHash(key)}`,
                        key,
                        ordinal: cases.length,
                        ...identity,
                    });
                }
            }
        }
    }
    if (cases.length === 0 && structure.ok) {
        issues.push({ path: "matrix", message: "The suite must expand to at least one compatible case." });
    }
    return {
        ok: issues.length === 0,
        suite,
        cases,
        excluded,
        incompatible,
        issues,
    };
}

export function expandExperimentCases(value, options = {}) {
    const plan = planExperimentCases(value, options);
    if (!plan.ok) {
        throw new Error(plan.issues.map((issue) => issue.message).join(" "));
    }
    return plan.cases;
}
