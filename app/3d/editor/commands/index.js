/**
 * Editor command layer: CommandBus, command factories, planning, and the
 * headless service used by MCP and tests. Imports Three math through the
 * document layer only; never React, DOM, scene adapters, or the registry.
 */

export * from "./commandIssues.js";
export * from "./CommandBus.js";
export * from "./transformPlanning.js";
export * from "./planApply.js";
export * from "./gestureCapture.js";
export * from "./liveOverlay.js";
export * from "./objectMutations.js";
export * from "./EnvironmentCommandService.js";
export * as objectCommands from "./objectCommands.js";
export * as legacyCommands from "./legacyCommands.js";
export { commandFactories } from "./EnvironmentCommandService.js";
