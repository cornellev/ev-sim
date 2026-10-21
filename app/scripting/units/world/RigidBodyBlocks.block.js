import { BlockOutput } from "../../ScriptManager.js";
import { UNIT, UNIT_TYPE, VEC3_TYPE } from "../../types/PortTypes.js";
import { defaultRigidBody, normalizeRigidBody, rigidBodyFieldIssues } from "../../../simulation/world/RigidBodyRecords.js";
import { freezePorts, defineBlock } from "../defineBlock.js";
import { RIGID_BODY_CONFIG_TYPE, SCENE_OBJECT_TYPE } from "../program/ProgramTypes.js";

export const GET_RIGID_BODY_HOST_ERROR = "Get Rigid Body requires an editor script host.";
export const ADD_RIGID_BODY_HOST_ERROR = "Add Rigid Body requires an editor script host.";

const MAKE_FIELDS = Object.freeze([
    { label: "bodyType", type: "string" },
    { label: "mass", type: "float64" },
    { label: "useGravity", type: "boolean" },
    { label: "linearDamping", type: "float64" },
    { label: "angularDamping", type: "float64" },
    { label: "force", type: VEC3_TYPE },
]);

export const MAKE_RIGID_BODY_PORTS = freezePorts(
    MAKE_FIELDS,
    [{ label: "config", type: RIGID_BODY_CONFIG_TYPE }],
);
export const SPLIT_RIGID_BODY_PORTS = freezePorts(
    [{ label: "config", type: RIGID_BODY_CONFIG_TYPE }],
    MAKE_FIELDS,
);
export const GET_RIGID_BODY_PORTS = freezePorts(
    [{ label: "object", type: SCENE_OBJECT_TYPE }],
    [
        { label: "config", type: RIGID_BODY_CONFIG_TYPE },
        { label: "found", type: "boolean" },
    ],
);
export const ADD_RIGID_BODY_PORTS = freezePorts(
    [
        { label: "object", type: SCENE_OBJECT_TYPE },
        { label: "config", type: RIGID_BODY_CONFIG_TYPE },
    ],
    [
        { label: "then", type: UNIT_TYPE },
        { label: "ok", type: "boolean" },
    ],
);

function runtimeContext(unit) {
    return unit.manager?.getRuntimeContext?.() ?? {};
}

function readField(unit, label) {
    return unit.hasInput(label) ? unit.getInput(label) : undefined;
}

function bodyFromInputs(unit) {
    return normalizeRigidBody({
        bodyType: readField(unit, "bodyType"),
        mass: readField(unit, "mass"),
        useGravity: readField(unit, "useGravity"),
        linearDamping: readField(unit, "linearDamping"),
        angularDamping: readField(unit, "angularDamping"),
        constantForce: readField(unit, "force"),
    });
}

function checkedBody(value) {
    const config = normalizeRigidBody(value);
    const issue = rigidBodyFieldIssues(config)[0];
    if (issue) throw new TypeError(issue);
    return config;
}

export const MakeRigidBodyBlock = defineBlock({
    type: "MakeRigidBodyBlock",
    ports: MAKE_RIGID_BODY_PORTS,
    valid() {
        return true;
    },
    execute() {
        const config = checkedBody(bodyFromInputs(this));
        return new BlockOutput().set("config", config);
    },
});

export const SplitRigidBodyBlock = defineBlock({
    type: "SplitRigidBodyBlock",
    ports: SPLIT_RIGID_BODY_PORTS,
    execute() {
        const config = checkedBody(this.getInput("config"));
        const force = config.constantForce;
        return new BlockOutput()
            .set("bodyType", config.bodyType)
            .set("mass", config.mass)
            .set("useGravity", config.useGravity)
            .set("linearDamping", config.linearDamping)
            .set("angularDamping", config.angularDamping)
            .set("force", { x: force.x, y: force.y, z: force.z });
    },
});

export const GetRigidBodyBlock = defineBlock({
    type: "GetRigidBodyBlock",
    ports: GET_RIGID_BODY_PORTS,
    execute() {
        const read = runtimeContext(this).readRigidBody;
        if (typeof read !== "function") throw new Error(GET_RIGID_BODY_HOST_ERROR);
        const body = read(this.getInput("object"));
        if (!body) return new BlockOutput().set("config", defaultRigidBody()).set("found", false);
        return new BlockOutput().set("config", normalizeRigidBody(body)).set("found", true);
    },
});

export const AddRigidBodyBlock = defineBlock({
    type: "AddRigidBodyBlock",
    ports: ADD_RIGID_BODY_PORTS,
    execute() {
        const context = runtimeContext(this);
        if (typeof context.author !== "function" || typeof context.findSceneObject !== "function") {
            throw new Error(ADD_RIGID_BODY_HOST_ERROR);
        }
        const objectId = String(this.getInput("object") ?? "").trim();
        if (!objectId || context.findSceneObject(objectId) !== objectId) {
            throw new TypeError(`Object "${objectId}" does not exist.`);
        }
        const config = checkedBody(this.getInput("config"));
        context.author({ op: "put-rigid-body", objectId, rigidBody: config });
        return new BlockOutput().set("then", UNIT).set("ok", true);
    },
});
