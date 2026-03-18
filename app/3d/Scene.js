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

function setupScene(scene, camera, renderer) {
    //set background color
    scene.background = new THREE.Color(0x202020);
    
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

    // render loop
    function animate() {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    }
    animate();

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

    function controlLoop() {
        requestAnimationFrame(controlLoop);
        if (data.settings().cameraControlsEnabled) controls.update();
        renderer.render(scene, camera);
    }
    controlLoop();

    // add grid helper
    const gridHelper = new THREE.GridHelper(400, 400);
    gridHelper.visible = false;
    scene.add(gridHelper);

    data.keys().registerKeyDown("g", (e) => {
        gridHelper.visible = !gridHelper.visible;
    });

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

    buildRoadNetwork(scene, vectorMap, connections, {
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


    const boxes = [];

    // add buildings as boxes at each point, with random heights
    for (let x = -60; x <= 40; x += 20) {
        for (let z = -60; z <= 40; z += 20) {
            const height = Math.random() * 20 + 5;
            const box = new Box(new THREE.Vector3(x + 10, height/2, z + 10), new THREE.Vector3(10, height, 10));
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
        car.velocity.x = 5; // move forward at 5 units/sec
    });
    data.keys().registerKeyDown("s", () => {
        car.velocity.x = -5; // move backward at 5 units/sec
    });
    data.keys().registerKeyUp("w", () => {
        car.velocity.x = 0; // stop moving forward
    });
    data.keys().registerKeyUp("s", () => {
        car.velocity.x = 0; // stop moving backward
    });

    data.keys().registerWhileDown("a", () => {
        car.steeringAngle += (5 / 180) * Math.PI; // turn left by 1 degree
    });
    data.keys().registerWhileDown("d", () => {
        car.steeringAngle -= (5 / 180) * Math.PI; // turn right by 1 degree
    });

    let camFollowing = false;
    let following = null;

    data.keys().registerKeyPress("f", () => {
        camFollowing = !camFollowing;

        if (camFollowing) {
            data.settings().disableControls();

            for (let vehicle of data.vehicles().vehicles) {
                if (vehicle["follower"]) {
                    vehicle.follower.camera = camera;
                    following = vehicle;
                    break;
                }
            }
        } else {
            if (following && following.follower) {
                following.follower.camera = null;
            }

            data.settings().enableControls();
            following = null;
        }
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

        const data = new Data();

        data.keyManager = keyManagerRef.current;
        data.mouseManager = mouseManagerRef.current;
        data.scene = scene;
        data.camera = camera;
        data.renderer = renderer;

        const initialize = async () => {
            setupScene(scene, camera, renderer);
            setupControls(scene, camera, renderer, data);
            // await setupOptimizer(scene, camera, renderer, data);
            // BasicScene(data);
            // test(scene, camera, data);
            await setupVehicles(scene, data, camera);

            // await setupTrafficScenario(scene, data);

            // await tryIthaca(scene, data);

            // await setupCity(scene, data);

            await setupIGVC(scene, data);

            if (disposed) return;

            data.objects().scene(scene);
            data.vehicles().setup(scene);
            data.devices().setup(scene);
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
            mountNode.removeChild(renderer.domElement);
            window.removeEventListener('resize', handleResize);
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