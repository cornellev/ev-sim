/**
 * Main-thread facade for sensorEncode.worker.js.
 * Falls back to synchronous encodeTopicValue when Workers are unavailable.
 */

import { encodeTopicValue } from "../../client/Client.js";
import { catalogSchemas } from "../../autonomy/AutonomyContractCatalog.js";

let sharedWorker = null;
let sharedSeq = 0;
const pending = new Map();

function createWorker() {
	if (typeof Worker === "undefined") return null;
	try {
		return new Worker(new URL("./sensorEncode.worker.js", import.meta.url), { type: "module" });
	} catch (error) {
		console.warn("Sensor encode worker unavailable:", error?.message || error);
		return null;
	}
}

function getWorker() {
	if (sharedWorker) return sharedWorker;
	sharedWorker = createWorker();
	if (!sharedWorker) return null;
	sharedWorker.onmessage = (event) => {
		const { id, ok, bytes, error } = event.data || {};
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		if (ok) entry.resolve(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));
		else entry.reject(new Error(error || "encode worker failed"));
	};
	sharedWorker.onerror = (event) => {
		const message = event?.message || "encode worker error";
		for (const [, entry] of pending) entry.reject(new Error(message));
		pending.clear();
		sharedWorker = null;
	};
	sharedWorker.postMessage({
		id: "init-kernels",
		init: true,
		schemas: catalogSchemas(),
	});
	return sharedWorker;
}

export function isHeavySensorValue(value) {
	if (!value || typeof value !== "object") return false;
	if (ArrayBuffer.isView(value)) return value.byteLength >= 1024;
	if (ArrayBuffer.isView(value.data)) {
		if (value.encoding != null && Number.isFinite(Number(value.width))) return true;
		if (Array.isArray(value.fields) && Number.isFinite(Number(value.point_step))) return true;
	}
	return false;
}

/**
 * Encode a ROS message, preferring the worker for heavy payloads.
 * @returns {Promise<Uint8Array>}
 */
export function encodeTopicValueAsync(typeStr, value, { forceSync = false } = {}) {
	if (forceSync || !isHeavySensorValue(value)) {
		return Promise.resolve(encodeTopicValue(typeStr, value));
	}
	const worker = getWorker();
	if (!worker) {
		return Promise.resolve(encodeTopicValue(typeStr, value));
	}
	const id = `enc-${++sharedSeq}`;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		if (value?.data?.buffer instanceof ArrayBuffer) {
			// Copy before transfer so the main-thread message value stays valid for SignalStore.
			const copy = value.data.slice();
			const payload = { ...value, data: copy };
			worker.postMessage({ id, typeStr, value: payload }, [copy.buffer]);
			return;
		}
		worker.postMessage({ id, typeStr, value });
	});
}
