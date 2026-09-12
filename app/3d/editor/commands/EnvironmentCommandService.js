/**
 * Headless command service: a CommandBus over a document plus the command
 * factories by name. MCP tools and tests use it without a scene, registry,
 * or projector. The browser editor uses the same bus with a SelectionStore
 * and SceneProjector attached.
 */

import { objectTypeRegistry } from "../objects/ObjectTypeRegistry.js";
import { CommandBus } from "./CommandBus.js";
import * as objectCommands from "./objectCommands.js";
import * as legacyCommands from "./legacyCommands.js";

export const commandFactories = Object.freeze({
    ...legacyCommands,
    ...objectCommands,
});

/**
 * @param {{ document: import("../document/EnvironmentDocument.js").EnvironmentDocument,
 *   sky?: object|null|(() => object|null),
 *   registry?: import("../objects/ObjectTypeRegistry.js").ObjectTypeRegistry,
 *   selection?: object|null, historyLimit?: number }} options
 */
export function createEnvironmentCommandService({ document, sky = null, registry = objectTypeRegistry, selection = null, historyLimit } = {}) {
    const bus = new CommandBus({ document, registry, sky, selection, historyLimit });
    return {
        document,
        bus,
        registry,
        selection,
        commands: commandFactories,
        /** Execute a named command with its factory arguments. */
        run(name, args = {}, options = {}) {
            const factory = commandFactories[name];
            if (typeof factory !== "function") throw new TypeError(`Unknown command "${name}".`);
            return bus.execute(factory(args), options);
        },
        /** Run several named commands as one history entry. */
        transaction(label, fn, options = {}) {
            return bus.transaction(label, (run, context) => fn((name, args = {}) => {
                const factory = commandFactories[name];
                if (typeof factory !== "function") throw new TypeError(`Unknown command "${name}".`);
                return run(factory(args));
            }, context), options);
        },
    };
}
