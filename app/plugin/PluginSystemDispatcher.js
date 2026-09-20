import { clonePluginJson } from "./PluginJson.js";
import { PLUGIN_ERROR_CODES, assertSynchronous, pluginError } from "./PluginErrors.js";
import { comparePluginText } from "./PluginSelection.js";

export const PLUGIN_SYSTEM_METHODS = Object.freeze([
    "prepare",
    "reset",
    "onStep",
    "getDeterministicState",
    "hydrateDeterministicState",
    "finalize",
    "dispose",
]);

function fieldsFor(definition, hook) {
    return {
        pluginId: definition.pluginId,
        contributionId: definition.id,
        hook,
        requiresReset: true,
    };
}

export class PluginSystemDispatcher {
    constructor() {
        this.definitions = [];
        this.instances = [];
        this.prepared = false;
    }

    addDefinition(definition) {
        this.definitions.push(definition);
        return this;
    }

    sort() {
        this.definitions.sort((left, right) => (left.priority - right.priority)
            || comparePluginText(left.pluginId, right.pluginId)
            || comparePluginText(left.id, right.id));
        return this;
    }

    prepare(runHook) {
        if (this.prepared) throw new Error("Plugin systems are already prepared.");
        const created = [];
        try {
            for (const definition of this.definitions) {
                const instance = definition.create();
                assertSynchronous(instance, "create", fieldsFor(definition, "create"));
                if (!instance || typeof instance !== "object") {
                    throw pluginError(
                        PLUGIN_ERROR_CODES.REGISTRATION,
                        `Plugin system "${definition.id}" create() must return an instance.`,
                        fieldsFor(definition, "create"),
                    );
                }
                for (const name of PLUGIN_SYSTEM_METHODS) {
                    if (typeof instance[name] !== "function") {
                        throw pluginError(
                            PLUGIN_ERROR_CODES.REGISTRATION,
                            `Plugin system "${definition.id}" is missing ${name}().`,
                            fieldsFor(definition, name),
                        );
                    }
                }
                const record = { ...definition, instance };
                this.instances.push(record);
                created.push(record);
                runHook(record, "prepare");
            }
            this.prepared = true;
        } catch (error) {
            for (const record of [...created].reverse()) {
                try {
                    assertSynchronous(record.instance.dispose(), "dispose", fieldsFor(record, "dispose"));
                } catch {
                    // Preserve the original prepare failure.
                }
            }
            this.instances = [];
            this.prepared = false;
            throw error;
        }
        return this;
    }

    reset(runHook) {
        if (!this.prepared) return this;
        for (const record of this.instances) runHook(record, "reset");
        return this;
    }

    onStep(runHook) {
        if (!this.prepared) return this;
        for (const record of this.instances) runHook(record, "onStep");
        return this;
    }

    finalize(runHook) {
        if (!this.prepared) return this;
        for (const record of this.instances) runHook(record, "finalize");
        return this;
    }

    dispose() {
        for (const record of [...this.instances].reverse()) {
            try {
                assertSynchronous(record.instance.dispose(), "dispose", fieldsFor(record, "dispose"));
            } catch {
                // Disposal must continue in reverse preparation order.
            }
        }
        this.instances = [];
        this.prepared = false;
        return this;
    }

    getDeterministicState() {
        return this.instances.map((record) => ({
            pluginId: record.pluginId,
            systemId: record.id,
            stateVersion: record.stateVersion,
            state: clonePluginJson(
                assertSynchronous(
                    record.instance.getDeterministicState(),
                    "getDeterministicState",
                    fieldsFor(record, "getDeterministicState"),
                ) ?? {},
                `${record.id}.state`,
            ),
        }));
    }

    hydrateDeterministicState(snapshot = []) {
        const byKey = new Map((snapshot ?? []).map((entry) => [
            `${entry.pluginId}\0${entry.systemId}`,
            entry,
        ]));
        for (const record of this.instances) {
            const entry = byKey.get(`${record.pluginId}\0${record.id}`);
            const version = entry?.stateVersion ?? record.stateVersion;
            if (version !== record.stateVersion) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.STATE_INVALID,
                    `Plugin system "${record.id}" stateVersion mismatch.`,
                    fieldsFor(record, "hydrateDeterministicState"),
                );
            }
            assertSynchronous(
                record.instance.hydrateDeterministicState(entry?.state ?? {}),
                "hydrateDeterministicState",
                fieldsFor(record, "hydrateDeterministicState"),
            );
        }
        return this;
    }
}
