import { z } from "zod";
import {
    createBinding,
    createBindingManifest,
    normalizeBinding,
    normalizeBindingManifest,
    suggestTriggerFromArtifact,
    validateBinding,
} from "../../app/scripting/bindings/BindingDocument.js";
import { storageEvents } from "./events.js";
import { fail, ok } from "./toolResult.js";

const BINDINGS_SETTING_KEY = "bindings:manifest";

const TriggerSchema = z.object({
    kind: z.enum(["topic", "fixed-update", "signal-update", "timer"]),
    topic: z.string().optional(),
    everyN: z.number().int().positive().optional(),
    path: z.string().optional(),
    intervalMs: z.number().positive().optional(),
});

const InputMappingSchema = z.object({
    input: z.string().min(1),
    source: z.enum(["signal", "message", "constant", "sim"]),
    path: z.string().optional(),
    field: z.string().optional(),
    value: z.any().optional(),
    key: z.enum(["dt", "time", "step"]).optional(),
});

const OutputMappingSchema = z.object({
    output: z.string().min(1),
    sink: z.enum(["signal", "publish"]),
    path: z.string().optional(),
    topic: z.string().optional(),
    type: z.string().optional(),
});

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("../storage/StorageService.js").StorageService} storage
 */
export function registerBindingTools(server, storage) {
    server.registerTool(
        "binding_list",
        {
            title: "List bindings",
            description: "List the bindings manifest (master enabled flag + all bindings).",
            inputSchema: {},
        },
        async () => {
            try {
                const manifest = await getManifest(storage);
                return ok({
                    ok: true,
                    enabled: manifest.enabled,
                    updatedAt: manifest.updatedAt,
                    bindings: manifest.bindings.map(summarizeBinding),
                });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "binding_get",
        {
            title: "Get binding",
            description: "Get one binding by id with full trigger/input/output detail.",
            inputSchema: {
                bindingId: z.string().min(1),
            },
        },
        async ({ bindingId }) => {
            try {
                const manifest = await getManifest(storage);
                const binding = manifest.bindings.find((entry) => entry.id === bindingId);
                if (!binding) return fail(`Binding "${bindingId}" not found.`);
                return ok({ ok: true, binding, issues: validateBinding(binding) });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "binding_create",
        {
            title: "Create binding",
            description:
                "Create a binding that wires a compiled script to a trigger (topic / fixed-update / signal-update / timer) with input/output mappings.",
            inputSchema: {
                name: z.string().optional(),
                scriptId: z.string().min(1),
                enabled: z.boolean().optional(),
                trigger: TriggerSchema,
                inputs: z.array(InputMappingSchema).optional(),
                outputs: z.array(OutputMappingSchema).optional(),
            },
        },
        async ({ name, scriptId, enabled, trigger, inputs, outputs }) => {
            try {
                const interfaceCheck = await checkScriptInterface(storage, scriptId, inputs, outputs);
                if (!interfaceCheck.ok) return fail(interfaceCheck.error, interfaceCheck);

                const binding = createBinding({
                    name: name || "Untitled binding",
                    scriptId,
                    enabled: enabled !== false,
                    trigger,
                    inputs: inputs ?? [],
                    outputs: outputs ?? [],
                });
                const issues = validateBinding(binding);
                if (issues.length > 0) {
                    return fail(issues.join(" "), { issues, binding });
                }

                const manifest = await getManifest(storage);
                manifest.bindings.push(binding);
                await putManifest(storage, manifest);
                storageEvents.publish({ domain: "bindings", id: binding.id, action: "created" });
                return ok({ ok: true, binding, issues: [] });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "binding_update",
        {
            title: "Update binding",
            description: "Update fields on an existing binding (name, script, trigger, inputs, outputs, enabled).",
            inputSchema: {
                bindingId: z.string().min(1),
                name: z.string().optional(),
                scriptId: z.string().optional(),
                enabled: z.boolean().optional(),
                trigger: TriggerSchema.optional(),
                inputs: z.array(InputMappingSchema).optional(),
                outputs: z.array(OutputMappingSchema).optional(),
            },
        },
        async (args) => {
            try {
                const manifest = await getManifest(storage);
                const index = manifest.bindings.findIndex((entry) => entry.id === args.bindingId);
                if (index === -1) return fail(`Binding "${args.bindingId}" not found.`);

                const current = manifest.bindings[index];
                const next = normalizeBinding({
                    ...current,
                    name: args.name ?? current.name,
                    scriptId: args.scriptId ?? current.scriptId,
                    enabled: args.enabled ?? current.enabled,
                    trigger: args.trigger ?? current.trigger,
                    inputs: args.inputs ?? current.inputs,
                    outputs: args.outputs ?? current.outputs,
                });

                const interfaceCheck = await checkScriptInterface(
                    storage,
                    next.scriptId,
                    next.inputs,
                    next.outputs,
                );
                if (!interfaceCheck.ok) return fail(interfaceCheck.error, interfaceCheck);

                const issues = validateBinding(next);
                if (issues.length > 0) {
                    return fail(issues.join(" "), { issues, binding: next });
                }

                manifest.bindings[index] = next;
                await putManifest(storage, manifest);
                storageEvents.publish({ domain: "bindings", id: next.id, action: "updated" });
                return ok({ ok: true, binding: next });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "binding_delete",
        {
            title: "Delete binding",
            description: "Delete a binding by id.",
            inputSchema: {
                bindingId: z.string().min(1),
            },
        },
        async ({ bindingId }) => {
            try {
                const manifest = await getManifest(storage);
                const before = manifest.bindings.length;
                manifest.bindings = manifest.bindings.filter((entry) => entry.id !== bindingId);
                if (manifest.bindings.length === before) {
                    return fail(`Binding "${bindingId}" not found.`);
                }
                await putManifest(storage, manifest);
                storageEvents.publish({ domain: "bindings", id: bindingId, action: "deleted" });
                return ok({ ok: true, deleted: bindingId });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "binding_set_enabled",
        {
            title: "Enable/disable bindings",
            description: "Toggle a single binding or the master bindings switch.",
            inputSchema: {
                enabled: z.boolean(),
                bindingId: z.string().optional().describe("Omit to toggle the master enabled flag"),
            },
        },
        async ({ enabled, bindingId }) => {
            try {
                const manifest = await getManifest(storage);
                if (bindingId) {
                    const binding = manifest.bindings.find((entry) => entry.id === bindingId);
                    if (!binding) return fail(`Binding "${bindingId}" not found.`);
                    binding.enabled = enabled;
                    await putManifest(storage, manifest);
                    storageEvents.publish({ domain: "bindings", id: bindingId, action: "enabled" });
                    return ok({ ok: true, bindingId, enabled });
                }
                manifest.enabled = enabled;
                await putManifest(storage, manifest);
                storageEvents.publish({ domain: "bindings", id: null, action: "master-enabled" });
                return ok({ ok: true, masterEnabled: enabled });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "binding_suggest",
        {
            title: "Suggest binding",
            description:
                "Given a compiled script, suggest a trigger and skeleton input/output mappings from the artifact interface.",
            inputSchema: {
                scriptId: z.string().min(1),
            },
        },
        async ({ scriptId }) => {
            try {
                const script = await storage.getScript(scriptId);
                if (!script) return fail(`Script "${scriptId}" not found.`);
                const artifact = script.latestValidArtifact;
                if (!artifact) {
                    return fail(
                        `Script "${scriptId}" has no compiled artifact. Run script_lint first.`,
                        { compileStatus: script.compileStatus },
                    );
                }

                const trigger = suggestTriggerFromArtifact({
                    entrypoints: artifact.entrypoints,
                    bindings: artifact.bindings,
                }) || { kind: "fixed-update", everyN: 1 };

                const inputs = (artifact.interface?.inputs ?? []).map((port) => ({
                    input: port.label || port.name,
                    source: "constant",
                    value: null,
                }));
                const outputs = (artifact.interface?.outputs ?? []).map((port) => ({
                    output: port.label || port.name,
                    sink: "signal",
                    path: `debug.${port.label || port.name}`,
                }));

                return ok({
                    ok: true,
                    suggestion: {
                        name: `${script.name} binding`,
                        scriptId,
                        trigger,
                        inputs,
                        outputs,
                    },
                    interface: artifact.interface,
                });
            } catch (error) {
                return fail(error);
            }
        },
    );
}

async function getManifest(storage) {
    const stored = await storage.getSetting(BINDINGS_SETTING_KEY);
    if (!stored) return createBindingManifest();
    return normalizeBindingManifest(stored);
}

async function putManifest(storage, manifest) {
    const normalized = normalizeBindingManifest({
        ...manifest,
        updatedAt: new Date().toISOString(),
    });
    await storage.putSetting(BINDINGS_SETTING_KEY, normalized);
    return normalized;
}

async function checkScriptInterface(storage, scriptId, inputs = [], outputs = []) {
    if (!scriptId) {
        return { ok: false, error: "scriptId is required." };
    }
    const script = await storage.getScript(scriptId);
    if (!script) {
        return { ok: false, error: `Script "${scriptId}" not found.` };
    }
    const artifact = script.latestValidArtifact;
    if (!artifact) {
        return {
            ok: false,
            error: `Script "${scriptId}" has no compiled artifact. Run script_lint first.`,
            compileStatus: script.compileStatus,
        };
    }

    const inputLabels = new Set(
        (artifact.interface?.inputs ?? []).map((port) => port.label || port.name),
    );
    const outputLabels = new Set(
        (artifact.interface?.outputs ?? []).map((port) => port.label || port.name),
    );

    const missingInputs = (inputs || [])
        .map((mapping) => mapping.input)
        .filter((label) => label && !inputLabels.has(label));
    const missingOutputs = (outputs || [])
        .map((mapping) => mapping.output)
        .filter((label) => label && !outputLabels.has(label));

    if (missingInputs.length || missingOutputs.length) {
        return {
            ok: false,
            error: [
                missingInputs.length
                    ? `Unknown input label(s): ${missingInputs.join(", ")}. Available: ${[...inputLabels].join(", ") || "(none)"}`
                    : null,
                missingOutputs.length
                    ? `Unknown output label(s): ${missingOutputs.join(", ")}. Available: ${[...outputLabels].join(", ") || "(none)"}`
                    : null,
            ].filter(Boolean).join(" "),
            availableInputs: [...inputLabels],
            availableOutputs: [...outputLabels],
        };
    }

    return { ok: true, interface: artifact.interface };
}

function summarizeBinding(binding) {
    return {
        id: binding.id,
        name: binding.name,
        enabled: binding.enabled,
        scriptId: binding.scriptId,
        trigger: binding.trigger,
        inputCount: binding.inputs?.length ?? 0,
        outputCount: binding.outputs?.length ?? 0,
    };
}

export { getManifest, putManifest, checkScriptInterface };
