'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { decodeTopicValue } from "../../client/Client.js";
import { getTelemetryStore } from "../../telemetry/TelemetryRuntime.js";
import { listPerceptionLabels } from "../../autonomy/PerceptionLabelCatalog.js";
import { oracleTopicSignalPath } from "../../scripting/runtime/SignalPaths.js";

const PANEL_COLLAPSED_KEY = "sf.sensor-product-panel.collapsed";

const PANEL_PATHS = Object.freeze([
    "topics./sensors/front_camera/image_raw",
    "devices.front-camera.image",
    "devices.front_camera.image",
    oracleTopicSignalPath("front-camera-depth"),
    oracleTopicSignalPath("front-camera-semantic"),
    "visualization.perception.candidate",
    "visualization.perception.oracle",
    "visualization.perception.status",
    "diagnostics.topics.perception-detections-2d",
]);

const PRODUCT_MODES = [
    { id: "rgb", label: "RGB" },
    { id: "depth", label: "Depth" },
    { id: "semantic", label: "Semantic" },
];

function asImageMessage(value) {
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return null;
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (value.data == null) return null;
    return value;
}

function decodeImageBytes(entry) {
    if (!entry) return null;
    const value = entry.value ?? entry;
    if (!value || entry.exists === false) return null;
    const direct = asImageMessage(value);
    if (direct) return direct;
    if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
        const decoded = decodeTopicValue(value);
        return asImageMessage(decoded?.value);
    }
    return null;
}

function isCameraProductPath(path) {
    const value = String(path || "");
    return value.startsWith("topics.") || value.startsWith("devices.") || value.startsWith("oracle.");
}

function readFirstImage(store, paths) {
    for (const path of paths) {
        const image = decodeImageBytes(store.read(path));
        if (image) return image;
    }
    return null;
}

function imageStampKey(image) {
    if (!image) return "";
    const stamp = image.header?.stamp;
    return `${image.width}x${image.height}:${image.encoding || ""}:${stamp?.sec ?? ""}:${stamp?.nanosec ?? ""}`;
}

function toUint8(data, expectedLength) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data && typeof data === "object" && Number.isFinite(Number(data.length))) {
        return Uint8Array.from({ length: Number(data.length) }, (_, index) => data[index] || 0);
    }
    if (expectedLength > 0 && data && typeof data === "object") {
        const out = new Uint8Array(expectedLength);
        for (let index = 0; index < expectedLength; index += 1) out[index] = data[index] || 0;
        return out;
    }
    return new Uint8Array(expectedLength || 0);
}

function paintRgb(ctx, image, width, height) {
    const data = image.data;
    const encoding = String(image.encoding || "rgba8").toLowerCase();
    const imageData = ctx.createImageData(width, height);
    const out = imageData.data;
    const src = toUint8(data, encoding.includes("rgba") ? out.length : width * height * 3);
    if (encoding.includes("rgba")) {
        out.set(src.subarray(0, Math.min(out.length, src.length)));
    } else if (encoding.includes("rgb")) {
        let si = 0;
        for (let di = 0; di < out.length; di += 4) {
            out[di] = src[si++] || 0;
            out[di + 1] = src[si++] || 0;
            out[di + 2] = src[si++] || 0;
            out[di + 3] = 255;
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

function paintDepth(ctx, image, width, height) {
    const data = image.data;
    const src = data instanceof Float32Array
        ? data
        : ArrayBuffer.isView(data)
            ? new Float32Array(data.buffer, data.byteOffset, width * height)
            : new Float32Array(data);
    let max = 0.001;
    for (let i = 0; i < src.length; i += 1) {
        const v = src[i];
        if (Number.isFinite(v) && v > max) max = v;
    }
    const imageData = ctx.createImageData(width, height);
    const out = imageData.data;
    for (let i = 0; i < src.length; i += 1) {
        const t = Math.max(0, Math.min(1, (src[i] || 0) / max));
        const di = i * 4;
        out[di] = Math.floor(t * 40);
        out[di + 1] = Math.floor(t * 180);
        out[di + 2] = Math.floor(40 + t * 215);
        out[di + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
}

function paintSemantic(ctx, image, width, height) {
    const labels = listPerceptionLabels();
    const palette = new Map(labels.map((label) => {
        const hue = (Number(label.id) * 47) % 360;
        return [Number(label.id), `hsl(${hue} 70% 55%)`];
    }));
    const src = image.data instanceof Uint16Array
        ? image.data
        : ArrayBuffer.isView(image.data)
            ? new Uint16Array(image.data.buffer, image.data.byteOffset, width * height)
            : new Uint16Array(image.data);
    const imageData = ctx.createImageData(width, height);
    const out = imageData.data;
    for (let i = 0; i < src.length; i += 1) {
        const color = palette.get(Number(src[i])) || "hsl(215 20% 30%)";
        const match = /hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/.exec(color);
        const h = Number(match?.[1] || 215) / 360;
        const s = Number(match?.[2] || 20) / 100;
        const l = Number(match?.[3] || 30) / 100;
        const { r, g, b } = hslToRgb(h, s, l);
        const di = i * 4;
        out[di] = r;
        out[di + 1] = g;
        out[di + 2] = b;
        out[di + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
}

function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = Math.round(l * 255);
        return { r: v, g: v, b: v };
    }
    const hue2rgb = (p, q, t) => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
        r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        g: Math.round(hue2rgb(p, q, h) * 255),
        b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
}

function drawBoxes(ctx, boxes, color, width, height) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const box of boxes || []) {
        const cx = Number(box.box2d?.center?.x || 0);
        const cy = Number(box.box2d?.center?.y || 0);
        const sx = Number(box.box2d?.size?.x || 0);
        const sy = Number(box.box2d?.size?.y || 0);
        const x = cx - sx / 2;
        const y = cy - sy / 2;
        if (box.status && box.status !== "ok") {
            ctx.setLineDash([6, 4]);
        } else {
            ctx.setLineDash([]);
        }
        ctx.strokeRect(x, y, sx, sy);
        const label = `${box.classId || "obj"} ${(box.score ?? 1).toFixed(2)}`;
        ctx.fillStyle = color;
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(label, Math.max(0, Math.min(width - 40, x)), Math.max(12, y - 4));
    }
    ctx.restore();
}

function readStatus(store) {
    const vizStatus = store.read("visualization.perception.status")?.value;
    return {
        ageNs: Number.isFinite(vizStatus?.ageNs) ? vizStatus.ageNs : null,
        code: vizStatus?.statusCode || vizStatus?.status || null,
    };
}

function paintProduct(canvas, store, mode, cache) {
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return readStatus(store);

    const rgb = mode === "rgb" && (!cache?.lastPath || isCameraProductPath(cache.lastPath) || !cache.rgb)
        ? readFirstImage(store, [
            "topics./sensors/front_camera/image_raw",
            "devices.front-camera.image",
            "devices.front_camera.image",
        ])
        : cache?.rgb || null;
    const depth = mode === "depth"
        ? readFirstImage(store, [oracleTopicSignalPath("front-camera-depth")])
        : null;
    const semantic = mode === "semantic"
        ? readFirstImage(store, [oracleTopicSignalPath("front-camera-semantic")])
        : null;
    const candidate = store.read("visualization.perception.candidate")?.value;
    const oracle = store.read("visualization.perception.oracle")?.value;
    const nextStatus = readStatus(store);

    const source = mode === "depth" ? depth : mode === "semantic" ? semantic : rgb;
    if (mode === "rgb" && cache) cache.rgb = rgb;
    const width = Number(source?.width || rgb?.width || cache?.width || 640);
    const height = Number(source?.height || rgb?.height || cache?.height || 360);
    if (cache) {
        cache.width = width;
        cache.height = height;
    }
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, width, height);

    const stamp = `${mode}:${imageStampKey(source)}`;
    if (source) {
        if (cache?.stamp !== stamp) {
            if (mode === "depth") paintDepth(ctx, source, width, height);
            else if (mode === "semantic") paintSemantic(ctx, source, width, height);
            else paintRgb(ctx, source, width, height);
            cache.stamp = stamp;
            cache.pixels = ctx.getImageData(0, 0, width, height);
        } else if (cache.pixels) {
            ctx.putImageData(cache.pixels, 0, 0);
        }
    } else {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText("Waiting for camera product…", 16, 28);
        if (cache) {
            cache.stamp = stamp;
            cache.pixels = null;
        }
    }

    drawBoxes(ctx, oracle?.detections2d || [], "#34d399", width, height);
    drawBoxes(ctx, candidate?.detections2d || [], "#38bdf8", width, height);
    return nextStatus;
}

function readCollapsedPreference() {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(PANEL_COLLAPSED_KEY) === "1";
    } catch {
        return false;
    }
}

function writeCollapsedPreference(collapsed) {
    try {
        window.localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
        // Ignore quota / private-mode failures.
    }
}

/**
 * Live camera product panel with candidate/oracle 2D boxes overlaid.
 */
export function SensorProductPanel({
    compact = false,
    className = "",
}) {
    const canvasRef = useRef(null);
    const modeRef = useRef("rgb");
    const collapsedRef = useRef(false);
    const paintRef = useRef(() => {});
    const paintCacheRef = useRef({ stamp: "", pixels: null, rgb: null, width: 0, height: 0, lastPath: "" });
    const store = useMemo(() => getTelemetryStore(), []);
    const [mode, setMode] = useState("rgb");
    const [collapsed, setCollapsed] = useState(false);
    const [status, setStatus] = useState({ ageNs: null, code: null });
    modeRef.current = mode;
    collapsedRef.current = collapsed;

    useEffect(() => {
        setCollapsed(readCollapsedPreference());
    }, []);

    paintRef.current = () => {
        if (collapsedRef.current && !canvasRef.current) {
            const next = readStatus(store);
            setStatus((previous) => (
                previous.ageNs === next.ageNs && previous.code === next.code ? previous : next
            ));
            return;
        }
        const next = paintProduct(canvasRef.current, store, modeRef.current, paintCacheRef.current);
        setStatus((previous) => (
            previous.ageNs === next.ageNs && previous.code === next.code ? previous : next
        ));
    };

    useEffect(() => {
        let frame = 0;
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                paintRef.current();
            });
        };
        const unsubscribe = store.subscribeSignals({
            paths: PANEL_PATHS,
            includeEvents: false,
            includeCatalog: false,
        }, (message) => {
            paintCacheRef.current.lastPath = message?.path;
            schedule();
        });
        paintRef.current();
        return () => {
            unsubscribe();
            if (frame) cancelAnimationFrame(frame);
        };
    }, [store]);

    useEffect(() => {
        paintCacheRef.current.stamp = "";
        paintCacheRef.current.lastPath = "";
        paintRef.current();
    }, [mode, collapsed]);

    const toggleCollapsed = () => {
        setCollapsed((previous) => {
            const next = !previous;
            writeCollapsedPreference(next);
            return next;
        });
    };

    const activeMode = PRODUCT_MODES.find((entry) => entry.id === mode) || PRODUCT_MODES[0];

    return (
        <section
            aria-label="Camera products"
            className={`overflow-hidden rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/90 text-zinc-100 shadow-lg ${className}`}
        >
            <div className={`flex items-center justify-between gap-2 px-2 py-1.5 ${collapsed ? "" : "border-b border-zinc-800"}`}>
                <div className="flex min-w-0 items-center gap-1">
                    {collapsed ? (
                        <p className="truncate text-[11px] font-medium text-zinc-200">Camera · {activeMode.label}</p>
                    ) : (
                        PRODUCT_MODES.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                className={`rounded px-2 py-0.5 text-[11px] ${mode === entry.id ? "bg-sky-500/20 text-sky-200" : "text-zinc-400 hover:text-zinc-200"}`}
                                onClick={() => setMode(entry.id)}
                            >
                                {entry.label}
                            </button>
                        ))
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-zinc-500">
                        {status.code || "ok"}
                        {Number.isFinite(status.ageNs) ? ` · ${(status.ageNs / 1e6).toFixed(0)}ms` : ""}
                    </span>
                    <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/80 text-zinc-200 hover:bg-zinc-800/90"
                        onClick={toggleCollapsed}
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? "Expand camera products" : "Collapse camera products"}
                        title={collapsed ? "Expand camera products" : "Collapse camera products"}
                    >
                        <IconChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? "" : "rotate-180"}`} />
                    </button>
                </div>
            </div>
            {!collapsed && (
                <canvas
                    ref={canvasRef}
                    className={`block w-full bg-black ${compact ? "max-h-40" : "max-h-64"} object-contain`}
                    aria-label="Sensor product panel"
                />
            )}
        </section>
    );
}
