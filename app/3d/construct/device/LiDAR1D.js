

export default class LiDAR1D extends Device {
    constructor() {
        super("LiDAR 1D", {
            range: 100,
            fov: 30,
            resolution: 1
        });
    }

    getMesh({ position, objectRef, selected, onSelected, index }) {
        const raycast = (event) => {
            event.stopPropagation();
            if (onSelected) onSelected(index);
        }

        return (
            <mesh position={[position.x, position.y, position.z]} ref={objectRef} {...(selected && onSelected ? {} : { onClick: raycast })}>
                {/* { selected && <Outlines color={{r: 242, g: 204, b: 36}} transparent={false} thickness={5} /> } */}
                <coneGeometry args={[0.2, 0.5, 32]} />
                <meshStandardMaterial color={selected ? '#f2cc24' : '#aaaaaa'} />
            </mesh>
        )
    }
}