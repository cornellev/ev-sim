/**
 * URDF robot graph.
 * One rooted acyclic link tree. Wheel and steering roles use the rest pose.
 */

import { parseUrdfXml, textUsesXacro, urdfXmlIssues } from "./parseUrdfXml.js";
import {
    URDF_LINK_DEPTH_MAX,
    axisParallel,
    composeMatrix,
    matrixToPose,
    originMatrix,
    rotateAxis,
} from "./rosCevBasis.js";
import { urdfIssue } from "./issue.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const OMITTED_ROBOT_ELEMENTS = new Set(["gazebo", "transmission", "ros2_control"]);

function localName(node) {
    return String(node?.nodeName ?? "").toLowerCase().replace(/^.*:/u, "");
}

function childElements(node) {
    const result = [];
    const children = node?.childNodes ?? [];
    for (let index = 0; index < children.length; index += 1) {
        if (children[index].nodeType === 1) result.push(children[index]);
    }
    return result;
}

function childrenNamed(node, name) {
    return childElements(node).filter((child) => localName(child) === name);
}

function firstNamed(node, name) {
    return childrenNamed(node, name)[0] ?? null;
}

function finiteToken(token, label, path, issues) {
    if (token == null || token === "") return 0;
    const value = Number(token);
    if (!Number.isFinite(value)) {
        issues.push(urdfIssue("vehicle.urdf.parse", path, `${label} ${JSON.stringify(token)} is not a finite number.`));
        return 0;
    }
    return Object.is(value, -0) ? 0 : value;
}

function tuple(text, size, label, path, issues) {
    if (text == null || String(text).trim() === "") return new Array(size).fill(0);
    const parts = String(text).trim().split(/\s+/u);
    if (parts.length !== size) {
        issues.push(urdfIssue("vehicle.urdf.parse", path, `${label} must contain ${size} numbers.`));
        return new Array(size).fill(0);
    }
    return parts.map((part) => finiteToken(part, label, path, issues));
}

function readOrigin(element, path, issues) {
    const origin = firstNamed(element, "origin");
    if (!origin) return { xyz: [0, 0, 0], rpy: [0, 0, 0] };
    return {
        xyz: tuple(origin.getAttribute("xyz"), 3, "origin xyz", `${path}/origin`, issues),
        rpy: tuple(origin.getAttribute("rpy"), 3, "origin rpy", `${path}/origin`, issues),
    };
}

function readGeometry(element, path, issues) {
    const geometry = firstNamed(element, "geometry");
    const shape = geometry ? childElements(geometry)[0] : null;
    if (!shape) {
        issues.push(urdfIssue("vehicle.urdf.parse", path, "Geometry is missing."));
        return null;
    }
    const kind = localName(shape);
    if (kind === "box") {
        return { kind, size: tuple(shape.getAttribute("size"), 3, "box size", `${path}/box`, issues) };
    }
    if (kind === "cylinder") {
        return {
            kind,
            radius: finiteToken(shape.getAttribute("radius"), "cylinder radius", `${path}/cylinder`, issues),
            length: finiteToken(shape.getAttribute("length"), "cylinder length", `${path}/cylinder`, issues),
        };
    }
    if (kind === "sphere") {
        return {
            kind,
            radius: finiteToken(shape.getAttribute("radius"), "sphere radius", `${path}/sphere`, issues),
        };
    }
    if (kind === "mesh") {
        const scaleText = shape.getAttribute("scale");
        const filename = shape.getAttribute("filename") ?? "";
        if (filename.toLowerCase().endsWith(".dae")) {
            issues.push(urdfIssue("vehicle.urdf.unsupported-mesh", `${path}/mesh`, `COLLADA mesh ${JSON.stringify(filename)} is outside this adapter.`));
        }
        return {
            kind,
            filename,
            scale: scaleText ? tuple(scaleText, 3, "mesh scale", `${path}/mesh`, issues) : [1, 1, 1],
        };
    }
    issues.push(urdfIssue("vehicle.urdf.unsupported-mesh", path, `Geometry "${kind}" is not supported.`));
    return { kind: "unknown" };
}

function readVisualOrCollision(element, path, issues) {
    return {
        name: element.getAttribute("name") ?? "",
        origin: readOrigin(element, path, issues),
        geometry: readGeometry(element, path, issues),
    };
}

function readLimit(element, path, issues) {
    const limit = firstNamed(element, "limit");
    if (!limit) return null;
    const lower = limit.getAttribute("lower");
    const upper = limit.getAttribute("upper");
    return {
        lower: lower == null || lower === "" ? null : finiteToken(lower, "limit lower", `${path}/limit`, issues),
        upper: upper == null || upper === "" ? null : finiteToken(upper, "limit upper", `${path}/limit`, issues),
        effort: finiteToken(limit.getAttribute("effort"), "limit effort", `${path}/limit`, issues),
        velocity: finiteToken(limit.getAttribute("velocity"), "limit velocity", `${path}/limit`, issues),
    };
}

function readMimic(element) {
    const mimic = firstNamed(element, "mimic");
    if (!mimic) return null;
    return {
        joint: mimic.getAttribute("joint") ?? "",
        multiplier: Number(mimic.getAttribute("multiplier") || 1),
        offset: Number(mimic.getAttribute("offset") || 0),
    };
}

function emptyRobot(name) {
    return {
        name,
        root: null,
        links: {},
        joints: {},
        children: {},
        frames: {},
        classification: { wheels: [], steering: [], issues: [] },
    };
}

function classifyJoints(robot, issues) {
    const parentJoint = new Map();
    for (const joint of Object.values(robot.joints)) {
        if (!robot.links[joint.parent] || !robot.links[joint.child]) {
            issues.push(urdfIssue("vehicle.urdf.dangling-link", `robot/joint[${joint.name}]`, `Joint "${joint.name}" references a missing link.`));
            continue;
        }
        if (parentJoint.has(joint.child)) {
            issues.push(urdfIssue("vehicle.urdf.multiple-parents", `robot/joint[${joint.name}]`, `Link "${joint.child}" has more than one parent.`));
            continue;
        }
        parentJoint.set(joint.child, joint);
    }
    const roots = Object.keys(robot.links).filter((name) => !parentJoint.has(name)).sort();
    if (roots.length !== 1) {
        issues.push(urdfIssue("vehicle.urdf.multiple-roots", "robot", roots.length === 0
            ? "The robot has no root link."
            : `The robot has ${roots.length} root links.`));
    }
    robot.root = roots.length === 1 ? roots[0] : null;
    for (const name of Object.keys(robot.links)) {
        if (!linkInCycle(parentJoint, name)) continue;
        issues.push(urdfIssue("vehicle.urdf.cycle", `robot/link[${name}]`, `Link "${name}" is part of a cycle.`));
    }
    const stack = new Set();
    const visit = (link, matrix, depth) => {
        if (stack.has(link)) {
            issues.push(urdfIssue("vehicle.urdf.cycle", `robot/link[${link}]`, `Link "${link}" is part of a cycle.`));
            return;
        }
        if (depth > URDF_LINK_DEPTH_MAX) {
            issues.push(urdfIssue("vehicle.urdf.depth", `robot/link[${link}]`, `Link depth exceeds ${URDF_LINK_DEPTH_MAX}.`));
            return;
        }
        robot.frames[link] = matrixToPose(matrix);
        stack.add(link);
        for (const edge of robot.children[link] ?? []) {
            visit(edge.child, composeMatrix(matrix, originMatrix(edge.joint.origin)), depth + 1);
        }
        stack.delete(link);
    };
    if (robot.root) visit(robot.root, IDENTITY, 0);

    for (const joint of Object.values(robot.joints)) {
        joint.role = "rejected";
        joint.axisInRoot = { x: joint.axis[0], y: joint.axis[1], z: joint.axis[2] };
        if (joint.mimic) {
            issues.push(urdfIssue("vehicle.urdf.mimic", `robot/joint[${joint.name}]/mimic`, `Joint "${joint.name}" uses mimic, which this adapter does not represent.`));
            continue;
        }
        if (joint.type === "fixed") {
            joint.role = "fixed";
            continue;
        }
        if (joint.type !== "revolute" && joint.type !== "continuous") {
            issues.push(urdfIssue("vehicle.urdf.joint-type", `robot/joint[${joint.name}]`, `Joint "${joint.name}" has unsupported type "${joint.type}".`));
            continue;
        }
        const frame = robot.frames[joint.child];
        if (!frame) continue;
        const axis = rotateAxis(frame.quaternion, joint.axis);
        joint.axisInRoot = axis;
        if (axisParallel(axis, [0, 1, 0])) {
            joint.role = "wheel-spin";
            continue;
        }
        if (joint.type === "revolute" && axisParallel(axis, [0, 0, 1])) {
            joint.role = "steering";
            continue;
        }
        issues.push(urdfIssue(
            "vehicle.urdf.articulation",
            `robot/joint[${joint.name}]`,
            `Joint "${joint.name}" is not a fixed joint, wheel spin, or front steering carrier.`,
        ));
    }

    const steering = Object.values(robot.joints).filter((joint) => joint.role === "steering");
    if (steering.length > 2) {
        issues.push(urdfIssue("vehicle.urdf.articulation", "robot", "More than one steered pair is outside the rigid vehicle contract."));
    }
    const wheels = [];
    for (const joint of Object.values(robot.joints)) {
        if (joint.role !== "wheel-spin") continue;
        const steeringJoint = nearestSteering(robot, joint);
        const movable = movableDescendants(robot, joint.child, joint.name);
        if (movable.length > 0) {
            issues.push(urdfIssue("vehicle.urdf.articulation", `robot/joint[${joint.name}]`, `Wheel joint "${joint.name}" has movable descendants.`));
        }
        wheels.push({ spinJoint: joint.name, link: joint.child, steeringJoint: steeringJoint?.name ?? null });
    }
    for (const joint of steering) {
        const subtree = subtreeJoints(robot, joint.child);
        const spins = subtree.filter((entry) => entry.role === "wheel-spin");
        const others = subtree.filter((entry) => entry.role !== "fixed" && entry.role !== "wheel-spin");
        if (spins.length !== 1 || others.length > 0) {
            issues.push(urdfIssue(
                "vehicle.urdf.articulation",
                `robot/joint[${joint.name}]`,
                `Steering joint "${joint.name}" must carry exactly one wheel-spin joint.`,
            ));
        }
    }
    robot.classification = { wheels, steering: steering.map((joint) => joint.name), issues };
}

function linkInCycle(parentJoint, start) {
    const seen = new Set();
    let cursor = start;
    while (cursor) {
        if (seen.has(cursor)) return true;
        seen.add(cursor);
        const joint = parentJoint.get(cursor);
        if (!joint) return false;
        cursor = joint.parent;
    }
    return false;
}

function nearestSteering(robot, spinJoint) {
    let link = spinJoint.parent;
    const seen = new Set();
    while (link && !seen.has(link)) {
        seen.add(link);
        const parent = Object.values(robot.joints).find((joint) => joint.child === link);
        if (!parent) return null;
        if (parent.role === "steering") return parent;
        if (parent.role !== "fixed") return null;
        link = parent.parent;
    }
    return null;
}

function movableDescendants(robot, link, ignoreJoint) {
    const found = [];
    const visit = (name) => {
        for (const edge of robot.children[name] ?? []) {
            if (edge.joint.name !== ignoreJoint && edge.joint.role !== "fixed") found.push(edge.joint.name);
            visit(edge.child);
        }
    };
    visit(link);
    return found;
}

function subtreeJoints(robot, link) {
    const found = [];
    const visit = (name) => {
        for (const edge of robot.children[name] ?? []) {
            found.push(edge.joint);
            visit(edge.child);
        }
    };
    visit(link);
    return found;
}

/**
 * Parse a URDF document into a link tree and joint roles.
 * Mesh bytes are not decoded here.
 */
function sourceText(input) {
    if (typeof input === "string") return input;
    if (input instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(input));
    if (input instanceof Uint8Array) return new TextDecoder().decode(input);
    return input?.text ?? null;
}

export function parseUrdfRobot(input, { entryPath = "" } = {}) {
    const issues = [];
    const omissions = [];
    const rawText = sourceText(input);
    if (textUsesXacro(rawText ?? "", entryPath)) {
        return {
            robot: null,
            issues: [urdfIssue("vehicle.urdf.xacro", entryPath || "robot", "Xacro is outside this adapter.")],
            omissions,
        };
    }
    let parsed;
    try {
        parsed = typeof input === "string" || input instanceof Uint8Array || input instanceof ArrayBuffer
            ? parseUrdfXml(input)
            : input?.document
                ? input
                : parseUrdfXml(input);
    } catch (error) {
        return { robot: null, issues: urdfXmlIssues(error), omissions };
    }
    const robots = childElements(parsed.document).filter((node) => localName(node) === "robot");
    const nested = parsed.document.getElementsByTagName("robot");
    if (robots.length !== 1 || nested.length !== 1) {
        return {
            robot: null,
            issues: [urdfIssue("vehicle.urdf.parse", "robot", "The document must contain one robot.")],
            omissions,
        };
    }
    const robotElement = robots[0];
    const robot = emptyRobot(robotElement.getAttribute("name") ?? "");
    for (const child of childElements(robotElement)) {
        const kind = localName(child);
        if (OMITTED_ROBOT_ELEMENTS.has(kind) || kind === "sensor") {
            omissions.push(urdfIssue("vehicle.urdf.omitted-element", `robot/${kind}`, `URDF ${kind} elements are omitted.`, "info"));
            continue;
        }
        if (kind === "link") readLink(robot, child, issues, omissions);
        else if (kind === "joint") readJoint(robot, child, issues);
        else if (kind === "material") continue;
        else omissions.push(urdfIssue("vehicle.urdf.omitted-element", `robot/${kind}`, `URDF ${kind} elements are omitted.`, "info"));
    }
    for (const joint of Object.values(robot.joints)) {
        if (!robot.children[joint.parent]) robot.children[joint.parent] = [];
        robot.children[joint.parent].push({ joint, child: joint.child });
    }
    for (const edges of Object.values(robot.children)) {
        edges.sort((left, right) => left.joint.name < right.joint.name ? -1 : left.joint.name > right.joint.name ? 1 : 0);
    }
    classifyJoints(robot, issues);
    return { robot, issues, omissions };
}

function readLink(robot, element, issues, omissions) {
    const name = element.getAttribute("name") ?? "";
    if (!name || robot.links[name]) {
        issues.push(urdfIssue("vehicle.urdf.parse", "robot/link", name ? `Duplicate link "${name}".` : "A link name is required."));
        return;
    }
    if (firstNamed(element, "inertial")) {
        omissions.push(urdfIssue("vehicle.urdf.omitted-element", `robot/link[${name}]/inertial`, `Inertia on "${name}" is omitted.`, "info"));
    }
    robot.links[name] = {
        name,
        visuals: childrenNamed(element, "visual").map((visual, index) => readVisualOrCollision(visual, `robot/link[${name}]/visual[${index}]`, issues)),
        collisions: childrenNamed(element, "collision").map((collision, index) => readVisualOrCollision(collision, `robot/link[${name}]/collision[${index}]`, issues)),
    };
}

function readJoint(robot, element, issues) {
    const name = element.getAttribute("name") ?? "";
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (!name || robot.joints[name]) {
        issues.push(urdfIssue("vehicle.urdf.parse", "robot/joint", name ? `Duplicate joint "${name}".` : "A joint name is required."));
        return;
    }
    const parent = firstNamed(element, "parent")?.getAttribute("link") ?? "";
    const child = firstNamed(element, "child")?.getAttribute("link") ?? "";
    const axisText = firstNamed(element, "axis")?.getAttribute("xyz");
    robot.joints[name] = {
        name,
        type,
        parent,
        child,
        origin: readOrigin(element, `robot/joint[${name}]`, issues),
        axis: axisText ? tuple(axisText, 3, "axis xyz", `robot/joint[${name}]/axis`, issues) : [1, 0, 0],
        limit: readLimit(element, `robot/joint[${name}]`, issues),
        mimic: readMimic(element),
        role: "rejected",
        axisInRoot: { x: 1, y: 0, z: 0 },
    };
}
