import { MovableControls } from "./Movable";


export default function VehicleConstructor({ orbitRef }) {
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

    return (
        <>
        <MovableControls origin={{ x: 0, y: 0, z: 0}} onStart={disableOrbit} onEnd={enableOrbit} />
        </>
    )
}