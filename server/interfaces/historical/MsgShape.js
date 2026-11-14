export const STD_ALIASES = {
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

export function parseMsgDefinition(typeName, msgText) {
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
	return fields;
}

