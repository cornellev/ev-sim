/**
 * WebGL2 PIXEL_PACK helpers.
 *
 * Spark's SparkRenderer uses PBOs for splat sorting and can leave one bound.
 * A bound PIXEL_PACK buffer makes a CPU-side `gl.readPixels` throw
 * INVALID_OPERATION. Async reads bind our own PBO, then restore Spark's.
 */

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

/**
 * Yield so the browser can flush GL commands and signal fences.
 * `clientWaitSync` cannot block: browsers set `MAX_CLIENT_WAIT_TIMEOUT_WEBGL`
 * to 0, and a longer timeout raises INVALID_OPERATION.
 */
export function yieldForGpuReadback() {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
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
 * Dropping an unread fence replaces the buffer so the next write cannot
 * discard Chrome's readback shadow.
 */
export class PixelPackSlot {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {number} byteLength
     */
    constructor(gl, byteLength) {
        this.gl = gl;
        this.byteLength = Math.max(1, byteLength);
        this.pbo = gl.createBuffer();
        const alignment = gl.getParameter(gl.PACK_ALIGNMENT);
        this.packAlignment = Number.isFinite(alignment) ? alignment : 4;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.byteLength, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
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
        if (this.pending || !this.pbo) return false;
        const gl = this.gl;
        this.pollAttempts = 0;
        this.dropped = false;
        this.begunAtMs = Date.now();
        try {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
            gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
            if (attachmentIndex > 0 && typeof gl.readBuffer === "function") {
                gl.readBuffer((gl.COLOR_ATTACHMENT0 ?? 0x8CE0) + attachmentIndex);
            }
            gl.readPixels(x, y, width, height, format, type, 0);
            gl.pixelStorei(gl.PACK_ALIGNMENT, this.packAlignment);
            this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
        } finally {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            if (attachmentIndex > 0 && typeof gl.readBuffer === "function") {
                gl.readBuffer(gl.COLOR_ATTACHMENT0 ?? 0x8CE0);
            }
        }
        return Boolean(this.sync);
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
            }
            return false;
        }
        this._copy(dest);
        return true;
    }

    _copy(dest) {
        const gl = this.gl;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dest);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this._deleteSync();
        this.dropped = false;
        this.pollAttempts = 0;
        this.begunAtMs = 0;
    }

    dispose() {
        this._deleteSync();
        this.pollAttempts = 0;
        this.begunAtMs = 0;
        if (this.pbo && this.gl) this.gl.deleteBuffer(this.pbo);
        this.pbo = null;
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
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.byteLength, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
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
