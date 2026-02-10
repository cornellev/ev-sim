import Unit from "./Unit";

export function ROSInputUnit({ _uuid }) {
    return (
        <Unit title="ROS Input" hasOptions={true} _uuid={_uuid}
        inputs={[]} 
        outputs={
            [
                {label: "ros topics", type: "caption"},
                {label: "some float64", type: "float64"},
                {label: "some int32", type: "int32"}
            ]
        }>
            test
        </Unit>
    )
}

export function ROSOutputUnit({ _uuid }) {
    return (
        <Unit title="ROS Output" hasOptions={true} _uuid={_uuid}
        inputs={
            [
                {label: "ros topics", type: "caption"},
                {label: "some lidar", type: "tex2"},
            ]
        }
        outputs={[]}>
            test
        </Unit>
    )
}