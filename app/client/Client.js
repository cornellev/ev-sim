import {
	MAX_TOPIC_NAME_LEN,
	TYPE_DECODERS,
	DYNAMIC_TYPE_BYTE,
	encoder,
	decoder,
	encodeValue,
	decodeValue,
	encodeTopicValue,
	decodeTopicValue,
	hasRegisteredSchema,
	listRegisteredSchemaTypes,
	registerMessageSchema,
	registerMsgDefinition,
	registerMsgDefinitionFromFile,
	requireBytes as _requireBytes,
} from "./TopicCodec.js";
import { browserSimulationPerformance } from "../simulation/performance/BrowserSimulationPerformance.js";

let WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : null;

function getWebSocketImpl() {
	if (WebSocketImpl) return WebSocketImpl;
	// Node-only fallback; keep out of worker top-level evaluation.
	WebSocketImpl = require("ws");
	return WebSocketImpl;
}

const OP_CODES = {
	echo: 0x00,
	subscribe: 0x01,
	publish: 0x02,
	request_all: 0x03,
};

const RESP_CODES = {
	0x80: "echo",
	0x81: "echo_new",
	0x82: "update",
	0x83: "big_update",
	0x84: "error",
};

function _authHeaders(token, includeJson = false) {
	const headers = {};
	if (includeJson) headers["Content-Type"] = "application/json";
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

async function _requestJson(method, url, body = undefined, token = undefined) {
	if (typeof fetch === "function") {
		const response = await fetch(url, {
			method,
			headers: _authHeaders(token, body !== undefined),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		return response.json();
	}

	if (globalThis.window === globalThis) {
		throw new Error("No fetch implementation available in browser environment");
	}

	let http;
	if (url.startsWith("https:")) {
		http = require("https");
	} else {
		http = require("http");
	}
	return new Promise((resolve, reject) => {
		const req = http.request(
			url,
			{
				method,
				headers: _authHeaders(token, body !== undefined),
			},
			(res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					const status = res.statusCode ?? 500;
					if (status < 200 || status >= 300) {
						reject(new Error(`HTTP ${status} ${res.statusMessage || ""}`));
						return;
					}
					try {
						resolve(JSON.parse(data || "{}"));
					} catch (err) {
						reject(err);
					}
				});
			}
		);

		req.on("error", reject);
		if (body !== undefined) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

async function syncTypesFromServer({ apiBase = "http://localhost:8090", since, token } = {}) {
	const query = since ? `?since=${encodeURIComponent(since)}` : "";
	const payload = await _requestJson("GET", `${apiBase.replace(/\/$/, "")}/api/types${query}`, undefined, token);
	const loaded = [];
	for (const item of payload.types || []) {
		if (!item || typeof item.type !== "string" || typeof item.definition !== "string") continue;
		registerMsgDefinition(item.type, item.definition);
		loaded.push(item.type);
	}
	return { count: loaded.length, types: loaded, catalogHash: payload.catalogHash || payload.hash || null };
}

async function syncTypesToServer(types, { apiBase = "http://localhost:8090", token } = {}) {
	const entries = Array.isArray(types)
		? types
		: Object.entries(types || {}).map(([type, definition]) => ({ type, definition }));

	const payload = {
		types: entries
			.filter((item) => item && typeof item.type === "string" && typeof item.definition === "string")
			.map((item) => ({ type: item.type, definition: item.definition })),
	};

	return _requestJson("POST", `${apiBase.replace(/\/$/, "")}/api/types/sync`, payload, token);
}

function buildTopicData(topicName, typeStr, value) {
	const encodedName = encoder.encode(topicName);
	if (encodedName.length > MAX_TOPIC_NAME_LEN) {
		throw new Error(`Topic name exceeds ${MAX_TOPIC_NAME_LEN} UTF-8 bytes`);
	}
	const payload = encodeValue(typeStr, value);
	return buildTopicDataFromEncodedName(encodedName, payload);
}

function buildTopicDataFromEncodedName(encodedName, payload) {
	if (encodedName.length > MAX_TOPIC_NAME_LEN) {
		throw new Error(`Topic name exceeds ${MAX_TOPIC_NAME_LEN} UTF-8 bytes`);
	}
	const out = new Uint8Array(1 + encodedName.length + payload.length);
	out[0] = encodedName.length;
	out.set(encodedName, 1);
	out.set(payload, 1 + encodedName.length);
	return out;
}

function buildEncodedPublishPacket(topicName, encodedValue) {
	const encodedName = encoder.encode(topicName);
	if (encodedName.length > MAX_TOPIC_NAME_LEN) {
		throw new Error(`Topic name exceeds ${MAX_TOPIC_NAME_LEN} UTF-8 bytes`);
	}
	const encoded = encodedValue instanceof Uint8Array
		? encodedValue
		: new Uint8Array(encodedValue || []);
	const valueOffset = 2 + encodedName.length;
	const packet = new Uint8Array(valueOffset + encoded.length);
	packet[0] = OP_CODES.publish;
	packet[1] = encodedName.length;
	packet.set(encodedName, 2);
	packet.set(encoded, valueOffset);
	return { packet, valueOffset, encoded: packet.subarray(valueOffset) };
}

function parseTopicInfo(view, offset) {
	_requireBytes(view, offset, 7, "topic info header");
	const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
	const topicId = dv.getUint32(offset, false);
	const typeByte = view[offset + 4];
	const dynamicLen = dv.getUint16(offset + 5, true);
	const dynamicStart = offset + 7;
	_requireBytes(view, dynamicStart, dynamicLen + 5, "topic info body");
	const dynamicEnd = dynamicStart + dynamicLen;
	const typeStr =
		typeByte === DYNAMIC_TYPE_BYTE ? decoder.decode(view.subarray(dynamicStart, dynamicEnd)) : TYPE_DECODERS[typeByte];
	const count = dv.getUint32(dynamicEnd, true);
	const nameLen = view[dynamicEnd + 4];
	const nameStart = dynamicEnd + 5;
	_requireBytes(view, nameStart, nameLen, "topic name");
	const nameEnd = nameStart + nameLen;
	const name = decoder.decode(view.subarray(nameStart, nameEnd));
	return { topicId, typeStr, count, name, next: nameEnd };
}

function parseUpdate(view) {
	const info = parseTopicInfo(view, 0);
	let value;

	if (view.length > info.next) {
		const decoded = decodeValue(view, info.next);
		if (decoded.type !== info.typeStr) {
			throw new Error(`Mismatched update type for topic '${info.name}': ${decoded.type} != ${info.typeStr}`);
		}
		value = decoded.value;
		info.next = decoded.next;
	}

	return { ...info, value };
}

function parseBigUpdate(view) {
	_requireBytes(view, 0, 4, "big_update count");
	const total = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, true);
	let offset = 4;
	const out = {};
	for (let i = 0; i < total; i += 1) {
		_requireBytes(view, offset, 1, "big_update topic length");
		const nameLen = view[offset];
		_requireBytes(view, offset + 1, nameLen, "big_update topic name");
		const name = decoder.decode(view.subarray(offset + 1, offset + 1 + nameLen));
		offset += 1 + nameLen;
		const { type, value, next } = decodeValue(view, offset);
		out[name] = { type, value };
		offset = next;
	}
	return out;
}

function parseError(view) {
	_requireBytes(view, 0, 4, "error header");
	const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
	const code = dv.getUint16(0, true);
	const length = dv.getUint16(2, true);
	_requireBytes(view, 4, length, "error message");
	const message = decoder.decode(view.subarray(4, 4 + length));
	return { code, message };
}

class Client {
	constructor({
		url = "ws://localhost:8080",
		reconnect = true,
		backoff = 500,
		backoffMax = 8000,
		autoSubscribe = true,
		debug = false,
		maxBufferedAmount = 8 * 1024 * 1024,
		onEcho,
		onNewTopic,
		onUpdate,
		onBigUpdate,
		onError,
		onOpen,
		onClose,
		onBackpressure,
	} = {}) {
		this.url = url;
		this.reconnect = reconnect;
		this.backoff = backoff;
		this.backoffMax = backoffMax;
		this.autoSubscribe = autoSubscribe;
		this.debug = debug;
		this.maxBufferedAmount = Math.max(1024, Number(maxBufferedAmount) || 8 * 1024 * 1024);

		this.onEcho = onEcho;
		this.onNewTopic = onNewTopic;
		this.onUpdate = onUpdate;
		this.onBigUpdate = onBigUpdate;
		this.onError = onError;
		this.onOpen = onOpen;
		this.onClose = onClose;
		this.onBackpressure = onBackpressure;

		this.ws = null;
		this.stopped = false;
		this._connected = false;
		this._startPromise = null;
		this._ready = Promise.resolve();
		this._readyResolve = () => {};
		this._readyReject = () => {};
		this.droppedPublishBytes = 0;
		this.backpressureEvents = 0;
	}

	isOpen() {
		return !!this.ws && this.ws.readyState === getWebSocketImpl().OPEN;
	}

	async start() {
		if (this._startPromise) return this._startPromise;
		this.stopped = false;
		this._startPromise = this._runStartLoop();
		try {
			await this._startPromise;
		} finally {
			this._startPromise = null;
		}
	}

	async _runStartLoop() {
		let delay = this.backoff;
		let connectedOnce = false;
		while (!this.stopped) {
			try {
				await this._connect();
				connectedOnce = true;
				delay = this.backoff;
				await this._listen();
			} catch (err) {
				this._connected = false;
				this._rejectReady(err);
				if (this.stopped) break;
				if (!this.reconnect) {
					if (!connectedOnce) throw err;
					break;
				}
				await wait(delay);
				delay = Math.min(this.backoffMax, delay * 2);
			}
		}
	}

	async stop() {
		this.stopped = true;
		this._connected = false;
		this._rejectReady(new Error("Client stopped"));
		if (this.ws) {
			try {
				this.ws.close();
			} catch (_) {
				/* ignore */
			}
		}
		if (this._startPromise) {
			try {
				await this._startPromise;
			} catch (_) {
				/* ignore */
			}
		}
	}

	async echo() {
		await this._send(new Uint8Array([OP_CODES.echo]));
	}

	async subscribe() {
		await this._send(new Uint8Array([OP_CODES.subscribe]));
	}

	async requestAll() {
		await this._send(new Uint8Array([OP_CODES.request_all]));
	}

	async publish(topic, typeStr, value, options = {}) {
		const payload = buildTopicData(topic, typeStr, value);
		const out = new Uint8Array(1 + payload.length);
		out[0] = OP_CODES.publish;
		out.set(payload, 1);
		await this._send(out, options);
	}

	async publishEncoded(topic, encodedValue, options = {}) {
		const prepared = buildEncodedPublishPacket(topic, encodedValue);
		await this.publishPrepared(prepared.packet, options);
	}

	async publishPrepared(packet, options = {}) {
		const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet || []);
		browserSimulationPerformance.recordWebSocketBytes(bytes.byteLength);
		this._assertSendBudget(bytes.byteLength, options);
		await this._send(bytes, { ...options, prechecked: true });
	}

	async syncTypesFromServer(options = {}) {
		return syncTypesFromServer(options);
	}

	async syncTypesToServer(types, options = {}) {
		return syncTypesToServer(types, options);
	}

	async fetchTopicCatalog(timeoutMs = 5000) {
		if (!this.isOpen()) throw new Error("WebSocket not open");
		return new Promise((resolve, reject) => {
			const previousEcho = this.onEcho;
			const timeout = setTimeout(() => {
				this.onEcho = previousEcho;
				reject(new Error("Timed out waiting for orchestrator topic catalog."));
			}, timeoutMs);
			this.onEcho = async (topics) => {
				clearTimeout(timeout);
				this.onEcho = previousEcho;
				if (previousEcho) await previousEcho(topics);
				resolve(topics);
			};
			this.echo().catch((error) => {
				clearTimeout(timeout);
				this.onEcho = previousEcho;
				reject(error);
			});
		});
	}

	_rejectReady(err) {
		try {
			this._readyReject(err instanceof Error ? err : new Error(String(err)));
		} catch (_) {
			/* already settled */
		}
	}

	async _connect() {
		await new Promise((resolve, reject) => {
			const ws = new (getWebSocketImpl())(this.url);
			this.ws = ws;
			ws.binaryType = "arraybuffer";
			this._ready = new Promise((res, rej) => {
				this._readyResolve = res;
				this._readyReject = rej;
			});
			// Prevent unhandled rejection if nobody awaits yet.
			this._ready.catch(() => {});
			ws.onopen = () => {
				this._connected = true;
				this._readyResolve();
				if (this.autoSubscribe) this.subscribe().catch((e) => console.error("autoSubscribe failed", e));
				if (this.onOpen) {
					try {
						this.onOpen();
					} catch (e) {
						console.error("onOpen handler failed", e);
					}
				}
				resolve();
			};
			ws.onerror = (err) => {
				this._connected = false;
				this._rejectReady(err instanceof Error ? err : new Error("WebSocket error"));
				reject(err instanceof Error ? err : new Error("WebSocket error"));
			};
			ws.onclose = () => {
				this._connected = false;
				if (!this.stopped && !this.reconnect) {
					const err = new Error("closed");
					this._rejectReady(err);
					reject(err);
				}
			};
		});
	}

	async _listen() {
		return new Promise((resolve, reject) => {
			const ws = this.ws;
			if (!ws) return reject(new Error("No socket"));
			ws.onmessage = async (evt) => {
				const buf = evt.data instanceof ArrayBuffer ? new Uint8Array(evt.data) : new Uint8Array(evt.data.buffer || evt.data);
				if (!buf.length) return;
				const code = buf[0];
				const view = buf.subarray(1);
				const kind = RESP_CODES[code];
				if (this.debug) console.log("Received message of kind", kind);
				try {
					if (kind === "echo") {
						const topics = this._handleEcho(view);
						if (this.onEcho) await this.onEcho(topics);
					} else if (kind === "echo_new") {
						const info = parseTopicInfo(view, 0);
						if (this.onNewTopic) await this.onNewTopic(info);
					} else if (kind === "update") {
						const info = parseUpdate(view);
						if (this.onUpdate) await this.onUpdate(info);
					} else if (kind === "big_update") {
						const updates = parseBigUpdate(view);
						if (this.onBigUpdate) await this.onBigUpdate(updates);
					} else if (kind === "error") {
						const info = parseError(view);
						if (this.onError) await this.onError(info);
						else if (this.debug) console.warn("Protocol error", info);
					}
				} catch (err) {
					console.error("Failed to handle message", err);
				}
			};
			ws.onclose = () => {
				this._connected = false;
				this._rejectReady(new Error("WebSocket closed"));
				if (this.onClose) {
					try {
						this.onClose();
					} catch (e) {
						console.error("onClose handler failed", e);
					}
				}
				resolve();
			};
			ws.onerror = (err) => {
				this._connected = false;
				const error = err instanceof Error ? err : new Error("WebSocket error");
				this._rejectReady(error);
				if (this.onClose) {
					try {
						this.onClose();
					} catch (e) {
						console.error("onClose handler failed", e);
					}
				}
				reject(error);
			};
		});
	}

	_handleEcho(view) {
		_requireBytes(view, 0, 4, "echo count");
		const total = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, true);
		let offset = 4;
		const out = [];
		for (let i = 0; i < total; i += 1) {
			const info = parseTopicInfo(view, offset);
			out.push(info);
			offset = info.next;
		}
		return out;
	}

	bufferedAmount() {
		return Number(this.ws?.bufferedAmount || 0);
	}

	_assertSendBudget(packetBytes, options = {}) {
		const buffered = this.bufferedAmount();
		if (buffered + packetBytes <= this.maxBufferedAmount) return;
		this.backpressureEvents += 1;
		this.droppedPublishBytes += packetBytes;
		const error = new Error("websocket-backpressure");
		error.code = "websocket-backpressure";
		error.bufferedAmount = buffered;
		error.packetBytes = packetBytes;
		error.maxBufferedAmount = this.maxBufferedAmount;
		error.required = options.required === true;
		try {
			this.onBackpressure?.(error);
		} catch {
			/* ignore listener failures */
		}
		throw error;
	}

	async _send(data, options = {}) {
		if (data === undefined) return; // ignore empty sends
		if (this.stopped) throw new Error("Client stopped");

		await this._ready;
		if (this.stopped) throw new Error("Client stopped");
		if (!this.ws || this.ws.readyState !== getWebSocketImpl().OPEN) throw new Error("WebSocket not open");
		if (!options.prechecked) {
			this._assertSendBudget(data?.byteLength || data?.length || 0, options);
		}
		this.ws.send(data);
	}
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export {
	MAX_TOPIC_NAME_LEN,
	encodeValue,
	encodeTopicValue,
	decodeValue,
	decodeTopicValue,
	hasRegisteredSchema,
	listRegisteredSchemaTypes,
	registerMessageSchema,
	registerMsgDefinition,
	registerMsgDefinitionFromFile,
} from "./TopicCodec.js";

export {
	Client,
	buildEncodedPublishPacket,
	buildTopicData,
	syncTypesFromServer,
	syncTypesToServer,
};

// Export for Node (CommonJS) and attach to window in browsers
if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		Client,
		MAX_TOPIC_NAME_LEN,
		buildTopicData,
		encodeValue,
		encodeTopicValue,
		decodeValue,
		decodeTopicValue,
		hasRegisteredSchema,
		listRegisteredSchemaTypes,
		registerMessageSchema,
		registerMsgDefinition,
		registerMsgDefinitionFromFile,
		syncTypesFromServer,
		syncTypesToServer,
	};
}

// Preserve the legacy browser global without evaluating a `window` getter.
// Headless kernel imports deliberately probe with throwing browser globals.
const browserWindow = Object.getOwnPropertyDescriptor(globalThis, "window")?.value;
if (browserWindow && browserWindow === globalThis) {
	browserWindow.ROSClient = {
		Client,
		MAX_TOPIC_NAME_LEN,
		buildTopicData,
		encodeValue,
		encodeTopicValue,
		decodeValue,
		decodeTopicValue,
		hasRegisteredSchema,
		listRegisteredSchemaTypes,
		registerMessageSchema,
		registerMsgDefinition,
		registerMsgDefinitionFromFile,
		syncTypesFromServer,
		syncTypesToServer,
	};
}
