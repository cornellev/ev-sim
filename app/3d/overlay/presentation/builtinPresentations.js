'use client';

import { createElement } from "react";
import {
    IconBuilding,
    IconCube,
    IconFolder,
    IconMap,
    IconRoad,
    IconSun,
    IconTrafficCone,
    IconTrafficLights,
    IconQuestionMark,
} from "@tabler/icons-react";
import { editorPresentationRegistry } from "../../editor/presentation/EditorPresentationRegistry.js";
import { BUILTIN_SECTION_PROVIDERS } from "../../editor/presentation/builtinSections.js";

const ICONS = Object.freeze({
    group: IconFolder,
    skybox: IconSun,
    tile: IconMap,
    road: IconRoad,
    intersection: IconTrafficLights,
    building: IconBuilding,
    "builtin-prop": IconTrafficCone,
    "asset-instance": IconCube,
});

export const UNSUPPORTED_ICON = IconQuestionMark;

let registered = false;

/**
 * Register Tabler icons for the built-in object types, plus the extra
 * inspector sections some of them carry (turn rules, road endpoints, sky
 * runtime). Menu options and generic fields come from the default
 * presentation (capabilities and fields).
 */
export function registerBuiltinPresentations(registry = editorPresentationRegistry) {
    if (registry === editorPresentationRegistry && registered) return registry;
    for (const [typeId, icon] of Object.entries(ICONS)) {
        if (registry.has(typeId)) continue;
        const getInspectorSections = BUILTIN_SECTION_PROVIDERS[typeId];
        registry.register(typeId, getInspectorSections ? { icon, getInspectorSections } : { icon });
    }
    if (registry === editorPresentationRegistry) registered = true;
    return registry;
}

export function iconForPresentation(presentation) {
    return presentation?.icon ?? UNSUPPORTED_ICON;
}

/** Render a presentation's icon without creating a component type during render. */
export function PresentationIcon({ presentation, className, ...rest }) {
    return createElement(iconForPresentation(presentation), { className, "aria-hidden": true, ...rest });
}
