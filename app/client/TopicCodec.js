/**
 * ROS topic encode/decode and dynamic .msg schemas.
 * Transport (WebSocket, subscribe/publish framing) stays in Client.js.
 */

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

export const TYPE_DECODERS = Object.entries(TYPE_ENCODERS).reduce((acc, [k, v]) => {
	acc[v] = k;
	return acc;
}, {});

export const DYNAMIC_TYPE_BYTE = 0xff;
export const MAX_TOPIC_NAME_LEN = 255;
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

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

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

export function registerMessageSchema(typeName, fields) {
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

export function listRegisteredSchemaTypes() {
	return [...new Set([...DYNAMIC_SCHEMAS.keys(), ...Object.keys(TYPE_ENCODERS)])];
}

export function hasRegisteredSchema(typeStr) {
	const normalized = normalizeTypeName(typeStr, null);
	return TYPE_ENCODERS[normalized] !== undefined || DYNAMIC_SCHEMAS.has(normalized);
}

export async function registerMsgDefinitionFromFile(typeName, fileText) {
	const data = await fetch(fileText);
	if (!data.ok) throw new Error(`Failed to load message definition from ${fileText}: ${data.status} ${data.statusText}`);
	const text = await data.text();
	registerMsgDefinition(typeName, text);
}

export function registerMsgDefinition(typeName, msgText) {
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

export function requireBytes(bytes, offset, size, label) {
	if (offset < 0 || size < 0 || offset + size > bytes.length) {
		throw new Error(`Truncated ${label}: need ${size} bytes at offset ${offset}, have ${bytes.length - offset}`);
	}
}

function _decodePrimitive(typeName, bytes, offset) {
	const t = typeName.toLowerCase();
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	switch (t) {
		case "string": {
			requireBytes(bytes, offset, 4, "string length");
			const n = dv.getUint32(offset, true);
			const start = offset + 4;
			requireBytes(bytes, start, n, "string payload");
			const end = start + n;
			return { value: decoder.decode(bytes.subarray(start, end)), next: end };
		}
		case "bool":
			requireBytes(bytes, offset, 1, "bool");
			return { value: bytes[offset] !== 0, next: offset + 1 };
		case "int8":
			requireBytes(bytes, offset, 1, "int8");
			return { value: dv.getInt8(offset), next: offset + 1 };
		case "char": {
			requireBytes(bytes, offset, 1, "char");
			const code = dv.getInt8(offset);
			if (code < 0 || code > 127) throw new Error("char payload must be an ASCII codepoint (0-127)");
			return { value: String.fromCharCode(code), next: offset + 1 };
		}
		case "uint8":
		case "byte":
			requireBytes(bytes, offset, 1, "byte");
			return { value: dv.getUint8(offset), next: offset + 1 };
		case "int16":
			requireBytes(bytes, offset, 2, "int16");
			return { value: dv.getInt16(offset, true), next: offset + 2 };
		case "uint16":
			requireBytes(bytes, offset, 2, "uint16");
			return { value: dv.getUint16(offset, true), next: offset + 2 };
		case "int32":
			requireBytes(bytes, offset, 4, "int32");
			return { value: dv.getInt32(offset, true), next: offset + 4 };
		case "uint32":
			requireBytes(bytes, offset, 4, "uint32");
			return { value: dv.getUint32(offset, true), next: offset + 4 };
		case "int64":
			requireBytes(bytes, offset, 8, "int64");
			return { value: dv.getBigInt64(offset, true), next: offset + 8 };
		case "uint64":
			requireBytes(bytes, offset, 8, "uint64");
			return { value: dv.getBigUint64(offset, true), next: offset + 8 };
		case "float32":
			requireBytes(bytes, offset, 4, "float32");
			return { value: dv.getFloat32(offset, true), next: offset + 4 };
		case "float64":
			requireBytes(bytes, offset, 8, "float64");
			return { value: dv.getFloat64(offset, true), next: offset + 8 };
		case "duration": {
			requireBytes(bytes, offset, 8, "duration");
			const sec = dv.getInt32(offset, true);
			const nsec = dv.getInt32(offset + 4, true);
			return { value: sec + nsec / 1e9, next: offset + 8 };
		}
		case "time": {
			requireBytes(bytes, offset, 8, "time");
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
				requireBytes(bytes, cursor, 4, `array length for '${field.name}'`);
				count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(cursor, true);
				cursor += 4;
			}

			if ((field.typeName === "uint8" || field.typeName === "byte") && Number.isInteger(count)) {
				requireBytes(bytes, cursor, count, `byte array '${field.name}'`);
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

export function encodeValue(typeStr, value) {
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

export function decodeValue(view, offset) {
	requireBytes(view, offset, 5, "typed envelope");
	const typeByte = view[offset];
	const count = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(offset + 1, true);
	const start = offset + 5;
	requireBytes(view, start, count, "typed payload");
	const slice = view.subarray(start, start + count);

	if (typeByte === DYNAMIC_TYPE_BYTE) {
		requireBytes(slice, 0, 2, "dynamic type name length");
		const nameLen = new DataView(slice.buffer, slice.byteOffset, slice.byteLength).getUint16(0, true);
		const nameStart = 2;
		requireBytes(slice, nameStart, nameLen, "dynamic type name");
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
			requireBytes(slice, 0, 16, "ColorRGBA");
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
