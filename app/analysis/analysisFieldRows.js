import { flattenNumericFields } from "../logging/LogDataset.js";

export function formatAnalysisValue(value) {
    if (value === undefined) return "—";
    if (typeof value === "number") {
        return Number.isInteger(value)
            ? String(value)
            : value.toPrecision(7).replace(/0+$/, "").replace(/\.$/, "");
    }
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return `[${value.length}]`;
    if (value && typeof value === "object") {
        const keys = Object.keys(value);
        if (keys.length > 6) return `{${keys.length} keys}`;
        try {
            const text = JSON.stringify(value);
            return text.length > 48 ? `${text.slice(0, 45)}…` : text;
        } catch {
            return String(value);
        }
    }
    return String(value);
}

export function buildAnalysisFieldRows(descriptors = [], snapshot = {}, query = "") {
    const rows = [];
    for (const descriptor of descriptors) {
        const raw = snapshot?.[descriptor.path];
        const latest = raw?.value !== undefined && raw?.type ? raw.value : raw;
        if (descriptor.type === "bytes" || descriptor.logClass === "heavy") {
            rows.push({ descriptor, path: descriptor.path, field: "", value: undefined, numeric: false });
            continue;
        }
        const numeric = flattenNumericFields(latest);
        if (typeof latest === "number" || numeric.length === 0) {
            rows.push({
                descriptor,
                path: descriptor.path,
                field: "",
                value: latest,
                numeric: typeof latest === "number",
            });
        }
        for (const child of numeric) {
            if (!child.field && typeof latest === "number") continue;
            rows.push({
                descriptor,
                path: descriptor.path,
                field: child.field,
                value: child.value,
                numeric: true,
            });
        }
    }
    const lower = String(query || "").toLowerCase();
    if (!lower) return rows;
    return rows.filter((row) => `${row.path}.${row.field} ${row.descriptor.type} ${row.descriptor.unit || ""}`.toLowerCase().includes(lower));
}

export function groupAnalysisFieldRows(fieldRows = []) {
    const groups = new Map();
    for (const row of fieldRows) {
        const group = row.path.split(".")[0] || "signals";
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(row);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
