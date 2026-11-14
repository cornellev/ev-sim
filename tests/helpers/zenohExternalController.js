import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import readline from "node:readline";
import { ZenohNativeTransport } from "../../server/sensor-transports/ZenohNativeTransport.js";
import { loadDescriptorSet, encodeMessage, decodeMessage } from "../../app/interfaces/ProtobufSchema.js";

const [addon, configPath, bundlePath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
const schema = bundle.resolved.protobufInterface.document.schemas[0];
const { root } = loadDescriptorSet(Buffer.from(schema.descriptorBase64, "base64"), schema.fingerprint);
const commandType = root.lookupType("headless_test.Command"), stateType = root.lookupType("headless_test.State");
const transport = new ZenohNativeTransport({ config, nativeBinding: createRequire(import.meta.url)(addon) });
let sequence = 0;
await transport.openSession();
process.stdout.write('{"kind":"connected"}\n');
try {
    for await (const line of readline.createInterface({ input: process.stdin })) {
        if (line === "close") break;
        const { runId } = JSON.parse(line);
        await transport.subscribe("wheel", (bytes) => {
            const value = decodeMessage(stateType, bytes);
            process.stdout.write(`${JSON.stringify({ kind: "wheel", ...value })}\n`);
        }, { key: `sim/${runId}/wheel` });
        await transport.subscribe("clock", (bytes) => {
            const value = decodeMessage(stateType, bytes);
            transport.publish({ routeId: "command", key: `sim/${runId}/command`, generation: 0,
                bytes: encodeMessage(commandType, { run: runId, sequence: String(++sequence), capture: value.time,
                    deadline: String(BigInt(value.time) + 100000000n), speed: 1.5, steering: 0.15 }) });
        }, { key: `sim/${runId}/clock`, required: true });
        process.stdout.write('{"kind":"bound"}\n');
    }
} finally { await transport.close(); }
