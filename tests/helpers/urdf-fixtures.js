/** Shared URDF documents for the VEH-06 adapter tests. */

const encoder = new TextEncoder();

export function urdfBytes(text) {
    return encoder.encode(text);
}

export function urdfPackage(entryPath, files) {
    return {
        entryPath,
        files: files.map((file) => ({
            path: file.path,
            bytes: typeof file.bytes === "string" ? urdfBytes(file.bytes) : file.bytes,
        })),
    };
}

export function triangleStl(vertices, normal = [0, 0, 1]) {
    const stl = new Uint8Array(84 + 50);
    const view = new DataView(stl.buffer);
    view.setUint32(80, 1, true);
    normal.forEach((value, axis) => view.setFloat32(84 + axis * 4, value, true));
    vertices.forEach((vertex, index) => {
        vertex.forEach((value, axis) => view.setFloat32(84 + 12 + index * 12 + axis * 4, value, true));
    });
    return stl;
}

function wheelJoints({
    id,
    link,
    xyz,
    spinAxis,
    steer = false,
    lower = -0.4,
    upper = 0.4,
}) {
    const spin = `
  <link name="${link}">
    <visual>
      <origin xyz="0 0 0" rpy="-1.5707963267948966 0 0"/>
      <geometry><cylinder radius="0.25" length="0.15"/></geometry>
    </visual>
  </link>
  <joint name="${id}_spin" type="continuous">
    <parent link="${steer ? `${id}_steer` : "base_link"}"/>
    <child link="${link}"/>
    <origin xyz="${steer ? "0 0 0" : xyz}" rpy="0 0 0"/>
    <axis xyz="${spinAxis}"/>
  </joint>`;
    if (!steer) return spin;
    return `
  <link name="${id}_steer"/>
  <joint name="${id}_steer" type="revolute">
    <parent link="base_link"/>
    <child link="${id}_steer"/>
    <origin xyz="${xyz}" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="${lower}" upper="${upper}" effort="10" velocity="1"/>
  </joint>
  ${spin}`;
}

/**
 * Four-wheel robot. Front wheels steer about ROS +Z. Wheel spin is along ROS Y.
 * `frontX` / `rearX` are meters. `rightY` defaults to the mirror of left Y.
 */
export function carUrdf({
    name = "car",
    frontX = 0.8,
    rearX = -0.7,
    leftY = 0.5,
    rightY = null,
    height = 0.25,
    frontSteer = true,
    rearSteer = false,
    leftLower = -0.4,
    leftUpper = 0.4,
    rightLower = -0.4,
    rightUpper = 0.4,
    body = `<box size="2 1 0.5"/>`,
    extraAxle = null,
} = {}) {
    const right = rightY == null ? -leftY : rightY;
    const wheel = (id, link, x, y, steer, lower, upper) => wheelJoints({
        id,
        link,
        xyz: `${x} ${y} ${height}`,
        spinAxis: y >= 0 ? "0 1 0" : "0 -1 0",
        steer,
        lower,
        upper,
    });
    return `<?xml version="1.0"?>
<robot name="${name}">
  <link name="base_link">
    <visual><geometry>${body}</geometry></visual>
    <collision><geometry><box size="2 1 0.5"/></geometry></collision>
  </link>
  ${wheel("fl", "fl_wheel", frontX, leftY, frontSteer, leftLower, leftUpper)}
  ${wheel("fr", "fr_wheel", frontX, right, frontSteer, rightLower, rightUpper)}
  ${wheel("rl", "rl_wheel", rearX, leftY, rearSteer, leftLower, leftUpper)}
  ${wheel("rr", "rr_wheel", rearX, right, rearSteer, rightLower, rightUpper)}
  ${extraAxle ? wheel("el", "el_wheel", extraAxle.x, leftY, false, leftLower, leftUpper) : ""}
  ${extraAxle ? wheel("er", "er_wheel", extraAxle.x, right, false, leftLower, leftUpper) : ""}
</robot>
`;
}

export function carPackage(options) {
    return urdfPackage("robot.urdf", [{ path: "robot.urdf", bytes: carUrdf(options) }]);
}
