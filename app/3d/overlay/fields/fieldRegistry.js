'use client';

import { createElement } from "react";
import { NumberField } from "./NumberField";
import { AssetReferenceField, ColorField, EnumField, TextField, ToggleField } from "./SimpleFields";
import { Vector3Field } from "./Vector3Field";

/** `FieldDescriptor.control` → component. Extendable by registering a control component. */
export const FIELD_COMPONENTS = new Map([
    ["number", NumberField],
    ["vector3", Vector3Field],
    ["enum", EnumField],
    ["toggle", ToggleField],
    ["text", TextField],
    ["color", ColorField],
    ["asset-reference", AssetReferenceField],
]);

export function registerFieldComponent(control, component) {
    FIELD_COMPONENTS.set(control, component);
}

export function renderField(descriptor, props) {
    const Component = FIELD_COMPONENTS.get(descriptor.control) ?? TextField;
    return createElement(Component, { key: props.id, descriptor, ...props });
}
