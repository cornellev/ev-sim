import { BlockOutput } from "../../ScriptManager.js";
import { normalizePose3d } from "../../types/PortTypes.js";
import { BUILTIN_PROP_IDS } from "../../../3d/editor/objects/types/builtinProp.js";
import { freezePorts, defineBlock } from "../defineBlock.js";
import { UNIT, UNIT_TYPE } from "../../types/PortTypes.js";

export const AUTHORING_BLOCK_TYPES = Object.freeze(["PlaceFeatureBlock", "CreateGroupBlock", "CloneObjectBlock"]);
export const PLACE_FEATURE_HOST_ERROR = "Place Feature requires an editor script host.";
export const CREATE_GROUP_HOST_ERROR = "Create Group requires an editor script host.";
export const CLONE_OBJECT_HOST_ERROR = "Clone Object requires an editor script host.";

function runtimeContext(unit) {
    return unit.manager?.getRuntimeContext?.() ?? {};
}

function authorHost(unit, message) {
    const author = runtimeContext(unit).author;
    if (typeof author !== "function") throw new Error(message);
    return author;
}

function parentIdOf(value) {
    const text = String(value ?? "").trim();
    return text || null;
}

const PLACE_FEATURE_PORTS = freezePorts(
    [
        { label: "assetId", type: "string" },
        { label: "pose", type: "pose3d" },
        { label: "parentId", type: "scene_object" },
    ],
    [
        { label: "then", type: UNIT_TYPE },
        { label: "id", type: "string" },
        { label: "ok", type: "boolean" },
    ],
);

const CLONE_OBJECT_PORTS = freezePorts(
    [
        { label: "sourceId", type: "scene_object" },
        { label: "pose", type: "pose3d" },
        { label: "parentId", type: "scene_object" },
    ],
    [
        { label: "then", type: UNIT_TYPE },
        { label: "id", type: "string" },
        { label: "ok", type: "boolean" },
    ],
);

const CREATE_GROUP_PORTS = freezePorts(
    [
        { label: "name", type: "string" },
        { label: "parentId", type: "scene_object" },
    ],
    [
        { label: "then", type: UNIT_TYPE },
        { label: "id", type: "scene_object" },
    ],
);

export const PlaceFeatureBlock = defineBlock({
    type: "PlaceFeatureBlock",
    ports: PLACE_FEATURE_PORTS,
    valid() {
        return this.hasInput("assetId") && this.hasInput("pose") && this.hasInput("parentId");
    },
    execute() {
        const author = authorHost(this, PLACE_FEATURE_HOST_ERROR);
        const assetId = String(this.getInput("assetId") ?? "").trim();
        if (!BUILTIN_PROP_IDS.includes(assetId)) throw new TypeError(`Unknown feature type "${assetId}".`);
        const pose = normalizePose3d(this.getInput("pose"));
        const id = author({
            op: "add-feature",
            type: assetId,
            x: pose.position.x,
            z: pose.position.z,
            rotationY: pose.rotation.y,
            parentId: parentIdOf(this.getInput("parentId")),
        });
        return new BlockOutput().set("then", UNIT).set("id", String(id ?? "")).set("ok", true);
    },
});

export const CloneObjectBlock = defineBlock({
    type: "CloneObjectBlock",
    ports: CLONE_OBJECT_PORTS,
    valid() {
        return this.hasInput("sourceId") && this.hasInput("pose") && this.hasInput("parentId");
    },
    execute() {
        const context = runtimeContext(this);
        const author = authorHost(this, CLONE_OBJECT_HOST_ERROR);
        if (typeof context.lookupObject !== "function") throw new Error(CLONE_OBJECT_HOST_ERROR);
        const sourceId = String(this.getInput("sourceId") ?? "").trim();
        const spec = context.lookupObject(sourceId);
        if (!spec) {
            throw new TypeError(`Cannot clone "${sourceId || "object"}". Choose a prop or an asset instance.`);
        }
        const pose = normalizePose3d(this.getInput("pose"));
        const id = author({
            op: "clone-object",
            spec,
            x: pose.position.x,
            y: pose.position.y,
            z: pose.position.z,
            rotationY: pose.rotation.y,
            parentId: parentIdOf(this.getInput("parentId")),
        });
        return new BlockOutput().set("then", UNIT).set("id", String(id ?? "")).set("ok", true);
    },
});

export const CreateGroupBlock = defineBlock({
    type: "CreateGroupBlock",
    ports: CREATE_GROUP_PORTS,
    valid() {
        return this.hasInput("name") && this.hasInput("parentId");
    },
    execute() {
        const author = authorHost(this, CREATE_GROUP_HOST_ERROR);
        const id = author({
            op: "create-group",
            name: String(this.getInput("name") ?? "").trim() || "Group",
            parentId: parentIdOf(this.getInput("parentId")),
        });
        return new BlockOutput().set("then", UNIT).set("id", String(id ?? ""));
    },
});

export const AUTHORING_BINDING_WARNING = "This script places permanent objects and must be run from an object attachment, not a simulation binding.";

export function artifactHasAuthoringBlocks(artifact) {
    for (const node of artifact?.nodes ?? []) {
        if (AUTHORING_BLOCK_TYPES.includes(node?.type)) return true;
        if (artifactHasAuthoringBlocks(node?.state?.compiledProgram)) return true;
    }
    return false;
}

export function authoringBindingWarnings(artifact) {
    return artifactHasAuthoringBlocks(artifact) ? [AUTHORING_BINDING_WARNING] : [];
}
