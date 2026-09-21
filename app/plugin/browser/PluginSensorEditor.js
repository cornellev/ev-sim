import { createElement } from "react";

import { PluginViewBoundary } from "./PluginUiHost.js";
import PluginSensorSettingsForm from "./PluginSensorSettingsForm.js";
import { commitPluginSensorAuthoringPatch } from "../PluginSensorAuthoring.js";
import { sensorTypeRegistry } from "../../simulation/sensors/SensorTypeRegistry.js";

function freezeValue(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    if (Array.isArray(value)) {
        const clone = value.map(freezeValue);
        return Object.freeze(clone);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeValue(entry)])));
}

export default function PluginSensorEditor({
    context,
    sensor,
    definition,
    diagnostic = null,
    Component = null,
    onCommit,
    disabled = false,
    sensorRegistry = sensorTypeRegistry,
}) {
    const descriptor = definition?.pluginSensor?.descriptor ?? null;
    const diagnostics = [diagnostic].filter(Boolean);
    const onChange = (patch) => {
        const next = commitPluginSensorAuthoringPatch(sensor, definition, patch, {
            context: context.kind,
            sensorRegistry,
        });
        onCommit(next);
    };
    const fields = context.kind === "vehicle" ? definition?.vehicle?.fields ?? [] : definition?.run?.fields ?? [];
    const props = Object.freeze({
        ...freezeValue({
            context,
            sensor,
            descriptor,
            fields,
            diagnostics,
        }),
        onChange,
    });

    const fallback = createElement(PluginSensorSettingsForm, {
        ...props,
        onChange,
        disabled,
    });
    if (!Component) return fallback;
    return createElement(
        PluginViewBoundary,
        { fallback },
        createElement(Component, { ...props, onChange }),
    );
}
