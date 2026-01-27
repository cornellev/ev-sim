import * as THREE from "three";
import { useEffect, useRef, useState } from "react";


export function MovableControls({ origin = { x: 0, y: 0, z: 0 }, onChange = (pos) => {}, onStart = () => {}, onEnd = () => {} }) {
    const [position, setPosition] = useState(origin);
    const [selectedAxis, setSelectedAxis] = useState(null);
    const [hoveredAxis, setHoveredAxis] = useState(null);

    const isDraggingRef = useRef(false);
    const selectedAxisRef = useRef(null);
    const previousMousePosition = useRef({ x: 0, y: 0 });

    const onChangeRef = useRef(onChange);
    const onStartRef = useRef(onStart);
    const onEndRef = useRef(onEnd);

    const xRef = useRef();
    const yRef = useRef();
    const zRef = useRef();

    useEffect(() => {
        if (xRef.current && yRef.current && zRef.current) {
            const w = 50;

            // make lines thicker
            xRef.current.line.material.linewidth = w;
            yRef.current.line.material.linewidth = w;
            zRef.current.line.material.linewidth = w;
            console.log("Set line widths")
        }
    }, [xRef, yRef, zRef]);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        onStartRef.current = onStart;
    }, [onStart]);

    useEffect(() => {
        onEndRef.current = onEnd;
    }, [onEnd]);

    useEffect(() => {
        onChangeRef.current(position);
    }, [position]);

    useEffect(() => {
        setPosition((prev) => {
            const next = { x: origin.x, y: origin.y, z: origin.z };
            if (prev && prev.x === next.x && prev.y === next.y && prev.z === next.z) {
                return prev;
            }
            return next;
        });
    }, [origin.x, origin.y, origin.z]);

    const applyPointerMovement = (clientX, clientY) => {
        if (!isDraggingRef.current || !selectedAxisRef.current) return;

        const deltaX = clientX - previousMousePosition.current.x;
        const deltaY = clientY - previousMousePosition.current.y;
        const movementScale = 0.01;

        setPosition((prev) => {
            const newPos = { ...prev };
            const axis = selectedAxisRef.current;

            if (axis === "x") {
                newPos.x += deltaX * movementScale;
            } else if (axis === "y") {
                newPos.y -= deltaY * movementScale;
            } else if (axis === "z") {
                newPos.z += deltaY * movementScale;
            }
            return newPos;
        });

        previousMousePosition.current = { x: clientX, y: clientY };
    };

    const handlePointerDown = (axis) => (event) => {
        // make sure it's not a right click
        if (event.button !== 0) return;

        event.stopPropagation();
        setSelectedAxis(axis);
        selectedAxisRef.current = axis;
        isDraggingRef.current = true;
        previousMousePosition.current = { x: event.clientX, y: event.clientY };
        onStartRef.current();
    };

    const handlePointerUp = (event) => {
        event.stopPropagation();
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        selectedAxisRef.current = null;
        setSelectedAxis(null);
        onEndRef.current();
    };

    const handlePointerOver = (axis) => (event) => {
        event.stopPropagation();
        setHoveredAxis(axis);
    };

    const handlePointerOut = (event) => {
        event.stopPropagation();
        setHoveredAxis((prev) => (isDraggingRef.current ? prev : null));
    };

    useEffect(() => {
        const handlePointerMoveGlobal = (event) => {
            if (!isDraggingRef.current) return;
            applyPointerMovement(event.clientX, event.clientY);
        };

        const handlePointerUpGlobal = () => {
            if (!isDraggingRef.current) return;
            isDraggingRef.current = false;
            selectedAxisRef.current = null;
            setSelectedAxis(null);
            onEndRef.current();
        };

        window.addEventListener("pointermove", handlePointerMoveGlobal);
        window.addEventListener("pointerup", handlePointerUpGlobal);

        return () => {
            window.removeEventListener("pointermove", handlePointerMoveGlobal);
            window.removeEventListener("pointerup", handlePointerUpGlobal);
        };
    }, []);

    // three arrows to move along x, y, z axes
    const getArrowVisual = (axis) => {
        const baseColors = {
            x: 0xff4444,
            y: 0x44ff44,
            z: 0x4444ff,
        };

        const hoverColors = {
            x: 0xff7777,
            y: 0x77ff77,
            z: 0x7777ff,
        };

        const selectedColors = {
            x: 0xffaaaa,
            y: 0xaaffaa,
            z: 0xaaaaff,
        };

        let color = baseColors[axis];
        let length = 1;

        if (axis === selectedAxis) {
            color = selectedColors[axis];
            length = 1.4;
        } else if (axis === hoveredAxis) {
            color = hoverColors[axis];
            length = 1.2;
        }

        return { color, length };
    };

    const xVisual = getArrowVisual("x");
    const yVisual = getArrowVisual("y");
    const zVisual = getArrowVisual("z");

    return (
        <>
        <mesh
            position={[position.x, position.y, position.z]}
            onPointerDown={handlePointerDown('x')}
            onPointerUp={handlePointerUp}
            onPointerOver={handlePointerOver('x')}
            onPointerOut={handlePointerOut}
        >
            <arrowHelper args={[new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), xVisual.length, xVisual.color]} ref={xRef} />
        </mesh>
        <mesh
            position={[position.x, position.y, position.z]}
            onPointerDown={handlePointerDown('y')}
            onPointerUp={handlePointerUp}
            onPointerOver={handlePointerOver('y')}
            onPointerOut={handlePointerOut}
        >
            <arrowHelper args={[new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), yVisual.length, yVisual.color]} ref={yRef} />
        </mesh>
        <mesh
            position={[position.x, position.y, position.z]}
            onPointerDown={handlePointerDown('z')}
            onPointerUp={handlePointerUp}
            onPointerOver={handlePointerOver('z')}
            onPointerOut={handlePointerOut}
        >
            <arrowHelper args={[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), zVisual.length, zVisual.color]} ref={zRef} />
        </mesh>
        </>
    )
}