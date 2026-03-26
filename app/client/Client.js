
const WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : require("ws");

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
};

const TYPE_ENCODERS = {
	"std_msgs/String": 0x01,
	"std_msgs/Int32": 0x02,
	"std_msgs/Float32": 0x03,
	"std_msgs/Bool": 0x04,
	"std_msgs/Float64": 0x05,
	"std_msgs/Int64": 0x06,
	"std_msgs/UInt32": 0x07,
	"std_msgs/UInt64": 0x08,
	"std_msgs/Byte": 0x09,
	"std_msgs/Char": 0x0a,
	"std_msgs/ColorRGBA": 0x0b,
	"std_msgs/Duration": 0x0c,
};

const TYPE_DECODERS = Object.entries(TYPE_ENCODERS).reduce((acc, [k, v]) => {
	acc[v] = k;
	return acc;
}, {});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeValue(typeStr, value) {
	const typeByte = TYPE_ENCODERS[typeStr];
	if (typeByte === undefined) throw new Error(`Unsupported type '${typeStr}'`);

	let payload;
	switch (typeStr) {
		case "std_msgs/String":
			payload = encoder.encode(value ?? "");
			break;
		case "std_msgs/Int32":
			payload = new Uint8Array(4);
			new DataView(payload.buffer).setInt32(0, value ?? 0, true);
			break;
		case "std_msgs/Float32":
			payload = new Uint8Array(4);
			new DataView(payload.buffer).setFloat32(0, value ?? 0, true);
			break;
		case "std_msgs/Bool":
			payload = new Uint8Array([value ? 1 : 0]);
			break;
		case "std_msgs/Float64":
			payload = new Uint8Array(8);
			new DataView(payload.buffer).setFloat64(0, value ?? 0, true);
			break;
		case "std_msgs/Int64":
			payload = new Uint8Array(8);
			new DataView(payload.buffer).setBigInt64(0, BigInt(value ?? 0), true);
			break;
		case "std_msgs/UInt32":
			payload = new Uint8Array(4);
			new DataView(payload.buffer).setUint32(0, value ?? 0, true);
			break;
		case "std_msgs/UInt64":
			payload = new Uint8Array(8);
			new DataView(payload.buffer).setBigUint64(0, BigInt(value ?? 0), true);
			break;
		case "std_msgs/Byte":
			payload = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
			break;
		case "std_msgs/Char":
			if (!value || value.length !== 1) throw new Error("Char must be length 1");
			payload = encoder.encode(value);
			break;
		case "std_msgs/ColorRGBA":
			if (!Array.isArray(value) || value.length !== 4) throw new Error("ColorRGBA needs [r,g,b,a]");
			payload = new Uint8Array(16);
			const dv = new DataView(payload.buffer);
			dv.setFloat32(0, value[0], true);
			dv.setFloat32(4, value[1], true);
			dv.setFloat32(8, value[2], true);
			dv.setFloat32(12, value[3], true);
			break;
		case "std_msgs/Duration":
			payload = new Uint8Array(8);
			const dvDur = new DataView(payload.buffer);
			const sec = Math.trunc(value ?? 0);
			const nsec = Math.trunc(((value ?? 0) - sec) * 1e9);
			dvDur.setInt32(0, sec, true);
			dvDur.setInt32(4, nsec, true);
			break;
		default:
			throw new Error(`Unhandled type ${typeStr}`);
	}

	const out = new Uint8Array(1 + 4 + payload.length);
	out[0] = typeByte;
	new DataView(out.buffer).setUint32(1, payload.length, true);
	out.set(payload, 5);
	return out;
}

function decodeValue(view, offset) {
	const typeByte = view[offset];
	const typeStr = TYPE_DECODERS[typeByte];
	if (!typeStr) throw new Error(`Unknown type byte ${typeByte}`);
	const count = new DataView(view.buffer, view.byteOffset).getUint32(offset + 1, true);
	const start = offset + 5;
	const slice = view.subarray(start, start + count);
	let value;
	switch (typeStr) {
		case "std_msgs/String":
			value = decoder.decode(slice);
			break;
		case "std_msgs/Int32":
			value = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getInt32(0, true);
			break;
		case "std_msgs/Float32":
			value = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getFloat32(0, true);
			break;
		case "std_msgs/Bool":
			value = slice[0] !== 0;
			break;
		case "std_msgs/Float64":
			value = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getFloat64(0, true);
			break;
		case "std_msgs/Int64":
			value = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getBigInt64(0, true);
			break;
		case "std_msgs/UInt32":
			value = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getUint32(0, true);
			break;
		case "std_msgs/UInt64":
			value = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getBigUint64(0, true);
			break;
		case "std_msgs/Byte":
			value = slice;
			break;
		case "std_msgs/Char":
			value = decoder.decode(slice);
			break;
		case "std_msgs/ColorRGBA":
			const dv = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
			value = [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
			break;
		case "std_msgs/Duration":
			const dvDur = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
			value = dvDur.getInt32(0, true) + dvDur.getInt32(4, true) / 1e9;
			break;
		default:
			throw new Error(`Unhandled type ${typeStr}`);
	}
	return { type: typeStr, value, next: start + count };
}

function buildTopicData(topicName, typeStr, value) {
	const encodedName = encoder.encode(topicName);
	const payload = encodeValue(typeStr, value);
	const out = new Uint8Array(1 + encodedName.length + payload.length);
	out[0] = encodedName.length;
	out.set(encodedName, 1);
	out.set(payload, 1 + encodedName.length);
	return out;
}

function parseTopicInfo(view, offset) {
	const topicId = new DataView(view.buffer, view.byteOffset).getUint32(offset, false);
	const typeByte = view[offset + 4];
	const typeStr = TYPE_DECODERS[typeByte];
	const count = new DataView(view.buffer, view.byteOffset).getUint32(offset + 5, true);
	const nameLen = view[offset + 9];
	const nameStart = offset + 10;
	const nameEnd = nameStart + nameLen;
	const name = decoder.decode(view.subarray(nameStart, nameEnd));
	return { topicId, typeStr, count, name, next: nameEnd };
}

function parseUpdate(view) {
	const info = parseTopicInfo(view, 0);
	let value;

	if (view.length > info.next) {
		const decoded = decodeValue(view, info.next);
		value = decoded.value;
		info.next = decoded.next;
	}

	return { ...info, value };
}

function parseBigUpdate(view) {
	const total = new DataView(view.buffer, view.byteOffset).getUint32(0, true);
	let offset = 4;
	const out = {};
	for (let i = 0; i < total; i += 1) {
		const nameLen = view[offset];
		const name = decoder.decode(view.subarray(offset + 1, offset + 1 + nameLen));
		offset += 1 + nameLen;
		const { type, value, next } = decodeValue(view, offset);
		out[name] = { type, value };
		offset = next;
	}
	return out;
}

class Client {
	constructor({
		url = "ws://localhost:8080",
		reconnect = true,
		backoff = 500,
		backoffMax = 8000,
		autoSubscribe = true,
		onEcho,
		onNewTopic,
		onUpdate,
		onBigUpdate,
		onOpen,
		onClose,
	} = {}) {
		this.url = url;
		this.reconnect = reconnect;
		this.backoff = backoff;
		this.backoffMax = backoffMax;
		this.autoSubscribe = autoSubscribe;

		this.onEcho = onEcho;
		this.onNewTopic = onNewTopic;
		this.onUpdate = onUpdate;
		this.onBigUpdate = onBigUpdate;
		this.onOpen = onOpen;
		this.onClose = onClose;

		this.ws = null;
		this.stopped = false;
		this._connected = false;
		this._ready = Promise.resolve();
		this._readyResolve = () => {};
	}

	async start() {
		this.stopped = false;
		let delay = this.backoff;
		while (!this.stopped) {
			try {
				await this._connect();
				delay = this.backoff;
				await this._listen();
			} catch (err) {
				this._connected = false;
				if (this.stopped || !this.reconnect) break;
				await wait(delay);
				delay = Math.min(this.backoffMax, delay * 2);
			}
		}
	}

	async stop() {
		this.stopped = true;
		if (this.ws) this.ws.close();
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

	async publish(topic, typeStr, value) {
		const payload = buildTopicData(topic, typeStr, value);
		const out = new Uint8Array(1 + payload.length);
		out[0] = OP_CODES.publish;
		out.set(payload, 1);
		await this._send(out);
	}

	async _connect() {
		await new Promise((resolve, reject) => {
			const ws = new WebSocketImpl(this.url);
			this.ws = ws;
			ws.binaryType = "arraybuffer";
			this._ready = new Promise((r) => (this._readyResolve = r));
			ws.onopen = () => {
				this._connected = true;
				this._readyResolve();
				if (this.autoSubscribe) this.subscribe();
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
				reject(err);
			};
			ws.onclose = () => {
				this._connected = false;
				if (!this.stopped && !this.reconnect) reject(new Error("closed"));
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
				// console.log("Received message of kind", kind);
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
					}
				} catch (err) {
					console.error("Failed to handle message", err);
				}
			};
			ws.onclose = () => {
				this._connected = false;
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
				if (this.onClose) {
					try {
						this.onClose();
					} catch (e) {
						console.error("onClose handler failed", e);
					}
				}
				reject(err);
			};
		});
	}

	_handleEcho(view) {
		const total = new DataView(view.buffer, view.byteOffset).getUint32(0, true);
		let offset = 4;
		const out = [];
		for (let i = 0; i < total; i += 1) {
			const info = parseTopicInfo(view, offset);
			out.push(info);
			offset = info.next;
		}
		return out;
	}

	async _send(data) {
		if (data === undefined) return; // ignore empty sends

		await this._ready;
		if (!this.ws || this.ws.readyState !== WebSocketImpl.OPEN) throw new Error("WebSocket not open");
		this.ws.send(data);
	}
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Export for Node (CommonJS) and attach to window in browsers
if (typeof module !== "undefined" && module.exports) {
	module.exports = { Client, buildTopicData, encodeValue, decodeValue };
}

if (typeof window !== "undefined") {
	window.ROSClient = {
		Client,
		buildTopicData,
		encodeValue,
		decodeValue,
	};
}