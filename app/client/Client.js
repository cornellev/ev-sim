
let WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : null;

function getWebSocketImpl() {
	if (WebSocketImpl) return WebSocketImpl;
	// Node-only fallback; keep out of worker top-level evaluation.
	// eslint-disable-next-line global-require
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
const MAX_TOPIC_NAME_LEN = 255;
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

function listRegisteredSchemaTypes() {
	return [...new Set([...DYNAMIC_SCHEMAS.keys(), ...Object.keys(TYPE_ENCODERS)])];
}

function hasRegisteredSchema(typeStr) {
	const normalized = normalizeTypeName(typeStr, null);
	return TYPE_ENCODERS[normalized] !== undefined || DYNAMIC_SCHEMAS.has(normalized);
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

function _requireBytes(bytes, offset, size, label) {
	if (offset < 0 || size < 0 || offset + size > bytes.length) {
		throw new Error(`Truncated ${label}: need ${size} bytes at offset ${offset}, have ${bytes.length - offset}`);
	}
}

function _decodePrimitive(typeName, bytes, offset) {
	const t = typeName.toLowerCase();
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	switch (t) {
		case "string": {
			_requireBytes(bytes, offset, 4, "string length");
			const n = dv.getUint32(offset, true);
			const start = offset + 4;
			_requireBytes(bytes, start, n, "string payload");
			const end = start + n;
			return { value: decoder.decode(bytes.subarray(start, end)), next: end };
		}
		case "bool":
			_requireBytes(bytes, offset, 1, "bool");
			return { value: bytes[offset] !== 0, next: offset + 1 };
		case "int8":
			_requireBytes(bytes, offset, 1, "int8");
			return { value: dv.getInt8(offset), next: offset + 1 };
		case "char": {
			_requireBytes(bytes, offset, 1, "char");
			const code = dv.getInt8(offset);
			if (code < 0 || code > 127) throw new Error("char payload must be an ASCII codepoint (0-127)");
			return { value: String.fromCharCode(code), next: offset + 1 };
		}
		case "uint8":
		case "byte":
			_requireBytes(bytes, offset, 1, "byte");
			return { value: dv.getUint8(offset), next: offset + 1 };
		case "int16":
			_requireBytes(bytes, offset, 2, "int16");
			return { value: dv.getInt16(offset, true), next: offset + 2 };
		case "uint16":
			_requireBytes(bytes, offset, 2, "uint16");
			return { value: dv.getUint16(offset, true), next: offset + 2 };
		case "int32":
			_requireBytes(bytes, offset, 4, "int32");
			return { value: dv.getInt32(offset, true), next: offset + 4 };
		case "uint32":
			_requireBytes(bytes, offset, 4, "uint32");
			return { value: dv.getUint32(offset, true), next: offset + 4 };
		case "int64":
			_requireBytes(bytes, offset, 8, "int64");
			return { value: dv.getBigInt64(offset, true), next: offset + 8 };
		case "uint64":
			_requireBytes(bytes, offset, 8, "uint64");
			return { value: dv.getBigUint64(offset, true), next: offset + 8 };
		case "float32":
			_requireBytes(bytes, offset, 4, "float32");
			return { value: dv.getFloat32(offset, true), next: offset + 4 };
		case "float64":
			_requireBytes(bytes, offset, 8, "float64");
			return { value: dv.getFloat64(offset, true), next: offset + 8 };
		case "duration": {
			_requireBytes(bytes, offset, 8, "duration");
			const sec = dv.getInt32(offset, true);
			const nsec = dv.getInt32(offset + 4, true);
			return { value: sec + nsec / 1e9, next: offset + 8 };
		}
		case "time": {
			_requireBytes(bytes, offset, 8, "time");
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
				_requireBytes(bytes, cursor, 4, `array length for '${field.name}'`);
				count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(cursor, true);
				cursor += 4;
			}

			if ((field.typeName === "uint8" || field.typeName === "byte") && Number.isInteger(count)) {
				_requireBytes(bytes, cursor, count, `byte array '${field.name}'`);
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
		case "int8": {
			const out = new Uint8Array(1);
			new DataView(out.buffer).setInt8(0, value ?? 0);
			return out;
		}
		case "char": {
			let code;
			if (typeof value === "string") {
				if (value.length !== 1) throw new Error("char value must be a single character");
				code = value.charCodeAt(0);
				if (code > 127) throw new Error("char value must be a single ASCII character (0-127)");
			} else {
				code = Number(value ?? 0);
				if (!Number.isInteger(code) || code < -128 || code > 127) {
					throw new Error("char value must fit in signed int8");
				}
			}
			const out = new Uint8Array(1);
			new DataView(out.buffer).setInt8(0, code);
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
			payload = _encodePrimitive("string", value);
			break;
		case "std_msgs/Int32":
			payload = _encodePrimitive("int32", value);
			break;
		case "std_msgs/Float32":
			payload = _encodePrimitive("float32", value);
			break;
		case "std_msgs/Bool":
			payload = _encodePrimitive("bool", value);
			break;
		case "std_msgs/Float64":
			payload = _encodePrimitive("float64", value);
			break;
		case "std_msgs/Int64":
			payload = _encodePrimitive("int64", value);
			break;
		case "std_msgs/UInt32":
			payload = _encodePrimitive("uint32", value);
			break;
		case "std_msgs/UInt64":
			payload = _encodePrimitive("uint64", value);
			break;
		case "std_msgs/Byte":
			payload = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
			break;
		case "std_msgs/Char":
			payload = _encodePrimitive("char", value);
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
			payload = _encodePrimitive("duration", value);
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

export function encodeTopicValue(typeStr, value) {
	return encodeValue(typeStr, value);
}

export function decodeTopicValue(encoded) {
	if (!encoded) return null;
	const view = encoded instanceof Uint8Array
		? encoded
		: ArrayBuffer.isView(encoded)
			? new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength)
			: null;
	if (!view) return null;
	try {
		return decodeValue(view, 0);
	} catch {
		return null;
	}
}

function decodeValue(view, offset) {
	_requireBytes(view, offset, 5, "typed envelope");
	const typeByte = view[offset];
	const count = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(offset + 1, true);
	const start = offset + 5;
	_requireBytes(view, start, count, "typed payload");
	const slice = view.subarray(start, start + count);

	if (typeByte === DYNAMIC_TYPE_BYTE) {
		_requireBytes(slice, 0, 2, "dynamic type name length");
		const nameLen = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getUint16(0, true);
		const nameStart = 2;
		_requireBytes(slice, nameStart, nameLen, "dynamic type name");
		const nameEnd = nameStart + nameLen;
		const typeStr = decoder.decode(slice.subarray(nameStart, nameEnd));
		const valueBytes = slice.subarray(nameEnd);
		const decoded = _decodeTypedValue(typeStr, valueBytes, 0);
		if (!decoded || decoded.next !== valueBytes.length) {
			throw new Error(`Failed to fully decode dynamic type '${typeStr}'`);
		}
		return { type: typeStr, value: decoded.value, next: start + count };
	}

	const typeStr = TYPE_DECODERS[typeByte];
	if (!typeStr) throw new Error(`Unknown type byte ${typeByte}`);
	let value;
	switch (typeStr) {
		case "std_msgs/String":
			value = _decodePrimitive("string", slice, 0).value;
			break;
		case "std_msgs/Int32":
			value = _decodePrimitive("int32", slice, 0).value;
			break;
		case "std_msgs/Float32":
			value = _decodePrimitive("float32", slice, 0).value;
			break;
		case "std_msgs/Bool":
			value = _decodePrimitive("bool", slice, 0).value;
			break;
		case "std_msgs/Float64":
			value = _decodePrimitive("float64", slice, 0).value;
			break;
		case "std_msgs/Int64":
			value = _decodePrimitive("int64", slice, 0).value;
			break;
		case "std_msgs/UInt32":
			value = _decodePrimitive("uint32", slice, 0).value;
			break;
		case "std_msgs/UInt64":
			value = _decodePrimitive("uint64", slice, 0).value;
			break;
		case "std_msgs/Byte":
			value = slice;
			break;
		case "std_msgs/Char":
			value = _decodePrimitive("char", slice, 0).value;
			break;
		case "std_msgs/ColorRGBA": {
			_requireBytes(slice, 0, 16, "ColorRGBA");
			const dv = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
			value = [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
			break;
		}
		case "std_msgs/Duration":
			value = _decodePrimitive("duration", slice, 0).value;
			break;
		default:
			throw new Error(`Unhandled type ${typeStr}`);
	}
	return { type: typeStr, value, next: start + count };
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
		onEcho,
		onNewTopic,
		onUpdate,
		onBigUpdate,
		onError,
		onOpen,
		onClose,
	} = {}) {
		this.url = url;
		this.reconnect = reconnect;
		this.backoff = backoff;
		this.backoffMax = backoffMax;
		this.autoSubscribe = autoSubscribe;
		this.debug = debug;

		this.onEcho = onEcho;
		this.onNewTopic = onNewTopic;
		this.onUpdate = onUpdate;
		this.onBigUpdate = onBigUpdate;
		this.onError = onError;
		this.onOpen = onOpen;
		this.onClose = onClose;

		this.ws = null;
		this.stopped = false;
		this._connected = false;
		this._startPromise = null;
		this._ready = Promise.resolve();
		this._readyResolve = () => {};
		this._readyReject = () => {};
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

	async publish(topic, typeStr, value) {
		const payload = buildTopicData(topic, typeStr, value);
		const out = new Uint8Array(1 + payload.length);
		out[0] = OP_CODES.publish;
		out.set(payload, 1);
		await this._send(out);
	}

	async publishEncoded(topic, encodedValue) {
		const encodedName = encoder.encode(topic);
		const payload = buildTopicDataFromEncodedName(encodedName, encodedValue);
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

	async _send(data) {
		if (data === undefined) return; // ignore empty sends
		if (this.stopped) throw new Error("Client stopped");

		await this._ready;
		if (this.stopped) throw new Error("Client stopped");
		if (!this.ws || this.ws.readyState !== getWebSocketImpl().OPEN) throw new Error("WebSocket not open");
		this.ws.send(data);
	}
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export {
	Client,
	MAX_TOPIC_NAME_LEN,
	buildTopicData,
	decodeValue,
	hasRegisteredSchema,
	listRegisteredSchemaTypes,
	registerMessageSchema,
	registerMsgDefinition,
	registerMsgDefinitionFromFile,
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

if (typeof window !== "undefined") {
	window.ROSClient = {
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
