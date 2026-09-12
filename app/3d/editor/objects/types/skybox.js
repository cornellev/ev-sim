/**
 * The single selectable Skybox object. Its option value is the environment
 * sky configuration, which remains canonical in `manifest.sky`; the record
 * only anchors the object in the hierarchy.
 */

import {
    DEFAULT_ENVIRONMENT_SKY_CONFIG,
    SKY_MODES,
    SKY_QUALITY_PRESETS,
    normalizeSkyConfig,
    skyConfigToManifest,
} from "../../../skybox/EnvironmentSkyConfig.js";
import { ObjectOptions, field, validateFieldConstraints } from "../ObjectOptions.js";
import { SKYBOX_OBJECT_ID } from "../objectRecord.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";

export const SKYBOX_TYPE_ID = "skybox";

const SKYBOX_FIELDS = Object.freeze([
    field({ path: ["mode"], label: "Sky mode", control: "enum", options: Object.values(SKY_MODES), group: "Sky" }),
    field({ path: ["takram", "timeOfDay"], label: "Time of day", control: "number", units: "h", min: 0, max: 23.99, step: 0.1, group: "Atmosphere" }),
    field({ path: ["takram", "date"], label: "Date", control: "text", group: "Atmosphere" }),
    field({ path: ["takram", "atmosphereIntensity"], label: "Atmosphere intensity", control: "number", min: 0.2, max: 2, step: 0.05, group: "Atmosphere" }),
    field({ path: ["takram", "cloudsEnabled"], label: "Clouds", control: "toggle", group: "Clouds" }),
    field({ path: ["takram", "cloudCoverage"], label: "Cloud coverage", control: "number", min: 0, max: 1, step: 0.01, group: "Clouds" }),
    field({ path: ["takram", "cloudQuality"], label: "Cloud quality", control: "enum", options: SKY_QUALITY_PRESETS, group: "Clouds", advanced: true }),
    field({ path: ["takram", "haze"], label: "Haze", control: "toggle", group: "Atmosphere", advanced: true }),
    field({ path: ["takram", "lightShafts"], label: "Light shafts", control: "toggle", group: "Atmosphere", advanced: true }),
    field({ path: ["image", "url"], label: "Image URL", control: "text", group: "Image", advanced: true }),
    field({ path: ["image", "exposure"], label: "Image exposure", control: "number", min: 0.1, max: 3, step: 0.05, group: "Image", advanced: true }),
]);

export class SkyboxOptions extends ObjectOptions {
    getDefaults() {
        return normalizeSkyConfig(DEFAULT_ENVIRONMENT_SKY_CONFIG);
    }

    /**
     * All fields when no value is supplied; with `context.value`, only the
     * groups that apply to the current sky mode (atmosphere/clouds for
     * Takram, image for image skies) so the inspector shows what renders.
     */
    getFields(context = {}) {
        const mode = context?.value?.mode;
        if (mode !== SKY_MODES.TAKRAM && mode !== SKY_MODES.IMAGE) return SKYBOX_FIELDS;
        const hidden = mode === SKY_MODES.TAKRAM ? "image" : "takram";
        return SKYBOX_FIELDS.filter((descriptor) => descriptor.path[0] !== hidden);
    }

    normalize(value = {}) {
        return normalizeSkyConfig(value ?? {});
    }

    validate(value = {}) {
        return validateFieldConstraints(SKYBOX_FIELDS, value);
    }

    /** The sky record is `manifest.sky`, supplied through `context.sky`. */
    fromLegacy(sky, context = {}) {
        return this.normalize(sky ?? context.sky ?? {});
    }
}

export function createSkyboxType() {
    const options = new SkyboxOptions();
    return defineObjectType({
        typeId: SKYBOX_TYPE_ID,
        version: 1,
        label: "Skybox",
        catalog: { label: "Skybox", kind: "skybox", layer: "environment" },
        legacy: { domain: "sky", idField: "id" },
        options,
        singleton: SKYBOX_OBJECT_ID,
        capabilities: { selectable: true, transformable: false, deletable: false, groupable: false, hasOptions: true },
        create(input = {}) {
            return { id: SKYBOX_OBJECT_ID, name: input.name ?? "Skybox" };
        },
        /** Sky edits replace the document's `sky` scalar (persisted at `manifest.sky`). */
        planOptions(_record, value) {
            return { steps: [{ op: "set-sky", value: skyConfigToManifest(value) }], issues: [] };
        },
    });
}
