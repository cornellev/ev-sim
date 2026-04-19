

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

const DYNAMIC_TYPE_BYTE = 0xff;
const DYNAMIC_SCHEMAS = new Map();
const STD_ALIASES = {
	"std_msgs/String": "string",
	"std_msgs/Int32": "int32",
	"std_msgs/Float32": "float32",
	"std_msgs/Bool": "bool",
	"std_msgs/Float64": "float64",
	"std_msgs/Int64": "int64",
	"std_msgs/UInt32": "uint32",
	"std_msgs/UInt64": "uint64",
	"std_msgs/Byte": "byte",
	"std_msgs/Char": "char",
	"std_msgs/Duration": "duration",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeTypeName(typeName, packageName) {
	if (!typeName) return typeName;
	if (typeName.includes("/")) return typeName;
	const primitive = typeName.toLowerCase();
	if (["string", "bool", "byte", "char", "duration", "time", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64"].includes(primitive)) {
		return primitive;
	}
	return packageName ? `${packageName}/${typeName}` : typeName;
}

function parseFieldType(typeToken, packageName) {
	const m = /^([A-Za-z0-9_/]+)(\[(\d*)\])?$/.exec(typeToken.trim());
	if (!m) throw new Error(`Invalid field type token '${typeToken}'`);
	return {
		typeName: normalizeTypeName(m[1], packageName),
		isArray: Boolean(m[2]),
		arrayLen: m[3] ? Number(m[3]) : null,
	};
}

function registerMessageSchema(typeName, fields) {
	const packageName = typeName.includes("/") ? typeName.split("/")[0] : null;
	const normalizedType = normalizeTypeName(typeName, packageName);
	const normalizedFields = fields.map((f) => ({
		name: f.name,
		typeName: normalizeTypeName(f.typeName, packageName),
		isArray: Boolean(f.isArray),
		arrayLen: Number.isInteger(f.arrayLen) ? f.arrayLen : null,
	}));
	DYNAMIC_SCHEMAS.set(normalizedType, normalizedFields);
}

async function registerMsgDefinitionFromFile(typeName, fileText) {
	const data = await fetch(fileText);
	if (!data.ok) throw new Error(`Failed to load message definition from ${fileText}: ${data.status} ${data.statusText}`);
	const text = await data.text();
	registerMsgDefinition(typeName, text);
}

function registerMsgDefinition(typeName, msgText) {
	const packageName = typeName.includes("/") ? typeName.split("/")[0] : null;
	const fields = [];
	for (const rawLine of msgText.split(/\r?\n/)) {
		const line = rawLine.split("#", 1)[0].trim();
		if (!line || line.includes("=")) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 2) continue;
		const fieldType = parseFieldType(parts[0], packageName);
		fields.push({
			name: parts[1],
			typeName: fieldType.typeName,
			isArray: fieldType.isArray,
			arrayLen: fieldType.arrayLen,
		});
	}
	registerMessageSchema(typeName, fields);
}

async function _requestJson(method, url, body = undefined) {
	if (typeof fetch === "function") {
		const response = await fetch(url, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		return response.json();
	}

	if (typeof window !== "undefined") {
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
				headers: body === undefined ? {} : { "Content-Type": "application/json" },
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

async function syncTypesFromServer({ apiBase = "http://localhost:8090", since } = {}) {
	const query = since ? `?since=${encodeURIComponent(since)}` : "";
	const payload = await _requestJson("GET", `${apiBase.replace(/\/$/, "")}/api/types${query}`);
	const loaded = [];
	for (const item of payload.types || []) {
		if (!item || typeof item.type !== "string" || typeof item.definition !== "string") continue;
		registerMsgDefinition(item.type, item.definition);
		loaded.push(item.type);
	}
	return { count: loaded.length, types: loaded };
}

async function syncTypesToServer(types, { apiBase = "http://localhost:8090" } = {}) {
	const entries = Array.isArray(types)
		? types
		: Object.entries(types || {}).map(([type, definition]) => ({ type, definition }));

	const payload = {
		types: entries
			.filter((item) => item && typeof item.type === "string" && typeof item.definition === "string")
			.map((item) => ({ type: item.type, definition: item.definition })),
	};

	return _requestJson("POST", `${apiBase.replace(/\/$/, "")}/api/types/sync`, payload);
}

function _decodePrimitive(typeName, bytes, offset) {
	const t = typeName.toLowerCase();
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	switch (t) {
		case "string": {
			const n = dv.getUint32(offset, true);
			const start = offset + 4;
			const end = start + n;
			return { value: decoder.decode(bytes.subarray(start, end)), next: end };
		}
		case "bool":
			return { value: bytes[offset] !== 0, next: offset + 1 };
		case "int8":
		case "char":
			return { value: dv.getInt8(offset), next: offset + 1 };
		case "uint8":
		case "byte":
			return { value: dv.getUint8(offset), next: offset + 1 };
		case "int16":
			return { value: dv.getInt16(offset, true), next: offset + 2 };
		case "uint16":
			return { value: dv.getUint16(offset, true), next: offset + 2 };
		case "int32":
			return { value: dv.getInt32(offset, true), next: offset + 4 };
		case "uint32":
			return { value: dv.getUint32(offset, true), next: offset + 4 };
		case "int64":
			return { value: dv.getBigInt64(offset, true), next: offset + 8 };
		case "uint64":
			return { value: dv.getBigUint64(offset, true), next: offset + 8 };
		case "float32":
			return { value: dv.getFloat32(offset, true), next: offset + 4 };
		case "float64":
			return { value: dv.getFloat64(offset, true), next: offset + 8 };
		case "duration": {
			const sec = dv.getInt32(offset, true);
			const nsec = dv.getInt32(offset + 4, true);
			return { value: sec + nsec / 1e9, next: offset + 8 };
		}
		case "time": {
			const sec = dv.getUint32(offset, true);
			const nsec = dv.getUint32(offset + 4, true);
			return { value: { sec, nsec }, next: offset + 8 };
		}
		default:
			return null;
	}
}

function _decodeTypedValue(typeName, bytes, offset = 0) {
	const normalized = STD_ALIASES[typeName] ?? normalizeTypeName(typeName, null);
	const primitive = _decodePrimitive(normalized, bytes, offset);
	if (primitive) return primitive;

	const schema = DYNAMIC_SCHEMAS.get(normalized);
	if (!schema) return null;

	let cursor = offset;
	const obj = {};
	for (const field of schema) {
		if (field.isArray) {
			let count = field.arrayLen;
			if (count == null) {
				count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(cursor, true);
				cursor += 4;
			}

			if ((field.typeName === "uint8" || field.typeName === "byte") && Number.isInteger(count)) {
				obj[field.name] = bytes.subarray(cursor, cursor + count);
				cursor += count;
				continue;
			}

			const arr = [];
			for (let i = 0; i < count; i += 1) {
				const decoded = _decodeTypedValue(field.typeName, bytes, cursor);
				if (!decoded) return null;
				arr.push(decoded.value);
				cursor = decoded.next;
			}
			obj[field.name] = arr;
		} else {
			const decoded = _decodeTypedValue(field.typeName, bytes, cursor);
			if (!decoded) return null;
			obj[field.name] = decoded.value;
			cursor = decoded.next;
		}
	}

	return { value: obj, next: cursor };
}

function _concatBuffers(chunks) {
	const total = chunks.reduce((sum, chunk) => sum + (chunk?.length ?? 0), 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		if (!chunk?.length) continue;
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function _encodePrimitive(typeName, value) {
	const t = typeName.toLowerCase();
	switch (t) {
		case "string": {
			const text = encoder.encode(value ?? "");
			const out = new Uint8Array(4 + text.length);
			new DataView(out.buffer).setUint32(0, text.length, true);
			out.set(text, 4);
			return out;
		}
		case "bool":
			return new Uint8Array([value ? 1 : 0]);
		case "int8":
		case "char": {
			const out = new Uint8Array(1);
			new DataView(out.buffer).setInt8(0, value ?? 0);
			return out;
		}
		case "uint8":
		case "byte": {
			const out = new Uint8Array(1);
			new DataView(out.buffer).setUint8(0, value ?? 0);
			return out;
		}
		case "int16": {
			const out = new Uint8Array(2);
			new DataView(out.buffer).setInt16(0, value ?? 0, true);
			return out;
		}
		case "uint16": {
			const out = new Uint8Array(2);
			new DataView(out.buffer).setUint16(0, value ?? 0, true);
			return out;
		}
		case "int32": {
			const out = new Uint8Array(4);
			new DataView(out.buffer).setInt32(0, value ?? 0, true);
			return out;
		}
		case "uint32": {
			const out = new Uint8Array(4);
			new DataView(out.buffer).setUint32(0, value ?? 0, true);
			return out;
		}
		case "int64": {
			const out = new Uint8Array(8);
			new DataView(out.buffer).setBigInt64(0, BigInt(value ?? 0), true);
			return out;
		}
		case "uint64": {
			const out = new Uint8Array(8);
			new DataView(out.buffer).setBigUint64(0, BigInt(value ?? 0), true);
			return out;
		}
		case "float32": {
			const out = new Uint8Array(4);
			new DataView(out.buffer).setFloat32(0, value ?? 0, true);
			return out;
		}
		case "float64": {
			const out = new Uint8Array(8);
			new DataView(out.buffer).setFloat64(0, value ?? 0, true);
			return out;
		}
		case "duration": {
			const out = new Uint8Array(8);
			const dv = new DataView(out.buffer);
			const sec = Math.trunc(value ?? 0);
			const nsec = Math.trunc(((value ?? 0) - sec) * 1e9);
			dv.setInt32(0, sec, true);
			dv.setInt32(4, nsec, true);
			return out;
		}
		case "time": {
			const out = new Uint8Array(8);
			const dv = new DataView(out.buffer);
			if (value && typeof value === "object") {
				dv.setUint32(0, value.sec ?? 0, true);
				dv.setUint32(4, value.nsec ?? 0, true);
			} else {
				const sec = Math.max(0, Math.trunc(value ?? 0));
				const nsec = Math.max(0, Math.trunc(((value ?? 0) - sec) * 1e9));
				dv.setUint32(0, sec, true);
				dv.setUint32(4, nsec, true);
			}
			return out;
		}
		default:
			return null;
	}
}

function _encodeTypedValue(typeName, value) {
	const normalized = STD_ALIASES[typeName] ?? normalizeTypeName(typeName, null);
	const primitive = _encodePrimitive(normalized, value);
	if (primitive) return primitive;

	const schema = DYNAMIC_SCHEMAS.get(normalized);
	if (!schema) throw new Error(`Unknown dynamic schema '${normalized}'`);

	const chunks = [];
	for (const field of schema) {
		const fieldValue = value?.[field.name];
		if (field.isArray) {
			const arrayValue = fieldValue ?? [];
			const isByteArray = field.typeName === "uint8" || field.typeName === "byte";
			const values = isByteArray && arrayValue instanceof Uint8Array ? arrayValue : Array.isArray(arrayValue) ? arrayValue : null;
			if (values == null) throw new Error(`Field '${field.name}' must be an array`);

			if (field.arrayLen != null && values.length !== field.arrayLen) {
				throw new Error(`Field '${field.name}' must have length ${field.arrayLen}`);
			}

			if (field.arrayLen == null) {
				const len = new Uint8Array(4);
				new DataView(len.buffer).setUint32(0, values.length, true);
				chunks.push(len);
			}

			if (isByteArray) {
				chunks.push(values instanceof Uint8Array ? values : new Uint8Array(values));
			} else {
				for (const element of values) {
					chunks.push(_encodeTypedValue(field.typeName, element));
				}
			}
		} else {
			chunks.push(_encodeTypedValue(field.typeName, fieldValue));
		}
	}

	return _concatBuffers(chunks);
}

function encodeValue(typeStr, value) {
	const typeByte = TYPE_ENCODERS[typeStr];
	if (typeByte === undefined) {
		const normalizedType = normalizeTypeName(typeStr, null);
		const typeNameBytes = encoder.encode(normalizedType);
		if (typeNameBytes.length > 0xffff) throw new Error(`Dynamic type name too long: '${normalizedType}'`);

		const encodedValue = _encodeTypedValue(normalizedType, value ?? {});
		const dynamicPayload = new Uint8Array(2 + typeNameBytes.length + encodedValue.length);
		const dynView = new DataView(dynamicPayload.buffer);
		dynView.setUint16(0, typeNameBytes.length, true);
		dynamicPayload.set(typeNameBytes, 2);
		dynamicPayload.set(encodedValue, 2 + typeNameBytes.length);

		const out = new Uint8Array(1 + 4 + dynamicPayload.length);
		out[0] = DYNAMIC_TYPE_BYTE;
		new DataView(out.buffer).setUint32(1, dynamicPayload.length, true);
		out.set(dynamicPayload, 5);
		return out;
	}

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
	const count = new DataView(view.buffer, view.byteOffset).getUint32(offset + 1, true);
	const start = offset + 5;
	const slice = view.subarray(start, start + count);

	if (typeByte === DYNAMIC_TYPE_BYTE) {
		const nameLen = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getUint16(0, true);
		const nameStart = 2;
		const nameEnd = nameStart + nameLen;
		const typeStr = decoder.decode(slice.subarray(nameStart, nameEnd));
		const valueBytes = slice.subarray(nameEnd);
		const decoded = _decodeTypedValue(typeStr, valueBytes, 0);
		const readable = decoded && decoded.next === valueBytes.length ? decoded.value : valueBytes;
		return { type: typeStr, value: readable, next: start + count };
	}

	const typeStr = TYPE_DECODERS[typeByte];
	if (!typeStr) throw new Error(`Unknown type byte ${typeByte}`);
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
	const dynamicLen = new DataView(view.buffer, view.byteOffset).getUint16(offset + 5, true);
	const dynamicStart = offset + 7;
	const dynamicEnd = dynamicStart + dynamicLen;
	const typeStr =
		typeByte === DYNAMIC_TYPE_BYTE ? decoder.decode(view.subarray(dynamicStart, dynamicEnd)) : TYPE_DECODERS[typeByte];
	const count = new DataView(view.buffer, view.byteOffset).getUint32(dynamicEnd, true);
	const nameLen = view[dynamicEnd + 4];
	const nameStart = dynamicEnd + 5;
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

	isOpen() {
		return !!this.ws && this.ws.readyState === WebSocketImpl.OPEN;
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

	async syncTypesFromServer(options = {}) {
		return syncTypesFromServer(options);
	}

	async syncTypesToServer(types, options = {}) {
		return syncTypesToServer(types, options);
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
	module.exports = {
		Client,
		buildTopicData,
		encodeValue,
		decodeValue,
		registerMessageSchema,
		registerMsgDefinition,
		registerMsgDefinitionFromFile,
		syncTypesFromServer,
		syncTypesToServer,
	};
}

if (typeof window !== "undefined") {
	window.ROSClient = {
		Client,
		buildTopicData,
		encodeValue,
		decodeValue,
		registerMessageSchema,
		registerMsgDefinition,
		registerMsgDefinitionFromFile,
		syncTypesFromServer,
		syncTypesToServer,
	};
}
