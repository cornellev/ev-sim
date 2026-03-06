import * as THREE from "three";
import { Data } from "../data/Data";

class TrafficScenario {
    
    constructor() {
        
    }

    /**
     * 
     * @param {THREE.Scene} scene 
     * @param {Data} data 
     */
    setup(scene, data) {
        // sets up the traffic scenario in the scene, using data as needed
    }
}

export async function loadScenarioFolder(scene, scenarioFolder, options = {}) {
  const folder = scenarioFolder.replace(/\/$/, "");
  const scenarioId =
    options.scenarioId || decodeURIComponent(folder.split("/").pop());

  const manifest =
    options.manifest || defaultScenarioManifest(scenarioId);

  const files = await fetchScenarioBundle(folder, manifest);

  const xml = {
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

  const root = new THREE.Group();
  root.name = `Scenario_${scenarioId}`;
  scene.add(root);

  // Use your existing parsers/renderers here.
  // Prefer CommonRoad if present.
  if (xml.commonRoad) {
    const helpers = makeHelpers(options);

    const lanelets = parseLanelets(xml.commonRoad, helpers);
    const trafficLights = parseTrafficLights(xml.commonRoad);
    const trafficSigns = parseTrafficSigns(xml.commonRoad);
    const staticObstacles = parseStaticObstacles(xml.commonRoad);
    const dynamicObstacles = parseDynamicObstacles(xml.commonRoad);
    const planningProblems = parsePlanningProblems(xml.commonRoad);

    addLanelets(root, lanelets, helpers);
    addTrafficLights(root, lanelets, trafficLights, helpers);
    addTrafficSigns(root, lanelets, trafficSigns, helpers);
    addStaticObstacles(root, staticObstacles, helpers);
    addDynamicObstacles(root, dynamicObstacles, helpers);
    addPlanningProblems(root, planningProblems, helpers);
  }

  return {
    root,
    scenarioId,
    files,
    xml,
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
    // Geometry placement (these must be finite numbers; undefined will produce NaNs in BufferGeometry)
    lineY: 0.02,
    roadY: 0.0,
    objectY: 0.0,
    curveSamples: 16,

    // Materials/colors
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

    // Object dimensions
    vehicleHeight: 1.5,
    goalHeight: 0.4,
  };

  // Merge defaults with user overrides.
  cfg = { ...defaults, ...(cfg || {}) };

  // Coerce numeric fields to finite values (prevents NaNs reaching BufferGeometry).
  cfg.lineY = toFiniteNumber(cfg.lineY, defaults.lineY);
  cfg.roadY = toFiniteNumber(cfg.roadY, defaults.roadY);
  cfg.objectY = toFiniteNumber(cfg.objectY, defaults.objectY);
  cfg.curveSamples = Math.max(2, Math.floor(toFiniteNumber(cfg.curveSamples, defaults.curveSamples)));
  cfg.vehicleHeight = toFiniteNumber(cfg.vehicleHeight, defaults.vehicleHeight);
  cfg.goalHeight = toFiniteNumber(cfg.goalHeight, defaults.goalHeight);

  const crToVec3 = (x, y, lift = 0) => new THREE.Vector3(x, lift, y);

  const yawToThree = (yaw = 0) => -yaw;

  function parseFloatSafe(v, fallback = 0) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function isFinitePoint(p) {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  function child(el, tag) {
    return Array.from(el.children).find((c) => c.tagName === tag) || null;
  }

  function children(el, tag) {
    return Array.from(el.children).filter((c) => c.tagName === tag);
  }

  function pointFromNode(node) {
    return {
      x: parseFloatSafe(child(node, "x")?.textContent, 0),
      y: parseFloatSafe(child(node, "y")?.textContent, 0),
    };
  }

  function polylineFromNode(node) {
    return children(node, "point").map(pointFromNode).filter(isFinitePoint);
  }

  function stateFromNode(node) {
    const positionNode = child(node, "position");
    const pointNode = positionNode ? child(positionNode, "point") : null;

    return {
      x: pointNode ? parseFloatSafe(child(pointNode, "x")?.textContent, 0) : 0,
      y: pointNode ? parseFloatSafe(child(pointNode, "y")?.textContent, 0) : 0,
      yaw: parseFloatSafe(child(node, "orientation")?.textContent, 0),
      time: parseFloatSafe(child(node, "time")?.textContent, 0),
      velocity: parseFloatSafe(child(node, "velocity")?.textContent, 0),
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
        length: parseFloatSafe(child(rect, "length")?.textContent, 4.5),
        width: parseFloatSafe(child(rect, "width")?.textContent, 2.0),
        // CommonRoad rectangles may specify a local center offset and/or local orientation.
        // When used on obstacles, these are typically relative to the obstacle pose.
        center: centerNode
          ? {
              x: parseFloatSafe(child(centerNode, "x")?.textContent, 0),
              y: parseFloatSafe(child(centerNode, "y")?.textContent, 0),
            }
          : null,
        orientation: orientationNode
          ? parseFloatSafe(orientationNode.textContent, 0)
          : 0,
      };
    }

    const circle = child(shapeNode, "circle");
    if (circle) {
      return {
        type: "circle",
        radius: parseFloatSafe(child(circle, "radius")?.textContent, 1),
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

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: cfg.laneColor,
        side: THREE.DoubleSide,
        roughness: 1,
        metalness: 0,
      })
    );

    return mesh;
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
      // Rotate local center offset into world and add to state position.
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

        // Use helper parsing when provided (prevents NaNs from locale formats, missing nodes, etc.)
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
    return Array.from(xml.getElementsByTagName("staticObstacle")).map((node) => {
        const initialState = node.getElementsByTagName("initialState")[0];
        const shape = node.getElementsByTagName("shape")[0];
        return { id: node.getAttribute("id"), initialState, shape };
    });
}

function parseDynamicObstacles(xml) {
    return Array.from(xml.getElementsByTagName("dynamicObstacle")).map((node) => {
        const initialState = node.getElementsByTagName("initialState")[0];
        const shape = node.getElementsByTagName("shape")[0];
        const trajectory = node.getElementsByTagName("trajectory")[0];
        return { id: node.getAttribute("id"), initialState, shape, trajectory };
    });
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

function addStaticObstacles(root, staticObstacles, h) {
  const group = new THREE.Group();
  group.name = "StaticObstacles";
  root.add(group);

  const mat = new THREE.MeshStandardMaterial({ color: h.cfg.obstacleStaticColor });

  for (const obstacle of staticObstacles) {
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

function addDynamicObstacles(root, dynamicObstacles, h) {
  const group = new THREE.Group();
  group.name = "DynamicObstacles";
  root.add(group);

  const bodyMat = new THREE.MeshStandardMaterial({ color: h.cfg.obstacleDynamicColor });
  const ghostMat = new THREE.MeshStandardMaterial({
    color: h.cfg.obstacleTrajectoryColor,
    transparent: true,
    opacity: 0.45,
  });
  const pathMat = new THREE.LineBasicMaterial({ color: h.cfg.obstacleTrajectoryColor });

  for (const obstacle of dynamicObstacles) {
    const state = h.stateFromNode(obstacle.initialState);
    const shape = h.shapeFromNode(obstacle.shape);
    if (!shape || shape.type !== "rectangle") continue;

    const g = new THREE.Group();
    g.name = `DynamicObstacle_${obstacle.id}`;

    const pose0 = h.applyRectanglePose(state, shape);
    h.addRectangle(g, pose0.x, pose0.y, pose0.yaw, shape.length, shape.width, h.cfg.vehicleHeight, bodyMat);

    const states = obstacle.trajectory
      ? Array.from(obstacle.trajectory.getElementsByTagName("state")).map((n) => h.stateFromNode(n))
      : [];

    if (states.length) {
      const pts = [{ x: pose0.x, y: pose0.y }, ...states.map((s) => {
        const pose = h.applyRectanglePose(s, shape);
        return { x: pose.x, y: pose.y };
      })];
      g.add(h.makeLine(pts, pathMat, h.cfg.lineY + 0.02));

      for (const s of states) {
        const pose = h.applyRectanglePose(s, shape);
        h.addRectangle(g, pose.x, pose.y, pose.yaw, shape.length, shape.width, h.cfg.vehicleHeight * 0.6, ghostMat);
      }
    }

    group.add(g);
  }
}

function addPlanningProblems(root, planningProblems, h) {
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

    if (problem.initialState) {
      const s = h.stateFromNode(problem.initialState);
      h.addRectangle(g, s.x, s.y, s.yaw, 4.5, 2.0, h.cfg.vehicleHeight, egoMat);
    }

    if (problem.goalState) {
      const positionNode = Array.from(problem.goalState.children).find((c) => c.tagName === "position");
      const rectangleNode = positionNode?.getElementsByTagName("rectangle")[0];

      if (rectangleNode) {
        const length = Number(rectangleNode.getElementsByTagName("length")[0]?.textContent ?? 6);
        const width = Number(rectangleNode.getElementsByTagName("width")[0]?.textContent ?? 3);
        const cx = Number(rectangleNode.getElementsByTagName("x")[0]?.textContent ?? 0);
        const cy = Number(rectangleNode.getElementsByTagName("y")[0]?.textContent ?? 0);
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