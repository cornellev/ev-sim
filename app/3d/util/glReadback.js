/**
 * WebGL2 PIXEL_PACK helpers.
 *
 * Spark's SparkRenderer uses PBOs for splat sorting and can leave one bound.
 * A bound PIXEL_PACK buffer makes a CPU-side `gl.readPixels` throw
 * INVALID_OPERATION. Async reads bind our own PBO, then restore Spark's.
 */

const asyncPixelPackCapability = new WeakMap();
const packAlignmentByContext = new WeakMap();

// Readers restore PACK_ALIGNMENT after each read, so the context's value is
// stable; caching it avoids a synchronous GPU-process query per slot.
function contextPackAlignment(gl) {
    const cached = packAlignmentByContext.get(gl);
    if (cached !== undefined) return cached;
    const alignment = gl.getParameter(gl.PACK_ALIGNMENT);
    const value = Number.isFinite(alignment) ? alignment : 4;
    if (gl && typeof gl === "object") packAlignmentByContext.set(gl, value);
    return value;
}

function supportsAsyncPixelPack(gl) {
    const cached = asyncPixelPackCapability.get(gl);
    if (cached !== undefined) return cached;
    let supported = true;
    try {
        const debug = gl.getExtension?.("WEBGL_debug_renderer_info");
        const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? "") : "";
        // Chromium's software WebGL2 backend exposes these APIs, but its
        // fences can remain TIMEOUT_EXPIRED indefinitely in headless runs.
        supported = !/swiftshader/i.test(renderer);
    } catch {
        supported = true;
    }
    asyncPixelPackCapability.set(gl, supported);
    return supported;
}

/**
 * @param {import("three").WebGLRenderer | null | undefined} renderer
 * @returns {WebGL2RenderingContext | null}
 */
export function getWebGL2Context(renderer) {
    const gl = renderer?.getContext?.();
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) {
        return null;
    }
    if (typeof gl.fenceSync !== "function" || typeof gl.clientWaitSync !== "function") {
        return null;
    }
    if (typeof gl.getBufferSubData !== "function") return null;
    if (!supportsAsyncPixelPack(gl)) return null;
    return gl;
}

/**
 * @template T
 * @param {import("three").WebGLRenderer} renderer
 * @param {() => T} readback
 * @returns {T}
 */
export function withPixelPackBufferUnbound(renderer, readback) {
    const gl = renderer?.getContext?.();
    const isWebGL2 =
        typeof WebGL2RenderingContext !== "undefined" &&
        gl instanceof WebGL2RenderingContext;

    if (!isWebGL2) {
        return readback();
    }

    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    if (previous) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    try {
        return readback();
    } finally {
        if (previous) {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
        }
    }
}

let readbackTaskChannel = null;
const readbackTaskQueue = [];

function ensureReadbackTaskChannel() {
    if (readbackTaskChannel || typeof MessageChannel === "undefined") return readbackTaskChannel;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
        readbackTaskQueue.shift()?.();
        if (readbackTaskQueue.length === 0) channel.port1.unref?.();
    };
    channel.port1.unref?.();
    channel.port2.unref?.();
    readbackTaskChannel = channel;
    return channel;
}

/**
 * Yield so the browser can flush GL commands and signal fences.
 * `clientWaitSync` cannot block: browsers set `MAX_CLIENT_WAIT_TIMEOUT_WEBGL`
 * to 0, and a longer timeout raises INVALID_OPERATION. MessageChannel avoids
 * the nested-timer clamp on the capture hot path.
 */
export function yieldForGpuReadback() {
    return new Promise((resolve) => {
        const channel = ensureReadbackTaskChannel();
        if (!channel) {
            setTimeout(resolve, 0);
            return;
        }
        readbackTaskQueue.push(resolve);
        channel.port1.ref?.();
        channel.port2.postMessage(0);
    });
}

/**
 * Poll `slot` until its fence signals or `timeoutMs` elapses.
 * Every `clientWaitSync` uses timeout 0. The loop yields between polls.
 * @param {PixelPackSlot} slot
 * @param {ArrayBufferView} dest
 * @param {{ timeoutMs?: number, signal?: AbortSignal | null }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitForPixelPack(slot, dest, { timeoutMs = 2000, signal = null } = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
        signal?.throwIfAborted?.();
        if (slot.gl?.isContextLost?.()) return false;
        if (slot.poll(dest)) return true;
        if (!slot.pending) return false;
        if (Date.now() >= deadline) return false;
        await yieldForGpuReadback();
    }
}

/**
 * One GPU pixel-pack buffer + fence. `begin` is non-blocking; `poll` copies
 * to CPU only after the GPU signals the fence (timeout 0 — never stalls).
 *
 * Chrome allocates a client shadow copy for every written READ-usage buffer
 * at `fenceSync`, and since M149 `getBufferSubData` no longer consumes or
 * frees it. Only `bufferData` or `deleteBuffer` releases the shadow, so
 * storage is re-specified before the first write of every batch.
 *
 * A batch (`openBatch` → `readRegion`… → `closeBatch`) packs several reads at
 * distinct byte offsets behind one fence, so `poll` costs one synchronous
 * `getBufferSubData` round trip regardless of the region count.
 */
export class PixelPackSlot {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {number} byteLength
     * @param {{ usage?: number }} [options]
     */
    constructor(gl, byteLength, { usage = gl.STREAM_READ } = {}) {
        this.gl = gl;
        this.byteLength = Math.max(1, byteLength);
        this.usage = usage ?? gl.STREAM_READ;
        this.packAlignment = contextPackAlignment(gl);
        // Storage is specified immediately before the first readPixels of a
        // batch so a foreign fenceSync cannot land between bufferData and the
        // write (Chrome shadow warning).
        this.pbo = gl.createBuffer();
        this._batchOpen = false;
        this._needsStorage = true;
        this.sync = null;
        this.dropped = false;
        this.pollAttempts = 0;
        this.begunAtMs = 0;
        this.maxPollAttempts = 240;
        this.maxAgeMs = 2000;
    }

    get pending() {
        return Boolean(this.sync);
    }

    isStale() {
        if (this.dropped) return true;
        if (!this.sync) return false;
        if (this.pollAttempts >= this.maxPollAttempts) return true;
        if (this.begunAtMs > 0 && Date.now() - this.begunAtMs > this.maxAgeMs) return true;
        return false;
    }

    reset() {
        this._deleteSync();
        this._batchOpen = false;
        this.dropped = false;
        this.pollAttempts = 0;
        this.begunAtMs = 0;
        this._replaceBuffer();
    }

    /**
     * Issue `readPixels` into the PBO. The color framebuffer must already be bound
     * (Three.js `setRenderTarget`).
     */
    begin(x, y, width, height, format, type, attachmentIndex = 0) {
        if (!this.openBatch()) return false;
        try {
            this.readRegion(x, y, width, height, format, type, attachmentIndex, 0);
        } catch (error) {
            this._batchOpen = false;
            throw error;
        }
        return this.closeBatch();
    }

    /** Start a packed batch. Returns false while a previous fence is unread. */
    openBatch() {
        if (this.pending || this._batchOpen || !this.pbo) return false;
        this._batchOpen = true;
        this._needsStorage = true;
        this.pollAttempts = 0;
        this.dropped = false;
        this.begunAtMs = Date.now();
        return true;
    }

    /**
     * Issue one `readPixels` into the open batch at `byteOffset`. The source
     * framebuffer must already be bound. Offsets must be multiples of the
     * element size of `type`.
     */
    readRegion(x, y, width, height, format, type, attachmentIndex = 0, byteOffset = 0) {
        if (!this._batchOpen) throw new Error("PixelPackSlot.readRegion requires an open batch.");
        const gl = this.gl;
        const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        const previousReadBuffer = typeof gl.readBuffer === "function"
            ? gl.getParameter(gl.READ_BUFFER)
            : null;
        try {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
            if (this._needsStorage) {
                gl.bufferData(gl.PIXEL_PACK_BUFFER, this.byteLength, this.usage);
                this._needsStorage = false;
            }
            gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
            if (attachmentIndex > 0 && typeof gl.readBuffer === "function") {
                gl.readBuffer((gl.COLOR_ATTACHMENT0 ?? 0x8CE0) + attachmentIndex);
            }
            gl.readPixels(x, y, width, height, format, type, byteOffset);
            gl.pixelStorei(gl.PACK_ALIGNMENT, this.packAlignment);
        } finally {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
            if (previousReadBuffer !== null) gl.readBuffer(previousReadBuffer);
        }
    }

    /** Fence every region issued since `openBatch`. */
    closeBatch() {
        if (!this._batchOpen) return false;
        this._batchOpen = false;
        const gl = this.gl;
        this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        return Boolean(this.sync);
    }

    /** Discard an open batch without fencing it. */
    abortBatch() {
        if (!this._batchOpen) return;
        this._batchOpen = false;
        this._replaceBuffer();
    }

    /**
     * @param {ArrayBufferView} dest
     * @returns {boolean} true when `dest` has been filled
     */
    poll(dest) {
        if (!this.sync) return false;
        const gl = this.gl;
        this.pollAttempts += 1;
        const status = gl.clientWaitSync(this.sync, 0, 0);
        const signaled = status === (gl.ALREADY_SIGNALED ?? 0x911C)
            || status === (gl.CONDITION_SATISFIED ?? 0x9119);
        if (!signaled) {
            if (status === gl.WAIT_FAILED) {
                this.dropped = true;
                this._deleteSync();
                this.pollAttempts = 0;
                this.begunAtMs = 0;
                this._replaceBuffer();
            }
            return false;
        }
        this._copy(dest);
        return true;
    }

    _copy(dest) {
        const gl = this.gl;
        const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dest);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
        this._deleteSync();
        this.dropped = false;
        this.pollAttempts = 0;
        this.begunAtMs = 0;
    }

    dispose() {
        this._deleteSync();
        this._batchOpen = false;
        this.pollAttempts = 0;
        this.begunAtMs = 0;
        if (this.pbo && this.gl) this.gl.deleteBuffer(this.pbo);
        this.pbo = null;
        this._needsStorage = false;
        this.gl = null;
    }

    _replaceBuffer() {
        const gl = this.gl;
        if (!gl) return;
        if (this.pbo) {
            gl.deleteBuffer(this.pbo);
            this.pbo = null;
        }
        this.pbo = gl.createBuffer();
        this._needsStorage = true;
    }

    _deleteSync() {
        if (!this.sync || !this.gl) return;
        this.gl.deleteSync(this.sync);
        this.sync = null;
    }
}

/** Await one render-target read through a WebGL2 pixel-pack buffer and fence. */
export async function readRenderTargetPixelsWithFence(renderer, target, buffer, {
    signal = null,
    timeoutMs = 2000,
} = {}) {
    const gl = getWebGL2Context(renderer);
    if (!gl) throw new Error("Asynchronous PBR readback requires WebGL2 PBO/fence support.");
    const slot = new PixelPackSlot(gl, buffer.byteLength);
    const type = buffer instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE;
    try {
        signal?.throwIfAborted?.();
        slot.begin(0, 0, target.width, target.height, gl.RGBA, type);
        const ready = await waitForPixelPack(slot, buffer, { timeoutMs, signal });
        if (!ready) {
            if (gl.isContextLost?.()) throw new Error("WebGL2 context was lost during asynchronous readback.");
            throw new Error(`Asynchronous PBR readback exceeded ${timeoutMs} ms.`);
        }
        return buffer;
    } finally {
        slot.dispose();
    }
}
