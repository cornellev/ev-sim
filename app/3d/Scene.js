'use client';

import * as THREE from "three";
import { useEffect, useRef, useState } from "react";
import { Data } from "./data/Data";
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { KeyManager } from "./managers/KeyManager";
import { BasicScene } from "./scenes/Basic";
import { MouseManager } from "./managers/MouseManager";
import { Box } from "./data/objects/Box";
import { Sphere } from "./data/objects/Sphere";
import { LiDAR2d } from "./devices/LiDAR2d";
import { LiDAR3d } from "./devices/LiDAR3d";
import { PointOptimizer } from "../optimization/PointOptimizer";
import { TriangleOptimizer } from "../optimization/TriangleOptimizer";
import { BigCar } from "./vehicles/BigCar";
import { TrafficScenario } from "./traffic/TrafficScenario";
import { buildRoadNetwork } from "./city/RoadNetwork";
import { LoadRoadsFromGeoJSON } from "./city/CityBuilder";
import { SimulationChrome } from "./overlay/SimulationChrome";
import { EnvironmentEditorChrome } from "./overlay/EnvironmentEditorChrome";
import { isThreeDMode, THREE_D_MODES } from "./viewState";
import { SensorTest } from "./scenes/SensorTest";
import { setupScanCar } from "./vehicles/ScanCar";
import { Q1 } from "./igvc/mini/q1";
import { Q2 } from "./igvc/mini/q2";
import { Q3 } from "./igvc/mini/q3";
import { Q4 } from "./igvc/mini/q4";
import { FI1 } from "./igvc/mini/fi1";
import { FI2 } from "./igvc/mini/fi2";
import { FII1 } from "./igvc/mini/fii1";
import { FIII1 } from "./igvc/mini/fiii1";
import { FIII2 } from "./igvc/mini/fiii2";
import { FIII3 } from "./igvc/mini/fiii3";
import Unit from "../scripting/units/Unit";
import { SparkRenderer } from "@sparkjsdev/spark";
import { BakeHarness } from "./environment/visualization/BakeHarness";
import { BakePath } from "./environment/visualization/BakePath";
import { createDefaultBakeRunConfig } from "./environment/visualization/BakeRunConfig";
import { SplatAccumulator } from "./environment/visualization/SplatAccumulator";
import { EnvironmentSkyManager } from "./skybox/EnvironmentSkyManager";
import { EarthTilesManager } from "./earth/EarthTilesManager";
import { EarthImportController } from "./earth/EarthImportController";
import { SceneLoadingScreen } from "./overlay/SceneLoadingScreen";
import { EditorToolController } from "./editor/tools/EditorToolController";
import { EnvironmentPersistence } from "./environment/EnvironmentPersistence";
import { EnvironmentLoader } from "./environment/EnvironmentLoader";
import { getEnvironmentManifest } from "./environment/EnvironmentCatalogClient";
import { subscribeStorageEvents } from "../client/storageEvents";
import McpLoggingBridge from "../logging/McpLoggingBridge";
import {
    clearLaneHighlights,
    setDeviceVisualsVisible,
    setVehiclesVisible,
} from "./runtimeVisibility";
import { getRunSessionController } from "../simulation/RunSessionController.js";
import { isInteractiveTarget } from "../ui/shortcutUtils";

/** `?mini=q1` | `q2` | `q3` | `q4` | `fi1` | `fi2` | `fii1` | `fiii1` | `fiii2` | `fiii3` (default: q4) */
const MINI_SCENARIOS = {
    q1: Q1,
    q2: Q2,
    q3: Q3,
    q4: Q4,
    fi1: FI1,
    fi2: FI2,
    fii1: FII1,
    fiii1: FIII1,
    fiii2: FIII2,
    fiii3: FIII3
};

const FOLLOW_CAMERA_CONTROL_LOCK = "vehicle-follow-camera";

function publishEnvironmentTelemetry(data, environmentId, manifest, initialSceneState = {}) {
    const telemetry = data.bindings?.()?.signalStore;
    if (!telemetry) return;
    const common = { source: "environment", category: "environment", replayRole: "input", logClass: "core" };
    telemetry.publishSignal("environment.id", environmentId, { ...common, type: "string" });
    telemetry.publishSignal("environment.revision", manifest?.clientRevision ?? null, { ...common, type: "json" });
    telemetry.publishSignal("environment.seed", data.bakeRunConfig?.()?.seed ?? 42, { ...common, type: "int32" });
    telemetry.publishSignal("environment.manifest", manifest || { environmentId }, { ...common, type: "json" });
    telemetry.publishSignal("environment.initialSceneState", initialSceneState, { ...common, type: "json" });
}

async function setupScene(scene, camera, renderer, data) {
    scene.background = new THREE.Color(0x202020);
    const skyManager = new EnvironmentSkyManager({
        scene,
        camera,
        renderer,
        skyState: data.sky(),
        invalidate: () => data.simulation()?.render?.(),
    });
    data.setSkyManager(skyManager);
    await skyManager.setup();

    // add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    // add directional light
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(50, 50, 50);
    scene.add(directionalLight);
    
    // set camera position
    camera.position.set(0, 10, 10);
    camera.lookAt(0, 0, 0);

    console.log("Scene setup complete");
}

/**
 * 
 * @param {THREE.Scene} scene 
 * @param {THREE.Camera} camera 
 * @param {THREE.WebGLRenderer} renderer 
 * @param {Data} data 
 */
function setupControls(scene, camera, renderer, data) {
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 4;
    controls.maxDistance = 10000;
    controls.maxPolarAngle = Math.PI / 2;
    // set camera far plane to 1000
    camera.far = 10000;
    camera.updateProjectionMatrix();

    // add grid helper
    const gridHelper = new THREE.GridHelper(400, 400);
    gridHelper.visible = false;
    scene.add(gridHelper);

    controls.disposeEnvironmentKeys = data.keys().registerKeyDown("g", () => {
        gridHelper.visible = !gridHelper.visible;
    });

    return controls;
}

/**
 * 
 * @param {THREE.Scene} scene 
 * @param {THREE.Camera} camera 
 * @param {THREE.WebGLRenderer} renderer 
 * @param {Data} data 
 */
async function setupOptimizer(scene, camera, renderer, data) {
    // const optimizer = await PointOptimizer.loadFromGLTF("shell/shell.gltf", 0.01);
    
    // optimizer.optimize({
    //     iterations: 1000,
    //     distanceThreshold: 0.01,
    //     minInliers: 15,
    //     clusterEps: 0.3,
    //     clusterMinPts: 5
    // }, 10);
    
    // // Reconstruct visual objects for remaining points (if any are retained)
    // optimizer.constructObjects();
    
    // // Add points and primitives to the scene
    // optimizer.addToScene(scene);
    // optimizer.addPrimitives(scene);
    if (true) return; // todo

    const optimizer = await TriangleOptimizer.loadFromGLTF("shell/shell.gltf", 0.01);
    optimizer.optimize(5.0);
    // optimizer.addToScene(scene);
    const triangles = optimizer.exportTriangles();
    data.objects().addObjects(triangles);
    
    data.objects().scene(scene);
}

/**
 * data
 * @param {Data} data 
 */
function test(scene, camera, data) {
    const sphere = new Sphere(new THREE.Vector3(0,0,0), 0.2);
    data.objects().addObject(sphere);

    // const lidar = new LiDAR2d(
    //     new THREE.Vector3(0, 1, 0),
    //     new THREE.Euler(0, 0, 0),
    //     20,
    //     2,
    //     [0, 360]
    // );

    const lidar = new LiDAR3d(
        new THREE.Vector3(0, 1, 0),
        new THREE.Euler(0, 0, 0),
        20,
        5,
        [0, 360],
        5,
        [-30,30]
    );

    // test lidar
    data.devices().addDevice(lidar);
    

    data.mouse().registerClick((e) => {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);
        if (intersects.length > 0) {
            if (intersects[0].object instanceof THREE.GridHelper) {
                // get intersection point with grid plane
                const point = intersects[0].point;
                point.y = 0; // keep sphere on ground level
                sphere.setPosition(point);

                lidar.setPosition(new THREE.Vector3(point.x, 1, point.z));
            }
        }
    });
}

async function setupTrafficScenario(scene, data) {
    const scenario = await TrafficScenario.load(
        scene,
        data,
        "/scenarios/recorded/NGSIM/Peachtree/USA_Peach-1_1_T-1.xml",
        { autoplay: false }
    );

    data.keys().registerKeyPress("p", () => {
        scenario.togglePlayback();
    });
}

async function tryIthaca(scene, data) {
    // const ground = new THREE.Mesh(
    //     new THREE.PlaneGeometry(22000, 22000),
    //     new THREE.MeshStandardMaterial({
    //         color: 0x5c6f52,
    //         roughness: 1,
    //         metalness: 0,
    //     })
    // );
    // ground.rotation.x = -Math.PI / 2;
    // ground.position.y = -0.02;
    // ground.receiveShadow = true;
    // scene.add(ground);

    LoadRoadsFromGeoJSON(scene, "/geojson/ithaca.geojson");
}

async function setupCity(scene, data) {
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(220, 220),
        new THREE.MeshStandardMaterial({
            color: 0x5c6f52,
            roughness: 1,
            metalness: 0,
        })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    scene.add(ground);


    const vectors = [];

    for (let x = -60; x <= 60; x += 20) {
        for (let z = -60; z <= 60; z += 20) {
            vectors.push([
                `point_${x}_${z}`,
                new THREE.Vector3(x, 0, z)
            ]);
        }
    }

    const vectorMap = new Map(vectors);

    const connections = [
        
    ];

    // make a grid of roads between the points
    for (let x = -60; x <= 60; x += 20) {
        for (let z = -60; z <= 60; z += 20) {
            const current = `point_${x}_${z}`;
            if (x < 60) {
                connections.push([current, `point_${x+20}_${z}`, true]);
            }
            if (z < 60) {
                connections.push([current, `point_${x}_${z+20}`, true]);
            }
        }
    }

    const { roads, intersections } = buildRoadNetwork(null, vectorMap, connections, {
        maxIntersectionDegree: 4,
        roadOptions: {
            laneWidth: 3.5,
            bidirectionalLaneCount: 2,
            oneWayLaneCount: 1,
            shoulderWidth: 0.2,
            laneMarkingWidth: 0.2,
            dashLength: 3.5,
            dashGap: 2.5,
            elevation: 0.015,
            shoulderElevation: 0.008,
            markingElevation: 0.02,
            surfaceColor: 0x2d3034,
            shoulderColor: 0x4d5055,
        },
        intersectionInset: 5,
    });

    data.city().addRoads(roads);
    for (const intersection of intersections) {
        data.city().addIntersection(intersection);
    }

    await data.city().setupRoads(scene);
    await data.city().setupIntersections(scene);


    const boxes = [];

    // add buildings as boxes at each point, with deterministic heights
    const { SeededRNG } = await import("../util/SeededRNG.js");
    const cityRng = new SeededRNG(data.bakeRunConfig?.()?.seed ?? 42);

    for (let x = -60; x <= 40; x += 20) {
        for (let z = -60; z <= 40; z += 20) {
            const height = cityRng.range(5, 25);
            const box = new Box(new THREE.Vector3(x + 10, height/2, z + 10), new THREE.Vector3(10, height, 10));
            box.setTags(["building"]);
            boxes.push(box);
            data.objects().addObject(box);
        }
    }

    
}

/**
 * 
 * @param {THREE.Scene} scene 
 * @param {Data} data 
 * @param {THREE.Camera} camera
 */
async function setupVehicles(scene, data, camera) {
    const disposers = [];
    const car = new BigCar(
        data.vehicles(), 
        new THREE.Vector3(0, 0, 0), 
        new THREE.Euler(0, 0, 0)
    );
    car.telemetryId = "ego";
    await car.addToScene(scene);

    disposers.push(data.keys().registerKeyDown("w", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = 5; // move forward at 5 units/sec
    }));
    disposers.push(data.keys().registerKeyDown("s", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = -5; // move backward at 5 units/sec
    }));
    disposers.push(data.keys().registerKeyUp("w", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = 0; // stop moving forward
    }));
    disposers.push(data.keys().registerKeyUp("s", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = 0; // stop moving backward
    }));

    const STEER_RATE = THREE.MathUtils.degToRad(50);

    disposers.push(data.keys().registerWhileDown("a", (dt) => {
        if (!car.controlsEnabled) return;
        car.steeringAngle += STEER_RATE * dt;
    }));
    disposers.push(data.keys().registerWhileDown("d", (dt) => {
        if (!car.controlsEnabled) return;
        car.steeringAngle -= STEER_RATE * dt;
    }));


    disposers.push(data.client().onUpdate(info => {
        // if (info.name == "/angle") {
        //     // is between -1 and 1
        //     const angle = parseFloat(info.value);
        //     car.steeringAngle = -angle * (30 / 180) * Math.PI; // max steering angle of 30 degrees
        // } else if (info.name == "/forward") {
        //     // boolean
        //     const forward = info.value;
        //     car.velocity.x = forward ? 5 : 0; // move forward at 5 units/sec when true, stop when false
        // }
        // console.log(info)

        if (info.name === "/controls/command") {
            if (data.simulation()?.resolvedRun) return;
            const value = info.value || {};
            const mode = String(value.mode || "velocity");
            const speed = mode === "stop" ? 0 : Number(value.speed || 0);
            const angle = mode === "stop" ? 0 : Number(value.steering_angle || 0);
            car.velocity.x = speed;
            // REP-103 positive-left → Three.js plant steering.
            car.steeringAngle = -angle;
        }
    }));

    let camFollowing = false;
    let following = null;
    const releaseCameraFollow = () => {
        camFollowing = false;
        if (following?.follower) following.follower.camera = null;
        data.settings().enableControls(FOLLOW_CAMERA_CONTROL_LOCK);
        following = null;
    };

    disposers.push(data.keys().registerKeyPress("f", () => {
        camFollowing = !camFollowing;

        if (camFollowing) {
            data.settings().disableControls(FOLLOW_CAMERA_CONTROL_LOCK);

            for (let vehicle of data.vehicles().vehicles) {
                if (vehicle["follower"]) {
                    vehicle.follower.camera = camera;
                    following = vehicle;
                    break;
                }
            }

            if (!following) {
                releaseCameraFollow();
            }
        } else {
            releaseCameraFollow();
        }
    }));
    const dispose = () => {
        releaseCameraFollow();
        disposers.forEach((registeredDispose) => registeredDispose?.());
    };
    dispose.releaseCameraFollow = releaseCameraFollow;
    return dispose;
}

/**
 * @param {Data} data
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {Object} startingState
 */
async function setupSimulationRuntime(data, scene, camera, startingState = {}) {
    const disposeVehicleControls = await setupVehicles(scene, data, camera);

    if (startingState?.startingPosition && startingState?.startingRotation) {
        data.vehicles().vehicles[0].position.copy(startingState.startingPosition);
        data.vehicles().vehicles[0].rotation.copy(startingState.startingRotation);
    }

    data.objects().scene(scene);
    data.vehicles().setup(scene);
    data.devices().setup(scene);

    const sim = data.simulation();
    sim.setModule("baking", false);
    sim.startLoop();
    sim.pause();
    return disposeVehicleControls;
}

/**
 * @param {Data} data
 * @param {THREE.Scene} scene
 */
async function setupEnvironmentRuntime(data, scene, camera, renderer) {
    const sim = data.simulation();
    sim.setModule("vehicles", false);
    sim.setModule("sensors", false);
    sim.setModule("baking", false);
    await sim.setPhysicsEnabled(false);

    data.environment().setToolController(new EditorToolController({
        data,
        scene,
        camera,
        renderer,
    }));

    const earthTilesManager = new EarthTilesManager({
        scene,
        camera,
        renderer,
        invalidate: () => data.simulation()?.render?.(),
    });
    data.setEarthTilesManager(earthTilesManager);
    const earthImportController = new EarthImportController(data, earthTilesManager);
    data.setEarthImportController(earthImportController);

    const editor = data.editor();
    editor.setEarthImportModeEnterHandler(() => earthImportController.onEnterMode());
    editor.setEarthImportModeExitHandler(() => earthImportController.onExitMode());

    const disposeBakeKey = setupBaking(data, scene);
    sim.startLoop();
    sim.pause();
    return disposeBakeKey;

}

async function enterRuntimeMode(runtime, mode) {
    if (runtime.disposed) return;
    const { data, scene, camera, renderer, startingState } = runtime;
    const simulation = data.simulation();

    if (mode === THREE_D_MODES.SIMULATION) {
        data.environment().setToolController(null);
        runtime.disposeEditorInfrastructure?.();
        runtime.disposeEditorInfrastructure = null;
        setVehiclesVisible(data, true);
        setDeviceVisualsVisible(data, true);

        if (!runtime.simulationInitialized) {
            simulation.setModule("vehicles", true);
            simulation.setModule("sensors", true);
            await simulation.setPhysicsEnabled(true);
            if (runtime.disposed) return;
            runtime.disposeSimulationControls = await setupSimulationRuntime(
                data,
                scene,
                camera,
                startingState,
            );
            if (runtime.disposed) {
                runtime.disposeSimulationControls?.();
                simulation.dispose();
                return;
            }
            runtime.simulationInitialized = true;
        } else {
            simulation.setModule("vehicles", true);
            simulation.setModule("sensors", true);
            await simulation.setPhysicsEnabled(true);
            simulation.startLoop();
            simulation.render();
        }
        return;
    }

    simulation.pause();
    runtime.disposeSimulationControls?.releaseCameraFollow?.();
    clearLaneHighlights(data);
    simulation.setModule("vehicles", false);
    simulation.setModule("sensors", false);
    simulation.setModule("baking", false);
    await simulation.setPhysicsEnabled(false);
    if (runtime.disposed) return;
    setVehiclesVisible(data, false);
    setDeviceVisualsVisible(data, false);

    if (!runtime.editorInfrastructureInitialized) {
        runtime.disposeEditorInfrastructure = await setupEnvironmentRuntime(data, scene, camera, renderer);
        if (runtime.disposed) {
            runtime.disposeEditorInfrastructure?.();
            return;
        }
        runtime.editorInfrastructureInitialized = true;
    } else {
        data.environment().setToolController(new EditorToolController({
            data,
            scene,
            camera,
            renderer,
        }));
        runtime.disposeEditorInfrastructure = registerBakeKey(data, data.baking());
    }
}

function queueRuntimeMode(runtime, mode) {
    runtime.modeTransition = runtime.modeTransition
        .catch((error) => {
            if (!runtime.disposed) console.error("Runtime mode transition failed:", error);
        })
        .then(() => enterRuntimeMode(runtime, mode));
    return runtime.modeTransition;
}

/**
 * Register bake harness for environment editor mode.
 * Press "b" to start/stop a sample bake run when a harness is configured.
 *
 * @param {Data} data
 * @param {THREE.Scene} scene
 */
function setupBaking(data, scene) {
    const bakeConfig = data.bakeRunConfig() || createDefaultBakeRunConfig({
        environmentId: "igvc",
        seed: 42,
    });

    if (!data.bakeRunConfig()) {
        data.setBakeRunConfig(bakeConfig);
    }

    const harness = new BakeHarness(data, {
        runId: bakeConfig.runId,
        host: bakeConfig.host,
        deltaDistance: bakeConfig.deltaDistance,
        views: bakeConfig.views,
        passPolicy: bakeConfig.passPolicy,
        maskMinPixels: bakeConfig.maskMinPixels,
        manifest: bakeConfig.toManifest(),
        roundTrip: bakeConfig.roundTrip,
        debug: bakeConfig.debug,
        splat: bakeConfig.splat,
    });

    const samplePath = new BakePath(bakeConfig.pathVertices);
    harness.addPath(samplePath);

    try {
        harness.setup(scene);

        const splatAccumulator = new SplatAccumulator(scene, bakeConfig.splat);
        data.setSplatAccumulator(splatAccumulator);
        //samplePath.display(data);
        data.setBakeHarness(harness);
    } catch (error) {
        harness.dispose();
        data.splats()?.dispose?.();
        data.setSplatAccumulator(null);
        throw error;
    }

    return registerBakeKey(data, harness);
}

function registerBakeKey(data, harness) {
    if (!harness) return null;
    return data.keys().registerKeyPress("b", async () => {
        const sim = data.simulation();
        if (harness.running) {
            harness.stop();
            sim.setModule("baking", false);
            sim.pause();
            console.log("Bake run stopped");
            return;
        }

        await harness.start();
        sim.setModule("baking", true);
        sim.play();
        console.log("Bake run started", harness.runId);
    });
}

export default function TotalScene({
    mode = THREE_D_MODES.SIMULATION,
    visible = true,
    environmentId = "igvc",
    onEnvironmentChange,
    onOpenReplay,
    embeddedViewport = null,
    preservePlaybackWhenHidden = false,
}) {
    const mountRef = useRef(null);
    const keyManagerRef = useRef(new KeyManager());
    const mouseManagerRef = useRef(new MouseManager());
    const runtimeRef = useRef(null);
    const modeRef = useRef(mode);
    const embeddedViewportRef = useRef(embeddedViewport);
    embeddedViewportRef.current = embeddedViewport;

    const [sceneData, setSceneData] = useState(null);
    const [sceneReady, setSceneReady] = useState(false);
    const [loadPhase, setLoadPhase] = useState("atmosphere");
    const [loadError, setLoadError] = useState(null);
    const [loadAttempt, setLoadAttempt] = useState(0);

    useEffect(() => {
        const scene = new THREE.Scene();
        const initialViewport = embeddedViewportRef.current;
        const initialWidth = Math.max(1, Math.round(initialViewport?.width || window.innerWidth));
        const initialHeight = Math.max(1, Math.round(initialViewport?.height || window.innerHeight));
        const camera = new THREE.PerspectiveCamera(75, initialWidth / initialHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({
            antialias: false,
            powerPreference: "high-performance",
            stencil: false,
        });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
        let disposed = false;
        const mountNode = mountRef.current;

         // Set renderer size and append canvas to the referenced div
        renderer.setSize(initialWidth, initialHeight);
        mountNode.appendChild(renderer.domElement);

        const spark = new SparkRenderer({ renderer });

        const data = new Data({ environment: { environmentId } });

        data.keyManager = keyManagerRef.current;
        data.keyManager.attachTelemetry(data.bindings()?.signalStore);
        data.mouseManager = mouseManagerRef.current;
        data.scene = scene;
        data.camera = camera;
        data.renderer = renderer;
        data.spark = spark; // this is for guassian splats
        scene.add(spark);

        const initialize = async () => {
            setLoadError(null);
            setLoadPhase("atmosphere");
            await setupScene(scene, camera, renderer, data);
            if (disposed) return;

            setLoadPhase("scene");
            const controls = setupControls(scene, camera, renderer, data);

            data.simulation().configure({ scene, camera, renderer, controls });

            const bakeConfig = createDefaultBakeRunConfig({
                environmentId,
                seed: 42,
            });
            data.setBakeRunConfig(bakeConfig);

            let startingState = {};

            // await setupOptimizer(scene, camera, renderer, data);
            // BasicScene(data);
            // test(scene, camera, data);
            // await setupScanCar(data, scene);
            // await setupTrafficScenario(scene, data);
            // await tryIthaca(scene, data);
            // await setupCity(scene, data);
            const environmentLoader = new EnvironmentLoader({ data, scene });
            await environmentLoader.load(environmentId);
            // await SensorTest(data, scene);
            // const miniKey =
            //     typeof window !== "undefined"
            //         ? new URLSearchParams(window.location.search).get("mini")
            //         : null;
            // const runMini = MINI_SCENARIOS[miniKey] ?? Q4;
            // startingState = await runMini(scene, data);

            publishEnvironmentTelemetry(data, environmentId, environmentLoader.manifest, startingState);

            if (disposed) return;

            console.log(`Scene initialized (${modeRef.current}), setting data...`);

            setLoadPhase("runtime");
            const environmentPersistence = new EnvironmentPersistence({
                data,
                scene,
                clientRevision: environmentLoader.manifest?.clientRevision,
            });
            environmentPersistence.attach();
            data.simulation().setEnvironmentRuntime({
                loader: environmentLoader,
                persistence: environmentPersistence,
            });
            const runtime = {
                data,
                scene,
                camera,
                renderer,
                controls,
                startingState,
                environmentLoader,
                environmentPersistence,
                simulationInitialized: false,
                editorInfrastructureInitialized: false,
                disposeEditorInfrastructure: null,
                disposeSimulationControls: null,
                disposed: false,
                modeTransition: Promise.resolve(),
            };
            runtimeRef.current = runtime;
            await queueRuntimeMode(runtime, modeRef.current);

            if (disposed) return;

            setSceneData(data);
            setSceneReady(true);
        };

        initialize().catch((error) => {
            console.error("Could not initialize the 3D environment:", error);
            if (!disposed) {
                setLoadError(error?.message ?? "The environment could not be loaded.");
                setSceneReady(false);
            }
        });


        // --- 4. Handle Window Resize (Optional but Recommended) ---
        const handleResize = () => {
            const viewport = embeddedViewportRef.current;
            const width = Math.max(1, Math.round(viewport?.width || window.innerWidth));
            const height = Math.max(1, Math.round(viewport?.height || window.innerHeight));
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
            data.skyManager()?.resize?.(width, height);
            data.simulation()?.render?.();
        };
        window.addEventListener('resize', handleResize);


        // --- 5. Cleanup Function ---
        return () => {
            disposed = true;
            setSceneReady(false);
            setSceneData(null);

            // Flush a final environment save and detach autosave listeners.
            const runtime = runtimeRef.current;
            if (runtime) runtime.disposed = true;
            runtime?.environmentPersistence?.dispose();
            runtime?.disposeEditorInfrastructure?.();
            runtime?.disposeSimulationControls?.();
            runtimeRef.current = null;

            data.baking()?.dispose?.();
            data.setBakeHarness(null);
            data.splats()?.dispose?.();
            data.setSplatAccumulator(null);

            data.simulation().dispose();
            data.client()?.dispose?.();
            data.environment().dispose();
            data.earthImportController()?.dispose?.();
            data.setEarthImportController(null);
            data.earthTilesManager()?.dispose?.();
            data.setEarthTilesManager(null);
            data.skyManager()?.dispose?.();
            data.setSkyManager(null);

            if (mountNode.contains(renderer.domElement)) {
                mountNode.removeChild(renderer.domElement);
            }

            window.removeEventListener('resize', handleResize);
            data.simulation()?.controls?.disposeEnvironmentKeys?.();
            renderer.dispose();
        };
    }, [environmentId, loadAttempt]);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (!runtime) return;
        const width = Math.max(1, Math.round(embeddedViewport?.width || window.innerWidth));
        const height = Math.max(1, Math.round(embeddedViewport?.height || window.innerHeight));
        runtime.camera.aspect = width / height;
        runtime.camera.updateProjectionMatrix();
        runtime.renderer.setSize(width, height);
        runtime.data.skyManager()?.resize?.(width, height);
        runtime.data.simulation()?.render?.();
    }, [embeddedViewport, sceneReady]);

    // Live-sync: when an MCP agent writes the active environment, re-apply it.
    useEffect(() => {
        if (!sceneReady) return undefined;

        return subscribeStorageEvents((event) => {
            if (event.domain !== "environment") return;
            if (event.id && event.id !== environmentId) return;

            const runtime = runtimeRef.current;
            if (!runtime || runtime.disposed) return;
            // A configured run owns a frozen environment document. Live storage
            // updates are applied after the scene is recreated or a new run is
            // resolved, never in the middle of deterministic execution.
            if (runtime.data.simulation?.()?.resolvedRun) return;

            const persistence = runtime.environmentPersistence;
            const loader = runtime.environmentLoader;
            if (!loader) return;

            (async () => {
                try {
                    persistence?.suspendAutosave();
                    const manifest = await getEnvironmentManifest(environmentId);
                    if (!manifest || runtime.disposed) return;
                    loader.apply(manifest);
                    loader.manifest = manifest;
                    publishEnvironmentTelemetry(runtime.data, environmentId, manifest, runtime.startingState);
                    persistence?.adoptClientRevision(manifest.clientRevision);
                } catch (error) {
                    console.warn("[environment] MCP live-sync apply failed:", error);
                } finally {
                    persistence?.resumeAutosave();
                }
            })();
        });
    }, [sceneReady, environmentId]);

    useEffect(() => {
        modeRef.current = mode;
        const runtime = runtimeRef.current;
        if (!runtime) return;

        let cancelled = false;
        queueRuntimeMode(runtime, mode)
            .then(() => {
                if (!cancelled) setSceneReady(true);
            })
            .catch((error) => {
                console.error(`Could not enter ${mode} mode:`, error);
                if (!cancelled) setSceneReady(true);
            });

        return () => {
            cancelled = true;
        };
    }, [mode]);

    useEffect(() => {
        // Both Simulation and Environment Editor need the shared render loop and orbit.
        runtimeRef.current?.data?.simulation?.()?.setWorkspaceActive?.(
            visible && isThreeDMode(mode),
            { preservePlayback: preservePlaybackWhenHidden },
        );
        if (!visible) keyManagerRef.current.releaseAll?.();
    }, [mode, preservePlaybackWhenHidden, visible, sceneReady]);

    useEffect(() => {
        if (!sceneData) return undefined;
        return getRunSessionController().attachData(sceneData);
    }, [sceneData]);

    useEffect(() => {
        const kd = (e) => {
            if (!visible || embeddedViewportRef.current || isInteractiveTarget(e.target)) return;
            keyManagerRef.current.onKeyDown(e);
        };
        const ku = (e) => {
            if (!visible || embeddedViewportRef.current) return;
            keyManagerRef.current.onKeyUp(e);
        };
        
        const kp = (e) => {
            if (!visible || embeddedViewportRef.current || isInteractiveTarget(e.target)) return;
            keyManagerRef.current.onKeyPress(e);
        };

        const release = () => keyManagerRef.current.releaseAll?.();

        window.addEventListener("keydown", kd);
        window.addEventListener("keyup", ku);
        window.addEventListener("keypress", kp);
        window.addEventListener("sf:release-held-keys", release);
        
        return () => {
            window.removeEventListener("keydown", kd);
            window.removeEventListener("keyup", ku);
            window.removeEventListener("keypress", kp);
            window.removeEventListener("sf:release-held-keys", release);
        };
    }, [visible]);

    useEffect(() => {
        const mm = mouseManagerRef.current;
        const md = (e) => {
            if (!visible || embeddedViewportRef.current) return;
            mm.handleDown(e);
        };
        const mu = (e) => {
            if (!visible || embeddedViewportRef.current) return;
            mm.handleUp(e);
        };
        const mmove = (e) => {
            if (!visible || embeddedViewportRef.current) return;
            mm.handleMove(e);
        };

        const mc = (e) => {
            if (!visible || embeddedViewportRef.current) return;
            mm.handleClick(e);
        }
        
        window.addEventListener("mousedown", md);
        window.addEventListener("mouseup", mu);
        window.addEventListener("mousemove", mmove);
        window.addEventListener("click", mc);
        return () => {
            window.removeEventListener("mousedown", md);
            window.removeEventListener("mouseup", mu);
            window.removeEventListener("mousemove", mmove);
            window.removeEventListener("click", mc);
        };
    }, [visible])

    const embedded = Boolean(embeddedViewport);
    const viewportStyle = embedded
        ? {
            top: `${Math.round(embeddedViewport.top)}px`,
            left: `${Math.round(embeddedViewport.left)}px`,
            width: `${Math.max(1, Math.round(embeddedViewport.width))}px`,
            height: `${Math.max(1, Math.round(embeddedViewport.height))}px`,
        }
        : undefined;

    return (
        <>
        <SceneLoadingScreen
            visible={visible && !sceneReady && !embedded}
            mode={mode}
            phase={loadPhase}
            error={loadError}
            onRetry={() => {
                setLoadError(null);
                setLoadAttempt((attempt) => attempt + 1);
            }}
        />
        {sceneReady && sceneData && <McpLoggingBridge data={sceneData} onOpenReplay={onOpenReplay} />}
        {!embedded && <div
                id="overlay"
                className={`fixed inset-0 z-20 select-none bg-transparent ${visible ? "pointer-events-none visible" : "pointer-events-none invisible"}`}
                aria-hidden={!sceneReady || !visible}
            >
                {visible && sceneReady && mode === THREE_D_MODES.SIMULATION && (
                    <SimulationChrome data={sceneData} onOpenReplay={onOpenReplay} />
                )}
                {visible && sceneReady && mode === THREE_D_MODES.ENVIRONMENT && (
                    <EnvironmentEditorChrome
                        data={sceneData}
                        activeEnvironmentId={environmentId}
                        onEnvironmentChange={onEnvironmentChange}
                    />
                )}
            </div>}
        <div
            id="canvas-container"
            className={`fixed ${embedded ? "z-[2] overflow-hidden rounded-[var(--radius)] border border-white/10" : "inset-0 z-0 h-[100dvh] w-[100vw]"} transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] ${sceneReady && visible ? "block visible opacity-100" : "hidden pointer-events-none opacity-0"}`}
            style={viewportStyle}
            ref={mountRef}
            role={embedded ? "region" : undefined}
            aria-hidden={!sceneReady || !visible}
            aria-label={embedded ? "Scenario diagnostics 3D viewport" : undefined}
        />
        </>
    )
}
