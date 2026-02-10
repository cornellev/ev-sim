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
import { DeviceOverlay } from "./devices/Device";

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
    camera.position.set(0, 50, 100);
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
    controls.minDistance = 10;
    controls.maxDistance = 500;
    controls.maxPolarAngle = Math.PI / 2;

    function controlLoop() {
        requestAnimationFrame(controlLoop);
        if (data.settings().cameraControlsEnabled) controls.update();
        renderer.render(scene, camera);
    }
    controlLoop();

    // add grid helper
    const gridHelper = new THREE.GridHelper(400, 100);
    scene.add(gridHelper);

    data.keys().registerKeyDown("g", (e) => {
        gridHelper.visible = !gridHelper.visible;
    });
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

export default function TotalScene() {
    const mountRef = useRef(null);
    const keyManagerRef = useRef(new KeyManager());
    const mouseManagerRef = useRef(new MouseManager());
    const _data = useRef(null);

    const [selectedDevice, setSelectedDevice] = useState(null);

    useEffect(() => {
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({ antialias: true });

         // Set renderer size and append canvas to the referenced div
        renderer.setSize(window.innerWidth, window.innerHeight);
        mountRef.current.appendChild(renderer.domElement);

        const data = new Data();

        _data.current = data;

        data.keyManager = keyManagerRef.current;
        data.mouseManager = mouseManagerRef.current;
        data.scene = scene;
        data.camera = camera;
        data.renderer = renderer;
        
        // --- 3. Setup Scene, Camera, Renderer, Controls, and Objects ---
        
        setupScene(scene, camera, renderer);
        setupControls(scene, camera, renderer, data);
        BasicScene(data);
        test(scene, camera, data);
        data.objects().scene(scene);
        data.devices().setup(scene);
        

        // --- 4. Handle Window Resize (Optional but Recommended) ---
        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);
        setSelectedDevice(data.devices().devices[0]);


        // --- 5. Cleanup Function ---
        return () => {
            mountRef.current.removeChild(renderer.domElement);
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

        window.addEventListener("keydown", kd);
        window.addEventListener("keyup", ku);
        
        return () => {
            window.removeEventListener("keydown", kd);
            window.removeEventListener("keyup", ku);
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
            {_data.current && selectedDevice && <DeviceOverlay device={selectedDevice} data={_data.current} />}
        </div>
        <div id="canvas-container" className="w-[100vw] h-[100vh]" ref={mountRef}>
            
        </div>
        </>
    )
}