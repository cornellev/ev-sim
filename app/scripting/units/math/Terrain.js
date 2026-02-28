import { BlockOutput, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

function hashNoise(x, y, seed) {
    const v = Math.sin((x * 127.1 + y * 311.7 + seed * 74.7) * 0.0174533) * 43758.5453;
    return v - Math.floor(v);
}

function smoothNoise(x, y, seed) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const sx = x - x0;
    const sy = y - y0;

    const n00 = hashNoise(x0, y0, seed);
    const n10 = hashNoise(x1, y0, seed);
    const n01 = hashNoise(x0, y1, seed);
    const n11 = hashNoise(x1, y1, seed);

    const ix0 = n00 * (1 - sx) + n10 * sx;
    const ix1 = n01 * (1 - sx) + n11 * sx;

    return ix0 * (1 - sy) + ix1 * sy;
}

export function TerrainNoiseUnit({ _uuid }) {
    return (
        <Unit
            title="Terrain Noise"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "seed", type: "float64" },
                { label: "frequency", type: "float64" },
                { label: "amplitude", type: "float64" },
                { label: "octaves", type: "float64" }
            ]}
            outputs={[
                { label: "tex", type: "tex1d" }
            ]}
        />
    );
}

export class TerrainNoiseBlock extends UnitBlock {
    register() {
        this.registerInput("seed", "float64");
        this.registerInput("frequency", "float64");
        this.registerInput("amplitude", "float64");
        this.registerInput("octaves", "float64");
        this.registerOutput("tex", "tex1d");
    }

    valid() {
        return this.hasInput("seed")
            && this.hasInput("frequency")
            && this.hasInput("amplitude")
            && this.hasInput("octaves");
    }

    execute() {
        const seed = this.getInput("seed") || 0;
        const baseFrequency = Math.max(0.0001, this.getInput("frequency") || 1);
        const amplitude = this.getInput("amplitude") || 1;
        const octaves = Math.max(1, Math.min(8, Math.floor(this.getInput("octaves") || 1)));

        const size = 64;
        const out = new Array(size * size);

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let sum = 0;
                let amp = amplitude;
                let freq = baseFrequency;
                let norm = 0;

                for (let o = 0; o < octaves; o++) {
                    const nx = (x / size) * freq * size;
                    const ny = (y / size) * freq * size;
                    sum += smoothNoise(nx, ny, seed + o * 13.37) * amp;
                    norm += amp;
                    amp *= 0.5;
                    freq *= 2.0;
                }

                const value = norm > 0 ? sum / norm : 0;
                out[y * size + x] = Math.max(0, Math.min(1, value));
            }
        }

        return new BlockOutput().set("tex", out);
    }
}

export function NormalizeTextureUnit({ _uuid }) {
    return (
        <Unit
            title="Normalize Texture"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex", type: "tex1d" }
            ]}
            outputs={[
                { label: "out", type: "tex1d" }
            ]}
        />
    );
}

export class NormalizeTextureBlock extends UnitBlock {
    register() {
        this.registerInput("tex", "tex1d");
        this.registerOutput("out", "tex1d");
    }

    valid() {
        return this.hasInput("tex");
    }

    execute() {
        const input = this.getInput("tex") || [];
        if (input.length === 0) {
            return new BlockOutput().set("out", []);
        }

        let min = Infinity;
        let max = -Infinity;
        for (const v of input) {
            if (v < min) min = v;
            if (v > max) max = v;
        }

        const range = max - min;
        if (range <= 0) {
            return new BlockOutput().set("out", input.map(() => 0));
        }

        return new BlockOutput().set("out", input.map(v => (v - min) / range));
    }
}

export function BlendTextureUnit({ _uuid }) {
    return (
        <Unit
            title="Blend Texture"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex a", type: "tex1d" },
                { label: "tex b", type: "tex1d" },
                { label: "blend", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "tex1d" }
            ]}
        />
    );
}

export class BlendTextureBlock extends UnitBlock {
    register() {
        this.registerInput("tex a", "tex1d");
        this.registerInput("tex b", "tex1d");
        this.registerInput("blend", "float64");
        this.registerOutput("out", "tex1d");
    }

    valid() {
        return this.hasInput("tex a") && this.hasInput("tex b") && this.hasInput("blend");
    }

    execute() {
        const a = this.getInput("tex a") || [];
        const b = this.getInput("tex b") || [];
        const t = Math.max(0, Math.min(1, this.getInput("blend") || 0));
        const len = Math.min(a.length, b.length);
        const out = new Array(len);

        for (let i = 0; i < len; i++) {
            out[i] = a[i] * (1 - t) + b[i] * t;
        }

        return new BlockOutput().set("out", out);
    }
}

export function TerraceTextureUnit({ _uuid }) {
    return (
        <Unit
            title="Terrace Texture"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex", type: "tex1d" },
                { label: "steps", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "tex1d" }
            ]}
        />
    );
}

export class TerraceTextureBlock extends UnitBlock {
    register() {
        this.registerInput("tex", "tex1d");
        this.registerInput("steps", "float64");
        this.registerOutput("out", "tex1d");
    }

    valid() {
        return this.hasInput("tex") && this.hasInput("steps");
    }

    execute() {
        const input = this.getInput("tex") || [];
        const steps = Math.max(2, Math.floor(this.getInput("steps") || 8));

        const out = input.map(v => {
            const clamped = Math.max(0, Math.min(1, v));
            return Math.round(clamped * (steps - 1)) / (steps - 1);
        });

        return new BlockOutput().set("out", out);
    }
}

export function HeightToSlopeUnit({ _uuid }) {
    return (
        <Unit
            title="Height To Slope"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex", type: "tex1d" }
            ]}
            outputs={[
                { label: "slope", type: "tex1d" }
            ]}
        />
    );
}

export class HeightToSlopeBlock extends UnitBlock {
    register() {
        this.registerInput("tex", "tex1d");
        this.registerOutput("slope", "tex1d");
    }

    valid() {
        return this.hasInput("tex");
    }

    execute() {
        const input = this.getInput("tex") || [];
        if (input.length === 0) {
            return new BlockOutput().set("slope", []);
        }

        const size = Math.max(1, Math.floor(Math.sqrt(input.length)));
        const slope = new Array(input.length).fill(0);

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = y * size + x;
                const center = input[idx] ?? 0;
                const right = input[y * size + Math.min(size - 1, x + 1)] ?? center;
                const left = input[y * size + Math.max(0, x - 1)] ?? center;
                const up = input[Math.max(0, y - 1) * size + x] ?? center;
                const down = input[Math.min(size - 1, y + 1) * size + x] ?? center;

                const dx = right - left;
                const dy = down - up;
                slope[idx] = Math.min(1, Math.sqrt(dx * dx + dy * dy));
            }
        }

        return new BlockOutput().set("slope", slope);
    }
}
