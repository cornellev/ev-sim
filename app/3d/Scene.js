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
import { setupIGVC } from "./igvc/IGVCScene";
import { SimulationMenu } from "./overlay/SimulationMenu";
import { VehicleOverlay } from "./overlay/VehicleOverlay";
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
import { Skybox } from "./skybox/Skybox";

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

function setupScene(scene, camera, renderer) {
    //set background color
    scene.background = new THREE.Color(0x202020);
    Skybox(scene, renderer);
    
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

    data.keys().registerKeyDown("g", (e) => {
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
    const car = new BigCar(
        data.vehicles(), 
        new THREE.Vector3(0, 0, 0), 
        new THREE.Euler(0, 0, 0)
    );
    await car.addToScene(scene);

    data.keys().registerKeyDown("w", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = 5; // move forward at 5 units/sec
    });
    data.keys().registerKeyDown("s", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = -5; // move backward at 5 units/sec
    });
    data.keys().registerKeyUp("w", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = 0; // stop moving forward
    });
    data.keys().registerKeyUp("s", () => {
        if (!car.controlsEnabled) return;
        car.velocity.x = 0; // stop moving backward
    });

    const STEER_RATE = THREE.MathUtils.degToRad(50);

    data.keys().registerWhileDown("a", (dt) => {
        if (!car.controlsEnabled) return;
        car.steeringAngle += STEER_RATE * dt;
    });
    data.keys().registerWhileDown("d", (dt) => {
        if (!car.controlsEnabled) return;
        car.steeringAngle -= STEER_RATE * dt;
    });


    data.client().onUpdate(info => {
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

        if (info.name == "/ackdrive") {
            const raw_speed = info.value.speed; // mph
            const raw_angle = info.value.steering_angle; // degrees
            const speed = raw_speed * 0.44704; // convert to m/s
            const angle = raw_angle * (Math.PI / 180); // convert to radians

            car.velocity.x = speed;
            car.steeringAngle = -angle; // invert angle if necessary based on your coordinate system
        }
    })

    let camFollowing = false;
    let following = null;

    data.keys().registerKeyPress("f", () => {
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
                camFollowing = false;
                data.settings().enableControls(FOLLOW_CAMERA_CONTROL_LOCK);
            }
        } else {
            if (following && following.follower) {
                following.follower.camera = null;
            }

            data.settings().enableControls(FOLLOW_CAMERA_CONTROL_LOCK);
            following = null;
        }
    });
}

/**
 * Register an optional bake harness behind the explicit baking module toggle.
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
    });

    const samplePath = new BakePath(bakeConfig.pathVertices);
    samplePath.display(data);

    harness.addPath(samplePath);
    harness.setup(scene);
    data.setBakeHarness(harness);

    data.keys().registerKeyPress("b", async () => {
        if (harness.running) {
            harness.stop();
            data.simulation().setModule("baking", false);
            console.log("Bake run stopped");
            return;
        }

        await harness.start();
        data.simulation().setModule("baking", true);
        console.log("Bake run started", harness.runId);
    });
}

export default function TotalScene() {
    const mountRef = useRef(null);
    const keyManagerRef = useRef(new KeyManager());
    const mouseManagerRef = useRef(new MouseManager());

    const [sceneData, setSceneData] = useState(null);
    const [vehicleOverlayVisible, setVehicleOverlayVisible] = useState(true);

    useEffect(() => {
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        let disposed = false;
        const mountNode = mountRef.current;

         // Set renderer size and append canvas to the referenced div
        renderer.setSize(window.innerWidth, window.innerHeight);
        mountNode.appendChild(renderer.domElement);

        const spark = new SparkRenderer({ renderer });

        const data = new Data();

        data.keyManager = keyManagerRef.current;
        data.mouseManager = mouseManagerRef.current;
        data.scene = scene;
        data.camera = camera;
        data.renderer = renderer;
        data.spark = spark; // this is for guassian splats

        const initialize = async () => {
            setupScene(scene, camera, renderer);
            const controls = setupControls(scene, camera, renderer, data);

            data.simulation().configure({ scene, camera, renderer, controls });

            const bakeConfig = createDefaultBakeRunConfig({
                environmentId: "igvc",
                seed: 42,
            });
            data.setBakeRunConfig(bakeConfig);

            let startingState = {};

            // await setupOptimizer(scene, camera, renderer, data);
            // BasicScene(data);
            // test(scene, camera, data);
            await setupVehicles(scene, data, camera);
            // await setupScanCar(data, scene);

            // await setupTrafficScenario(scene, data);

            // await tryIthaca(scene, data);

            // await setupCity(scene, data);
            await setupIGVC(scene, data);
            // await SensorTest(data, scene);
            // const miniKey =
            //     typeof window !== "undefined"
            //         ? new URLSearchParams(window.location.search).get("mini")
            //         : null;
            // const runMini = MINI_SCENARIOS[miniKey] ?? Q4;
            // startingState = await runMini(scene, data);

            if (startingState && startingState["startingPosition"] && startingState["startingRotation"]) {
                // startingState["s/tingRotation"].y = 0; // ensure car starts on ground level
                // copy to big car
                data.vehicles().vehicles[0].position.copy(startingState["startingPosition"]);
                data.vehicles().vehicles[0].rotation.copy(startingState["startingRotation"]);
            }

            // add spheres at (0,0,1) and (1,0,0) for reference
            // data.objects().addObject(sphere1);
            // data.objects().addObject(sphere2);

            if (disposed) return;


            console.log("Scene initialized, setting data...");

            data.objects().scene(scene);
            data.vehicles().setup(scene);
            data.devices().setup(scene);
            setupBaking(data, scene);

            data.simulation().startLoop();
            data.simulation().play();

            setSceneData(data);
        };

        initialize();


        // --- 4. Handle Window Resize (Optional but Recommended) ---
        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);


        // --- 5. Cleanup Function ---
        return () => {
            disposed = true;

            data.simulation().dispose();

            if (mountNode.contains(renderer.domElement)) {
                mountNode.removeChild(renderer.domElement);
            }

            window.removeEventListener('resize', handleResize);
            renderer.dispose();
        };
    }, []);

    useEffect(() => {
        const kd = (e) => {
            keyManagerRef.current.onKeyDown(e);
        };
        const ku = (e) => {
            keyManagerRef.current.onKeyUp(e);
        };
        
        const kp = (e) => {
            keyManagerRef.current.onKeyPress(e);
        };

        window.addEventListener("keydown", kd);
        window.addEventListener("keyup", ku);
        window.addEventListener("keypress", kp);
        
        return () => {
            window.removeEventListener("keydown", kd);
            window.removeEventListener("keyup", ku);
            window.removeEventListener("keypress", kp);
        };
    }, []);

    useEffect(() => {
        const mm = mouseManagerRef.current;
        const md = (e) => {
            mm.handleDown(e);
        };
        const mu = (e) => {
            mm.handleUp(e);
        };
        const mmove = (e) => {
            mm.handleMove(e);
        };

        const mc = (e) => {
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
    }, [])

    return (
        <>
        <div id="overlay" className="fixed w-[100vw] h-[100vh] top-0 left-0 select-none pointer-events-none bg-transparent">
            {/* Overlay content can go here */}
            {sceneData && vehicleOverlayVisible && <VehicleOverlay data={sceneData} />}
            <SimulationMenu
                data={sceneData}
                vehicleOverlayVisible={vehicleOverlayVisible}
                onVehicleOverlayVisibleChange={setVehicleOverlayVisible}
            />
        </div>
        <div id="canvas-container" className="w-[100vw] h-[100vh]" ref={mountRef}>
            
        </div>
        </>
    )
}