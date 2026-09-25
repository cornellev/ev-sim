/**
 * Off-thread ROS CDR encode for heavy sensor frames (PointCloud2 / Image).
 * Main thread posts schemas once, then { id, typeStr, value } encode jobs.
 */

import {
	encodeTopicValue,
	registerMsgDefinition,
} from "../../client/TopicCodec.js";
import { buildEncodedPublishPacket } from "../../client/Client.js";

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
	const { id, typeStr, value, topic, init, schemas } = message;
	try {
		if (init) {
			ensureSchemas(schemas);
			self.postMessage({ id, ok: true, kind: "init" });
			return;
		}
		if (!schemasReady && schemas) ensureSchemas(schemas);
		const encoded = encodeTopicValue(typeStr, value);
		const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
		if (topic) {
			const prepared = buildEncodedPublishPacket(topic, bytes);
			self.postMessage({
				id,
				ok: true,
				packet: prepared.packet,
				valueOffset: prepared.valueOffset,
			}, [prepared.packet.buffer]);
			return;
		}
		self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
	} catch (error) {
		self.postMessage({ id, ok: false, error: error?.message || String(error) });
	}
};
