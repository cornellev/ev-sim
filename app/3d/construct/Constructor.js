import { useEffect, useRef, useState } from "react";
import { MovableControls } from "./Movable";
import { Html, Hud } from "@react-three/drei";
import DigitalCamera from "./device/DigitalCamera";
import { useFrame } from "@react-three/fiber";


export default function VehicleConstructor({ orbitRef }) {
    const [selectedPart, setSelectedPart] = useState(null);
    const [CurrentOverlay, setCurrentOverlay] = useState(null);
    const [CurrentMesh, setCurrentMesh] = useState(null);
    const [constructorObjects, setConstructorObjects] = useState([
        new DigitalCamera()
    ]);

    const [htmlPos, setHtmlPos] = useState([0, 0, 0]);
    const [lastRun, setLastRun] = useState(0);

    const currentObj = useRef(null);

    const disableOrbit = () => {
        if (orbitRef && orbitRef.current) {
            orbitRef.current.enabled = false;
        }
    }

    const enableOrbit = () => {
        if (orbitRef && orbitRef.current) {
            orbitRef.current.enabled = true;
        }
    }

    // useEffect(() => {
    //     const device = new DigitalCamera();
    //     setSelectedPart(device);
    // }, [])

    useEffect(() => {
        if (selectedPart === null) {
            setCurrentOverlay(null);
            return;
        }
        setCurrentOverlay(() => selectedPart.overlayConstructor());
    }, [selectedPart])
    
    useEffect(() => {
        if (selectedPart === null) {
            setCurrentMesh(null);
            currentObj.current = null;
            return;
        }
        setCurrentMesh(() => selectedPart.meshContructor());
    }, [selectedPart])

    const onPosChange = (newPos) => {
        if (Date.now() - lastRun < 10) return;
        setLastRun(Date.now()); // prevent max stack issues.
        if (selectedPart && currentObj.current) {
            selectedPart.setPosition(newPos.x, newPos.y, newPos.z);
            currentObj.current.position.set(newPos.x, newPos.y, newPos.z);
            setHtmlPos([newPos.x, newPos.y, newPos.z]);
        }
    }

    const onSelectObj = (index) => {
        setSelectedPart(constructorObjects[index]);
        setConstructorObjects(prev => {
            const newArr = [...prev];
            newArr.splice(index, 1);
            return newArr;
        });
    }

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                if (selectedPart) {
                    setConstructorObjects(prev => [...prev, selectedPart]);
                    setSelectedPart(null);
                }
            }
        }

        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("keydown", onKeyDown);
        }
    }, [selectedPart, constructorObjects])

    // check for shift-a
    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key === "A" && event.shiftKey) {
                console.log("adding digital camera");
                const device = new DigitalCamera();
                setConstructorObjects(prev => [...prev, device]);
            }
        }

        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("keydown", onKeyDown);
        }
    }, [constructorObjects])

    return (
        <>
        <Html position={currentObj.current ? [htmlPos[0], htmlPos[1] - 0.5, htmlPos[2]] : [0, 0, 0]}>
            <div className="fixed top-4 left-4 z-10">
                {CurrentOverlay && (
                    <CurrentOverlay
                        disableOrbit={disableOrbit}
                        enableOrbit={enableOrbit}
                    />
                )}
            </div>
        </Html>
        { selectedPart && CurrentMesh && <MovableControls origin={selectedPart.getPosition()} onStart={disableOrbit} onEnd={enableOrbit} onChange={onPosChange} /> }
        { selectedPart && CurrentMesh && <CurrentMesh position={selectedPart.getPosition()} objectRef={currentObj} selected /> }
        {
            constructorObjects.map((obj, index) => {
                if (obj === null) return null;

                const MeshComp = obj.meshContructor();
                return <MeshComp key={index} position={obj.getPosition()} objectRef={null} selected={false} index={index} onSelected={onSelectObj} />
            })
        }
        </>
    )
}