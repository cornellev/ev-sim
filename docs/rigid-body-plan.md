# Rigid body components

Optional Rapier rigid bodies on environment objects. This is not a `PHY-*`
milestone. The bicycle plant, Rapier gravity on the vehicle, and
`tests/fixtures/headless/characterization.v1.json` stay as they are.

## Contract

Hosts are `primitive`, `asset-instance` with a collision proxy, and
`builtin-prop`. The component is `components.rigidBody`:

```js
{
  bodyType: "dynamic" | "kinematic",
  mass: 1,
  useGravity: true,
  linearDamping: 0,
  angularDamping: 0,
  constantForce: { x: 0, y: 0, z: 0 }
}
```

Add, remove, and edit go through `addRigidBody`, `removeRigidBody`, and
`setRigidBody` on the CommandBus. The authored transform is the reset pose.
The live pose is not written back into the environment document.

`createWorldDescription` adds `rigidBodies` only when at least one component
exists. The entry stores the component, the spawn frame, and local collider
parts taken from the primitive, the prop metric cuboid, or the asset collision
proxy. A world with none of these keeps its previous description and
`worldHash`.

Dynamic bodies use the existing Rapier world gravity. Kinematic bodies and
`useGravity: false` set gravity scale to 0. `applyForce` and `applyImpulse`
queue until the next physics step. The floor collider, when the document floor
is enabled, collides with dynamic bodies and not with the vehicle. The vehicle
hull sweep treats a rigid body as another obstacle. Because that sweep stops
short of penetration, a dynamic body also receives the vehicle's approach
speed as an impulse.

Editor Play, when no run is resolved, steps that live world description. A
resolved run keeps the world it was prepared with.

CPU LiDAR keeps one fixed triangle index per rigid body and transforms the
ray into that body's authored frame. The resolved lidar resource and
`lidarGeometryHash` stay the authored geometry. GPU LiDAR and photoreal
cameras keep the authored pose.

## Progress and decision log

### 2026-10-20 — component, Rapier step, CPU LiDAR

The inspector can add and remove the component on the three hosts. Physics
steps dynamic and kinematic bodies, and CPU LiDAR follows the live pose.
`VEHICLE_PLANT_VERSION` and the kinematic characterization tape are unchanged.

### 2026-10-20 — CPU LiDAR capture cost

Each rigid body keeps the index built from its authored triangles. A capture
inverts that body's pose once and transforms the ray. The static index is
rebuilt only when the set of body ids changes. Each index returns its nearest
hit, and an exact distance tie still uses primitive id then triangle index.
The LiDAR buffer, the resolved resource, and `lidarGeometryHash` are unchanged.
