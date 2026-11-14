#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeProtobufInterface } from "../app/interfaces/ProtobufInterface.js";
const [upstream, output = "examples/interfaces/onboarding-lease.v2.json"] = process.argv.slice(2);
if (!upstream) throw new Error("Provide the upstream checkout with freshly generated autonomy.binpb.");
const bytes = await fs.readFile(path.join(upstream, "proto/autonomy.binpb"));
const schema = { id: "onboarding", fingerprint: createHash("sha256").update(bytes).digest("hex"), descriptorBase64: bytes.toString("base64") };
const field = (to, from) => ({ to, from });
const constant = (to, value) => ({ to, value });
const header = (frame, sequenceOffset = 0) => [field("header.run_id", "run.runId"), { ...field("header.sequence", "metadata.sequenceId"), ...(sequenceOffset ? { offset: sequenceOffset } : {}) }, field("header.time_ns", "metadata.captureTimeNs"), constant("header.frame_id", frame)];
const bindings = { vehicleId: "ego", sensorId: "front-lidar", rearWheelIds: ["rear-left", "rear-right"] };
const route = (id, messageType, direction, mapping, topicId = id) => ({ id, schemaId: schema.id, messageType: `cev.onboarding.v1.${messageType}`, direction, key: `cev/onboarding/v1/{run_id}/${id}`, [direction === "publish" ? "source" : "target"]: { topicId }, mapping });
const metadata = [field("runId", "value.header.run_id"), field("frameId", "value.header.frame_id"), field("sequenceId", "value.header.sequence"), field("captureTimeNs", "value.header.time_ns")];
const document = normalizeProtobufInterface({ kind: "cev-sim.protobuf-interface", version: 2, schemas: [schema], bootstrap: [], routes: [
    route("state", "StateUpdate", "publish", { bindings, derived: [{ id: "rearPose", from: "value.pose", operation: "poseAtOffset", offsetFrom: "bindings.vehicle.rearAxleInBase" }], fields: [...header("map"), field("state.pose.position.x", "derived.rearPose.position.x"), field("state.pose.position.y", "derived.rearPose.position.y"), { to: "state.pose.yaw_rad", from: "derived.rearPose.orientation", operation: "quaternionYaw" }, field("state.speed_mps", "value.linearVelocity.x")] }, "truth-odometry"),
    route("lidar", "LidarUpdate", "publish", { bindings, fields: [...header("front_lidar_frame", 1), { to: "scan.points", each: { from: "value.points", fields: [field("x", "item.x"), field("y", "item.y")] } }, field("scan.sensor_in_vehicle.position.x", "bindings.sensor.poseInRearAxle.position.x"), field("scan.sensor_in_vehicle.position.y", "bindings.sensor.poseInRearAxle.position.y"), { to: "scan.sensor_in_vehicle.yaw_rad", from: "bindings.sensor.poseInRearAxle.orientation", operation: "quaternionYaw" }] }, "front-lidar-points"),
    route("command", "CommandUpdate", "subscribe", { metadata, checks: [{ from: "value.header.run_id", equalsFrom: "run.runId" }, { from: "value.header.frame_id", value: "base_link" }], fields: [field("runId", "value.header.run_id"), field("leaseId", "value.control_lease_id"), field("sequence", "value.header.sequence"), field("captureTimeNs", "value.header.time_ns"), field("deadlineNs", "value.valid_until_ns"), field("speedMps", "value.command.speed_mps"), field("steeringRad", "value.command.steering_rad"), constant("mode", "velocity"), constant("frameId", "base_link"), ...["accelerationMps2", "jerkMps3", "steeringRateRadps"].map((key) => constant(key, 0))] }, "controls-command"),
    route("path", "PathUpdate", "subscribe", { metadata, checks: [{ from: "value.header.run_id", equalsFrom: "run.runId" }, { from: "value.header.frame_id", value: "map" }], fields: [{ to: "points", each: { from: "value.path.points", fields: [field("x", "item.x"), field("y", "item.y"), constant("z", 0)] } }] }, "planning-path"),
] });
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
await fs.copyFile(output, path.join(upstream, "config/native-interface.json"));
console.log(`Generated ${output} from the upstream descriptor ${schema.fingerprint}`);
