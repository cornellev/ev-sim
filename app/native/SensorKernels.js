/**
 * Lazy WASM LiDAR packers. JS fallback lives in SensorMessages.js.
 * Generated glue: app/native/sensor_kernels/ (rebuild via `npm run build:kernels`).
 */

let wasmModule = null;
let initPromise = null;
let initFailed = false;

function calibrationArgs(calibration) {
    const azimuth = calibration?.azimuth || { startDeg: -180, endDeg: 180, stepDeg: 2 };
    const elevation = calibration?.elevation || { startDeg: -20, endDeg: 20, stepDeg: 1 };
    return {
        range: Number(calibration?.range || 20),
        azStart: Number(azimuth.startDeg),
        azEnd: Number(azimuth.endDeg),
        azStep: Number(azimuth.stepDeg),
        elStart: Number(elevation.startDeg),
        elEnd: Number(elevation.endDeg),
        elStep: Number(elevation.stepDeg),
    };
}

export async function initSensorKernels() {
    if (wasmModule) return wasmModule;
    if (initFailed) return null;
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            const mod = await import("./sensor_kernels/sensor_kernels.js");
            // Prefer a static public URL so Next/webpack do not need wasm loaders.
            const wasmUrl = typeof window !== "undefined"
                ? "/native/sensor_kernels_bg.wasm"
                : undefined;
            await mod.default(wasmUrl ? { module_or_path: wasmUrl } : undefined);
            wasmModule = mod;
            return mod;
        } catch (error) {
            initFailed = true;
            if (typeof console !== "undefined") {
                console.warn("sensor_kernels WASM unavailable; using JS packers.", error?.message || error);
            }
            return null;
        }
    })();
    return initPromise;
}

export function sensorKernelsReady() {
    return Boolean(wasmModule);
}

/**
 * @returns {{ width: number, data: Uint8Array, pointStep: number } | null}
 */
export function tryPackPointCloud2Wasm(buffer, calibration, bufferEncoding = "legacy-normalized") {
    if (!wasmModule) return null;
    const args = calibrationArgs(calibration);
    const data = wasmModule.pack_pointcloud2(
        buffer instanceof Float32Array ? buffer : new Float32Array(buffer),
        args.range,
        args.azStart,
        args.azEnd,
        args.azStep,
        args.elStart,
        args.elEnd,
        args.elStep,
        bufferEncoding,
    );
    return { width: data.length / 16, data: new Uint8Array(data), pointStep: 16 };
}

/**
 * @returns {{ width: number, data: Uint8Array, pointStep: number } | null}
 */
export function tryPackSemanticPointCloud2Wasm(buffer, calibration, bufferEncoding = "metric-v2") {
    if (!wasmModule) return null;
    const args = calibrationArgs(calibration);
    const data = wasmModule.pack_semantic_pointcloud2(
        buffer instanceof Float32Array ? buffer : new Float32Array(buffer),
        args.range,
        args.azStart,
        args.azEnd,
        args.azStep,
        args.elStart,
        args.elEnd,
        args.elStep,
        bufferEncoding,
    );
    return { width: data.length / 28, data: new Uint8Array(data), pointStep: 28 };
}
