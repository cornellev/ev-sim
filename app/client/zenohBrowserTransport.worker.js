import * as sdk from "@eclipse-zenoh/zenoh-ts";
import { createZenohBrowserWorkerRuntime } from "./ZenohBrowserWorkerRuntime.js";

const runtime = createZenohBrowserWorkerRuntime({ sdk, postMessage: (message, transfer) => self.postMessage(message, transfer) });
self.onmessage = (event) => runtime.handle(event.data);
self.postMessage({ type: "worker-ready" });
