import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

export const HEADLESS_PROTO_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../proto/cev_sim/headless/v1/headless.proto",
);

export const PROTO_LOADER_OPTIONS = Object.freeze({
    keepCase: false,
    longs: String,
    enums: Number,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
});

let cached = null;

export function loadHeadlessGrpcSchema() {
    if (cached) return cached;
    const definition = protoLoader.loadSync(HEADLESS_PROTO_PATH, PROTO_LOADER_OPTIONS);
    const loaded = grpc.loadPackageDefinition(definition);
    const namespace = loaded.cev_sim.headless.v1;
    cached = Object.freeze({ grpc, definition, namespace, service: namespace.HeadlessSimulationService });
    return cached;
}
