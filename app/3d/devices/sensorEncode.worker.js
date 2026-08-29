/**
 * Off-thread ROS CDR encode for heavy sensor frames (PointCloud2 / Image).
 * Main thread posts schemas once, then { id, typeStr, value } encode jobs.
 */

import {
	encodeTopicValue,
	registerMsgDefinition,
} from "../../client/Client.js";
import { initSensorKernels } from "../../native/SensorKernels.js";

let schemasReady = false;

function ensureSchemas(schemas) {
	if (schemasReady || !schemas) return;
	for (const [type, definition] of Object.entries(schemas)) {
		registerMsgDefinition(type, definition);
	}
	schemasReady = true;
}

self.onmessage = async (event) => {
	const message = event.data || {};
	const { id, typeStr, value, init, schemas } = message;
	try {
		if (init) {
			ensureSchemas(schemas);
			await initSensorKernels();
			self.postMessage({ id, ok: true, kind: "init" });
			return;
		}
		if (!schemasReady && schemas) ensureSchemas(schemas);
		const encoded = encodeTopicValue(typeStr, value);
		const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
		self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
	} catch (error) {
		self.postMessage({ id, ok: false, error: error?.message || String(error) });
	}
};
