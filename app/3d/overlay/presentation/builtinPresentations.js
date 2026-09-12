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
 * Register Tabler icons for the built-in object types. Menu options and
 * inspector sections come from the default presentation (capabilities and
 * fields), so registering an icon is all a built-in needs.
 */
export function registerBuiltinPresentations(registry = editorPresentationRegistry) {
    if (registry === editorPresentationRegistry && registered) return registry;
    for (const [typeId, icon] of Object.entries(ICONS)) {
        if (!registry.has(typeId)) registry.register(typeId, { icon });
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
