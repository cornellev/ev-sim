import * as THREE from "three";
import { Data } from "../data/Data";
import { ScenarioCar } from "../vehicles/ScenarioCar";

const VEHICLE_OBSTACLE_TYPES = new Set([
    "bicycle",
    "bus",
    "car",
    "motorcycle",
    "parkedvehicle",
    "priorityvehicle",
    "taxi",
    "train",
    "truck",
    "vehicle",
]);

export class TrafficScenario {
    constructor(scene = null, data = null, scenarioFolder = "", options = {}) {
        this.scene = scene;
        this.data = data;
        this.scenarioFolder = scenarioFolder;
        this.options = options || {};

        const source = resolveScenarioSource(scenarioFolder, this.options);
        this.folder = source.folder;
        this.scenarioId = source.scenarioId;
        this.manifest = source.manifest;

        this.files = null;
        this.xml = null;
        this.timeStepSize = 0.1;
        this.cars = [];
        this.isPlaying = this.options.autoplay === true;

        this.root = new THREE.Group();
        this.root.name = `Scenario_${this.scenarioId}`;

        this.visualRoot = new THREE.Group();
        this.visualRoot.name = "ScenarioVisuals";
        this.root.add(this.visualRoot);

        this.vehicleRoot = new THREE.Group();
        this.vehicleRoot.name = "ScenarioVehicles";
        this.root.add(this.vehicleRoot);
    }

    static async load(scene, data, scenarioFolder, options = {}) {
        const scenario = new TrafficScenario(scene, data, scenarioFolder, options);
        await scenario.setup(scene, data);
        return scenario;
    }

    /**
     * @param {THREE.Scene} scene
     * @param {Data} data
     */
    async setup(scene = this.scene, data = this.data) {
        if (!scene) {
            throw new Error("TrafficScenario.setup requires a THREE.Scene instance");
        }

        if (data != null && !(data instanceof Data)) {
            throw new Error("TrafficScenario.setup requires a Data instance when data is provided");
        }

        this.scene = scene;
        this.data = data;

        this.files = await fetchScenarioBundle(this.folder, this.manifest);
        this.xml = parseScenarioXml(this.files);

        if (!this.root.parent) {
            scene.add(this.root);
        }

        if (!this.xml.commonRoad) {
            return this;
        }

        const helpers = makeHelpers(this.options);
        const lanelets = parseLanelets(this.xml.commonRoad, helpers);
        const trafficLights = parseTrafficLights(this.xml.commonRoad);
        const trafficSigns = parseTrafficSigns(this.xml.commonRoad);
        const staticObstacles = parseStaticObstacles(this.xml.commonRoad);
        const dynamicObstacles = parseDynamicObstacles(this.xml.commonRoad);
        const planningProblems = parsePlanningProblems(this.xml.commonRoad);

        this.timeStepSize = parseTimeStepSize(this.xml.commonRoad);

        addLanelets(this.visualRoot, lanelets, helpers);
        addTrafficLights(this.visualRoot, lanelets, trafficLights, helpers);
        addTrafficSigns(this.visualRoot, lanelets, trafficSigns, helpers);

        const scenarioCars = this.data
            ? this.createScenarioCars({
                dynamicObstacles,
                staticObstacles,
                planningProblems,
                helpers,
            })
            : { cars: [], obstacleIds: new Set(), planningProblemIds: new Set() };

        this.cars = scenarioCars.cars;

        for (const car of this.cars) {
            car.addToScene(this.vehicleRoot);
        }

        addStaticObstacles(this.visualRoot, staticObstacles, helpers, scenarioCars.obstacleIds);
        addDynamicObstacleTrajectories(this.visualRoot, dynamicObstacles, helpers);
        addPlanningProblems(this.visualRoot, planningProblems, helpers, {
            renderInitialState: scenarioCars.planningProblemIds.size === 0,
        });

        return this;
    }

    createScenarioCars({ dynamicObstacles, staticObstacles, planningProblems, helpers }) {
        const cars = [];
        const obstacleIds = new Set();
        const planningProblemIds = new Set();

        for (const obstacle of dynamicObstacles) {
            if (!isVehicleObstacleType(obstacle.type)) continue;

            const shape = helpers.shapeFromNode(obstacle.shape);
            if (!shape || shape.type !== "rectangle") continue;

            const keyframes = buildTimedStates(
                obstacle.initialState,
                obstacle.trajectory,
                shape,
                helpers,
                this.timeStepSize
            );
            
            if (!keyframes.length) continue;

            const car = new ScenarioCar(this.data.vehicles(), {
                id: `dynamic_${obstacle.id}`,
                keyframes,
                length: shape.length,
                width: shape.width,
                height: this.options.vehicleHeight || helpers.cfg.vehicleHeight,
                color: this.options.scenarioCarColor || helpers.cfg.obstacleDynamicColor,
                roofColor: this.options.scenarioCarRoofColor || 0x9fd1ff,
                lift: helpers.cfg.objectY,
                autoplay: this.isPlaying,
            });

            cars.push(car);
            obstacleIds.add(obstacle.id);
        }

        for (const obstacle of staticObstacles) {
            if (!isVehicleObstacleType(obstacle.type)) continue;

            const shape = helpers.shapeFromNode(obstacle.shape);
            if (!shape || shape.type !== "rectangle") continue;

            const keyframes = buildTimedStates(
                obstacle.initialState,
                null,
                shape,
                helpers,
                this.timeStepSize
            );
            if (!keyframes.length) continue;

            const car = new ScenarioCar(this.data.vehicles(), {
                id: `static_${obstacle.id}`,
                keyframes,
                length: shape.length,
                width: shape.width,
                height: this.options.vehicleHeight || helpers.cfg.vehicleHeight,
                color: this.options.staticScenarioCarColor || helpers.cfg.obstacleStaticColor,
                roofColor: this.options.staticScenarioCarRoofColor || 0xbbbbbb,
                lift: helpers.cfg.objectY,
                autoplay: this.isPlaying,
            });

            cars.push(car);
            obstacleIds.add(obstacle.id);
        }

        for (const problem of planningProblems) {
            const state = helpers.stateFromNode(problem.initialState);
            if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) continue;

            const car = new ScenarioCar(this.data.vehicles(), {
                id: `planning_${problem.id}`,
                keyframes: [{
                    t: state.time * this.timeStepSize,
                    x: state.x,
                    y: state.y,
                    yaw: state.yaw,
                    velocity: state.velocity,
                }],
                length: 4.5,
                width: 2.0,
                height: this.options.vehicleHeight || helpers.cfg.vehicleHeight,
                color: this.options.egoColor || helpers.cfg.egoColor,
                roofColor: this.options.egoRoofColor || 0xa7f3b0,
                lift: helpers.cfg.objectY,
                autoplay: this.isPlaying,
            });

            cars.push(car);
            planningProblemIds.add(problem.id);
        }

        return { cars, obstacleIds, planningProblemIds };
    }

    play({ restart = false } = {}) {
        this.isPlaying = true;

        for (const car of this.cars) {
            car.play({ restart });
        }

        return this;
    }

    pause() {
        this.isPlaying = false;

        for (const car of this.cars) {
            car.pause();
        }

        return this;
    }

    restart() {
        for (const car of this.cars) {
            car.restart();
            if (!this.isPlaying) {
                car.pause();
            }
        }

        return this;
    }

    togglePlayback() {
        if (this.isPlaying) {
            this.pause();
            return false;
        }

        this.play({ restart: this.cars.some((car) => car.completed) });
        return true;
    }
}

export async function loadScenarioFolder(scene, scenarioFolder, options = {}) {
    return TrafficScenario.load(scene, options.data || null, scenarioFolder, options);
}

function parseScenarioXml(files) {
    return {
        commonRoad: files.commonRoad
            ? new DOMParser().parseFromString(files.commonRoad, "application/xml")
            : null,
        net: files.net
            ? new DOMParser().parseFromString(files.net, "application/xml")
            : null,
        additional: files.additional
            ? new DOMParser().parseFromString(files.additional, "application/xml")
            : null,
        vehicles: files.vehicles
            ? new DOMParser().parseFromString(files.vehicles, "application/xml")
            : null,
        pedestrians: files.pedestrians
            ? new DOMParser().parseFromString(files.pedestrians, "application/xml")
            : null,
        nodes: files.nodes
            ? new DOMParser().parseFromString(files.nodes, "application/xml")
            : null,
        edges: files.edges
            ? new DOMParser().parseFromString(files.edges, "application/xml")
            : null,
        connections: files.connections
            ? new DOMParser().parseFromString(files.connections, "application/xml")
            : null,
        trafficLights: files.trafficLights
            ? new DOMParser().parseFromString(files.trafficLights, "application/xml")
            : null,
        sumoConfig: files.sumoConfig
            ? new DOMParser().parseFromString(files.sumoConfig, "application/xml")
            : null,
    };
}

function parseTimeStepSize(xml) {
    const value = Number.parseFloat(xml?.documentElement?.getAttribute("timeStepSize") ?? 0.1);
    return Number.isFinite(value) && value > 0 ? value : 0.1;
}

function isVehicleObstacleType(type) {
    return VEHICLE_OBSTACLE_TYPES.has(String(type || "").toLowerCase());
}

function buildTimedStates(initialStateNode, trajectoryNode, shape, helpers, timeStepSize) {
    const nodes = [initialStateNode];

    if (trajectoryNode) {
        nodes.push(...Array.from(trajectoryNode.getElementsByTagName("state")));
    }

    return nodes
        .filter(Boolean)
        .map((node, index) => {
            const state = helpers.stateFromNode(node);
            const pose = shape?.type === "rectangle"
                ? helpers.applyRectanglePose(state, shape)
                : state;

            return {
                t: (Number.isFinite(state.time) ? state.time : index) * timeStepSize,
                x: pose.x,
                y: pose.y,
                yaw: pose.yaw,
                velocity: state.velocity,
            };
        })
        .filter((state) => Number.isFinite(state.x) && Number.isFinite(state.y))
        .sort((a, b) => a.t - b.t);
}

function resolveScenarioSource(scenarioPath, options = {}) {
    const normalizedPath = String(scenarioPath || "").replace(/\/$/, "");
    const explicitManifest = options.manifest || null;
    const explicitScenarioId = options.scenarioId || null;
    const isSingleXmlFile = /\.xml$/i.test(normalizedPath);

    if (explicitManifest) {
        const fallbackName = normalizedPath.split("/").pop() || "scenario";
        const scenarioId = explicitScenarioId || decodeURIComponent(fallbackName.replace(/\.xml$/i, ""));
        const folder = isSingleXmlFile
            ? normalizedPath.split("/").slice(0, -1).join("/") || "."
            : normalizedPath;

        return {
            folder,
            scenarioId,
            manifest: explicitManifest,
        };
    }

    if (isSingleXmlFile) {
        const fileName = normalizedPath.split("/").pop() || "scenario.xml";
        const folder = normalizedPath.split("/").slice(0, -1).join("/") || ".";
        const scenarioId = explicitScenarioId || decodeURIComponent(fileName.replace(/\.xml$/i, ""));

        return {
            folder,
            scenarioId,
            manifest: {
                commonRoad: fileName,
            },
        };
    }

    const folder = normalizedPath;
    const scenarioId = explicitScenarioId || decodeURIComponent(folder.split("/").pop() || "scenario");

    return {
        folder,
        scenarioId,
        manifest: defaultScenarioManifest(scenarioId),
    };
}

function defaultScenarioManifest(scenarioId) {
    return {
        commonRoad: `${scenarioId}.cr.xml`,
        net: `${scenarioId}.net.xml`,
        additional: `${scenarioId}.add.xml`,
        vehicles: `${scenarioId}.vehicles.rou.xml`,
        pedestrians: `${scenarioId}.pedestrians.rou.xml`,
        nodes: `nodes.net.xml`,
        edges: `edges.net.xml`,
        connections: `_connections.net.xml`,
        trafficLights: `_tll.net.xml`,
        sumoConfig: `${scenarioId}.sumo.cfg`,
    };
}

async function fetchScenarioBundle(folder, manifest) {
    const entries = await Promise.all(
        Object.entries(manifest).map(async ([key, fileName]) => {
            const url = `${folder}/${fileName}`;

            try {
                const res = await fetch(url);
                if (!res.ok) {
                    return [key, null];
                }
                return [key, await res.text()];
            } catch {
                return [key, null];
            }
        })
    );

    const files = Object.fromEntries(entries);

    if (!files.commonRoad && !files.net) {
        throw new Error(
            `No scenario files could be loaded from "${folder}". Expected at least "${manifest.commonRoad}" or "${manifest.net}".`
        );
    }

    return files;
}

function makeHelpers(cfg) {
    const toFiniteNumber = (v, fallback) => {
        const n = typeof v === "number" ? v : Number.parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    };

    const defaults = {
        lineY: 0.02,
        roadY: 0.0,
        objectY: 0.0,
        curveSamples: 16,

        laneColor: 0x2b2b2b,
        laneEdgeColor: 0xffffff,
        stopLineColor: 0xffe066,
        trafficLightColor: 0x333333,
        trafficSignColor: 0xdddddd,
        obstacleStaticColor: 0x888888,
        obstacleDynamicColor: 0x3aa0ff,
        obstacleTrajectoryColor: 0x3aa0ff,
        egoColor: 0x35d04c,
        goalColor: 0xffd84d,

        vehicleHeight: 1.5,
        goalHeight: 0.4,
    };

    cfg = { ...defaults, ...(cfg || {}) };

    cfg.lineY = toFiniteNumber(cfg.lineY, defaults.lineY);
    cfg.roadY = toFiniteNumber(cfg.roadY, defaults.roadY);
    cfg.objectY = toFiniteNumber(cfg.objectY, defaults.objectY);
    cfg.curveSamples = Math.max(2, Math.floor(toFiniteNumber(cfg.curveSamples, defaults.curveSamples)));
    cfg.vehicleHeight = toFiniteNumber(cfg.vehicleHeight, defaults.vehicleHeight);
    cfg.goalHeight = toFiniteNumber(cfg.goalHeight, defaults.goalHeight);

    const crToVec3 = (x, y, lift = 0) => new THREE.Vector3(x, lift, y);

    const yawToThree = (yaw = 0) => -yaw;

    function parseFloatSafe(v, fallback = 0) {
        const text = typeof v === "string" ? v : v?.textContent;
        const n = Number.parseFloat(text);
        return Number.isFinite(n) ? n : fallback;
    }

    function isFinitePoint(p) {
        return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
    }

    function child(el, tag) {
        return Array.from(el?.children || []).find((c) => c.tagName === tag) || null;
    }

    function children(el, tag) {
        return Array.from(el?.children || []).filter((c) => c.tagName === tag);
    }

    function numberFromElement(el, tag, fallback = 0) {
        const target = child(el, tag);
        if (!target) return fallback;

        const exact = child(target, "exact");
        if (exact) return parseFloatSafe(exact, fallback);

        return parseFloatSafe(target, fallback);
    }

    function pointFromNode(node) {
        return {
            x: parseFloatSafe(child(node, "x"), 0),
            y: parseFloatSafe(child(node, "y"), 0),
        };
    }

    function polylineFromNode(node) {
        return children(node, "point").map(pointFromNode).filter(isFinitePoint);
    }

    function stateFromNode(node) {
        const positionNode = child(node, "position");
        const pointNode = positionNode ? child(positionNode, "point") : null;

        return {
            x: pointNode ? parseFloatSafe(child(pointNode, "x"), 0) : 0,
            y: pointNode ? parseFloatSafe(child(pointNode, "y"), 0) : 0,
            yaw: numberFromElement(node, "orientation", 0),
            time: numberFromElement(node, "time", 0),
            velocity: numberFromElement(node, "velocity", 0),
        };
    }

    function shapeFromNode(shapeNode) {
        if (!shapeNode) return null;

        const rect = child(shapeNode, "rectangle");
        if (rect) {
            const centerNode = child(rect, "center");
            const orientationNode = child(rect, "orientation");

            return {
                type: "rectangle",
                length: parseFloatSafe(child(rect, "length"), 4.5),
                width: parseFloatSafe(child(rect, "width"), 2.0),
                center: centerNode
                    ? {
                        x: parseFloatSafe(child(centerNode, "x"), 0),
                        y: parseFloatSafe(child(centerNode, "y"), 0),
                    }
                    : null,
                orientation: orientationNode
                    ? parseFloatSafe(orientationNode, 0)
                    : 0,
            };
        }

        const circle = child(shapeNode, "circle");
        if (circle) {
            return {
                type: "circle",
                radius: parseFloatSafe(child(circle, "radius"), 1),
            };
        }

        const polygon = child(shapeNode, "polygon");
        if (polygon) {
            return {
                type: "polygon",
                points: polylineFromNode(polygon),
            };
        }

        return null;
    }

    function makeLine(points, material, y = cfg.lineY, closed = false) {
        if (!Number.isFinite(y)) y = defaults.lineY;
        const safePoints = (points || []).filter(isFinitePoint);
        if (!safePoints.length) return new THREE.Group();
        const pts = safePoints.map((p) => crToVec3(p.x, p.y, y));
        if (closed && pts.length) pts.push(pts[0].clone());
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        return new THREE.Line(geo, material);
    }

    function makeFilledLane(leftPts, rightPts) {
        const shape = new THREE.Shape();
        const left = (leftPts || []).filter(isFinitePoint);
        const right = (rightPts || []).filter(isFinitePoint);
        if (!left.length || !right.length) return null;

        shape.moveTo(left[0].x, left[0].y);
        for (let i = 1; i < left.length; i++) shape.lineTo(left[i].x, left[i].y);
        for (let i = right.length - 1; i >= 0; i--) shape.lineTo(right[i].x, right[i].y);
        shape.closePath();

        const geo = new THREE.ShapeGeometry(shape, cfg.curveSamples);
        geo.rotateX(Math.PI / 2);
        geo.translate(0, Number.isFinite(cfg.roadY) ? cfg.roadY : defaults.roadY, 0);

        return new THREE.Mesh(
            geo,
            new THREE.MeshStandardMaterial({
                color: cfg.laneColor,
                side: THREE.DoubleSide,
                roughness: 1,
                metalness: 0,
            })
        );
    }

    function midpoint(a, b) {
        return {
            x: (a.x + b.x) * 0.5,
            y: (a.y + b.y) * 0.5,
        };
    }

    function applyRectanglePose(state, rectShape) {
        if (!rectShape || rectShape.type !== "rectangle") return state;

        let x = state.x;
        let y = state.y;
        let yaw = state.yaw;

        if (rectShape.center && Number.isFinite(rectShape.center.x) && Number.isFinite(rectShape.center.y)) {
            const c = rectShape.center;
            const cos = Math.cos(yaw);
            const sin = Math.sin(yaw);
            x += c.x * cos - c.y * sin;
            y += c.x * sin + c.y * cos;
        }

        if (Number.isFinite(rectShape.orientation)) {
            yaw += rectShape.orientation;
        }

        return { ...state, x, y, yaw };
    }

    function addRectangle(group, x, y, yaw, length, width, height, material, lift = cfg.objectY) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (!Number.isFinite(length) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
        if (!Number.isFinite(lift)) lift = defaults.objectY;
        if (!Number.isFinite(yaw)) yaw = 0;
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(length, height, width),
            material
        );
        mesh.position.set(x, lift + height * 0.5, y);
        mesh.rotation.y = yawToThree(yaw);
        group.add(mesh);
        return mesh;
    }

    function addCylinder(group, x, y, radius, height, material, lift = cfg.objectY) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (!Number.isFinite(radius) || !Number.isFinite(height)) return null;
        if (!Number.isFinite(lift)) lift = defaults.objectY;
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, height, 20),
            material
        );
        mesh.position.set(x, lift + height * 0.5, y);
        group.add(mesh);
        return mesh;
    }

    return {
        cfg,
        child,
        children,
        pointFromNode,
        polylineFromNode,
        stateFromNode,
        shapeFromNode,
        parseFloatSafe,
        crToVec3,
        yawToThree,
        makeLine,
        makeFilledLane,
        midpoint,
        applyRectanglePose,
        addRectangle,
        addCylinder,
    };
}

function parseLanelets(xml, h) {
    const laneletNodes = Array.from(xml.getElementsByTagName("lanelet"));
    return laneletNodes.map((node) => {
        const left = Array.from(node.children).find((c) => c.tagName === "leftBound");
        const right = Array.from(node.children).find((c) => c.tagName === "rightBound");
        const stopLine = Array.from(node.children).find((c) => c.tagName === "stopLine");

        const poly = (boundNode) => {
            if (!boundNode) return [];
            if (h?.polylineFromNode) return h.polylineFromNode(boundNode);
            return Array.from(boundNode.getElementsByTagName("point")).map((p) => ({
                x: Number.parseFloat(p.getElementsByTagName("x")[0]?.textContent ?? 0),
                y: Number.parseFloat(p.getElementsByTagName("y")[0]?.textContent ?? 0),
            })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        };

        return {
            id: node.getAttribute("id"),
            left: poly(left),
            right: poly(right),
            stopLine: poly(stopLine),
            trafficSignRefs: Array.from(node.getElementsByTagName("trafficSignRef")).map((n) => n.getAttribute("ref")),
            trafficLightRefs: Array.from(node.getElementsByTagName("trafficLightRef")).map((n) => n.getAttribute("ref")),
        };
    });
}

function parseTrafficLights(xml) {
    return Array.from(xml.getElementsByTagName("trafficLight")).map((node) => ({
        id: node.getAttribute("id"),
    }));
}

function parseTrafficSigns(xml) {
    return Array.from(xml.getElementsByTagName("trafficSign")).map((node) => ({
        id: node.getAttribute("id"),
        virtual: node.getAttribute("virtual") === "true",
    }));
}

function parseStaticObstacles(xml) {
    return Array.from(xml.getElementsByTagName("staticObstacle")).map((node) => ({
        id: node.getAttribute("id"),
        type: node.getElementsByTagName("type")[0]?.textContent || null,
        initialState: node.getElementsByTagName("initialState")[0],
        shape: node.getElementsByTagName("shape")[0],
    }));
}

function parseDynamicObstacles(xml) {
    return Array.from(xml.getElementsByTagName("dynamicObstacle")).map((node) => ({
        id: node.getAttribute("id"),
        type: node.getElementsByTagName("type")[0]?.textContent || null,
        initialState: node.getElementsByTagName("initialState")[0],
        shape: node.getElementsByTagName("shape")[0],
        trajectory: node.getElementsByTagName("trajectory")[0],
    }));
}

function parsePlanningProblems(xml) {
    return Array.from(xml.getElementsByTagName("planningProblem")).map((node) => ({
        id: node.getAttribute("id"),
        initialState: node.getElementsByTagName("initialState")[0],
        goalState: node.getElementsByTagName("goalState")[0],
    }));
}

function addLanelets(root, lanelets, h) {
    const laneGroup = new THREE.Group();
    laneGroup.name = "Lanelets";
    root.add(laneGroup);

    const edgeMat = new THREE.LineBasicMaterial({ color: h.cfg.laneEdgeColor });
    const stopMat = new THREE.LineBasicMaterial({ color: h.cfg.stopLineColor });

    for (const lanelet of lanelets) {
        const g = new THREE.Group();
        g.name = `Lanelet_${lanelet.id}`;

        const fill = h.makeFilledLane(lanelet.left, lanelet.right);
        if (fill) g.add(fill);

        g.add(h.makeLine(lanelet.left, edgeMat));
        g.add(h.makeLine(lanelet.right, edgeMat));

        if (lanelet.stopLine?.length >= 2) {
            g.add(h.makeLine(lanelet.stopLine, stopMat, h.cfg.lineY + 0.01));
        }

        laneGroup.add(g);
    }
}

function addTrafficLights(root, lanelets, trafficLights, h) {
    const group = new THREE.Group();
    group.name = "TrafficLights";
    root.add(group);

    const poleMat = new THREE.MeshStandardMaterial({ color: h.cfg.trafficLightColor });
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xff3333 });

    const lightIds = new Set(trafficLights.map((l) => l.id));

    for (const lanelet of lanelets) {
        for (const ref of lanelet.trafficLightRefs || []) {
            if (!lightIds.has(ref)) continue;

            const leftEnd = lanelet.left[lanelet.left.length - 1];
            const rightEnd = lanelet.right[lanelet.right.length - 1];
            if (!leftEnd || !rightEnd) continue;

            const p = h.midpoint(leftEnd, rightEnd);

            const obj = new THREE.Group();
            obj.name = `TrafficLight_${ref}`;

            h.addCylinder(obj, p.x, p.y, 0.08, 2.6, poleMat);
            const head = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.5, 0.25), poleMat);
            head.position.set(p.x, 2.5, p.y);
            obj.add(head);

            const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), bulbMat);
            bulb.position.set(p.x, 2.5, p.y + 0.14);
            obj.add(bulb);

            group.add(obj);
        }
    }
}

function addTrafficSigns(root, lanelets, trafficSigns, h) {
    const group = new THREE.Group();
    group.name = "TrafficSigns";
    root.add(group);

    const poleMat = new THREE.MeshStandardMaterial({ color: 0x666666 });
    const signMat = new THREE.MeshStandardMaterial({ color: h.cfg.trafficSignColor });

    const signIds = new Set(trafficSigns.map((s) => s.id));

    for (const lanelet of lanelets) {
        for (const ref of lanelet.trafficSignRefs || []) {
            if (!signIds.has(ref)) continue;

            const leftStart = lanelet.left[0];
            const rightStart = lanelet.right[0];
            if (!leftStart || !rightStart) continue;

            const p = h.midpoint(leftStart, rightStart);

            const obj = new THREE.Group();
            obj.name = `TrafficSign_${ref}`;

            h.addCylinder(obj, p.x, p.y, 0.06, 2.2, poleMat);
            const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 24), signMat);
            plate.rotation.z = Math.PI / 2;
            plate.position.set(p.x, 2.0, p.y);
            obj.add(plate);

            group.add(obj);
        }
    }
}

function addStaticObstacles(root, staticObstacles, h, scenarioObstacleIds = new Set()) {
    const group = new THREE.Group();
    group.name = "StaticObstacles";
    root.add(group);

    const mat = new THREE.MeshStandardMaterial({ color: h.cfg.obstacleStaticColor });

    for (const obstacle of staticObstacles) {
        if (scenarioObstacleIds.has(obstacle.id)) continue;

        const state = h.stateFromNode(obstacle.initialState);
        const shape = h.shapeFromNode(obstacle.shape);
        if (!shape) continue;

        const g = new THREE.Group();
        g.name = `StaticObstacle_${obstacle.id}`;

        if (shape.type === "rectangle") {
            const pose = h.applyRectanglePose(state, shape);
            h.addRectangle(g, pose.x, pose.y, pose.yaw, shape.length, shape.width, h.cfg.vehicleHeight, mat);
        } else if (shape.type === "circle") {
            h.addCylinder(g, state.x, state.y, shape.radius, h.cfg.vehicleHeight, mat);
        }

        group.add(g);
    }
}

function addDynamicObstacleTrajectories(root, dynamicObstacles, h) {
    const group = new THREE.Group();
    group.name = "DynamicObstacleTrajectories";
    root.add(group);

    const pathMat = new THREE.LineBasicMaterial({ color: h.cfg.obstacleTrajectoryColor });

    for (const obstacle of dynamicObstacles) {
        const shape = h.shapeFromNode(obstacle.shape);
        if (!shape || shape.type !== "rectangle") continue;

        const states = buildTimedStates(
            obstacle.initialState,
            obstacle.trajectory,
            shape,
            h,
            1
        );
        if (states.length < 2) continue;

        const g = new THREE.Group();
        g.name = `DynamicTrajectory_${obstacle.id}`;
        g.add(h.makeLine(states, pathMat, h.cfg.lineY + 0.02));
        group.add(g);
    }
}

function addPlanningProblems(root, planningProblems, h, { renderInitialState = true } = {}) {
    const group = new THREE.Group();
    group.name = "PlanningProblems";
    root.add(group);

    const egoMat = new THREE.MeshStandardMaterial({ color: h.cfg.egoColor });
    const goalMat = new THREE.MeshStandardMaterial({
        color: h.cfg.goalColor,
        transparent: true,
        opacity: 0.35,
    });

    for (const problem of planningProblems) {
        const g = new THREE.Group();
        g.name = `PlanningProblem_${problem.id}`;

        if (renderInitialState && problem.initialState) {
            const s = h.stateFromNode(problem.initialState);
            h.addRectangle(g, s.x, s.y, s.yaw, 4.5, 2.0, h.cfg.vehicleHeight, egoMat);
        }

        if (problem.goalState) {
            const positionNode = Array.from(problem.goalState.children).find((c) => c.tagName === "position");
            const rectangleNode = positionNode?.getElementsByTagName("rectangle")[0];

            if (rectangleNode) {
                const centerNode = rectangleNode.getElementsByTagName("center")[0];
                const length = Number(rectangleNode.getElementsByTagName("length")[0]?.textContent ?? 6);
                const width = Number(rectangleNode.getElementsByTagName("width")[0]?.textContent ?? 3);
                const cx = Number(centerNode?.getElementsByTagName("x")[0]?.textContent ?? 0);
                const cy = Number(centerNode?.getElementsByTagName("y")[0]?.textContent ?? 0);
                const yaw = Number(rectangleNode.getElementsByTagName("orientation")[0]?.textContent ?? 0);

                const mesh = new THREE.Mesh(
                    new THREE.BoxGeometry(length, h.cfg.goalHeight, width),
                    goalMat
                );
                mesh.position.set(cx, h.cfg.goalHeight * 0.5 + h.cfg.objectY, cy);
                mesh.rotation.y = h.yawToThree(yaw);
                g.add(mesh);
            }
        }

        group.add(g);
    }
}
