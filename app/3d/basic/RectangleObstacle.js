
export default function RectangleObstacle({ location=[0,0,0], width=1, height=1, depth=1 }) {
    return (
        <mesh position={location}>
            <boxGeometry args={[width, height, depth]} />
            <meshStandardMaterial color="red" />
        </mesh>
    )
}