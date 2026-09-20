function packet(kind, sequence, captureTimeNs, value) {
    const bytes = new Uint8Array(kind === 1 ? 24 : 20);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x43535646, true); // arbitrary fixture magic
    view.setUint8(4, kind);
    view.setUint32(5, sequence, true);
    view.setBigUint64(9, BigInt(captureTimeNs), true);
    if (bytes.length >= 21) view.setFloat32(17, Number(value) || 0, true);
    return bytes;
}

function createSensor() {
    return {
        sequence: 0,
        prepared: false,
        prepare({ calibration }) {
            this.calibration = calibration;
            this.prepared = true;
        },
        reset() {
            this.sequence = 0;
        },
        captureAt({ buffer, calibration, captureTimeNs, sampleIndex, scanDurationNs, sampling }) {
            if (!this.prepared) throw new Error("fixture sensor was not prepared");
            const scale = calibration.parameters.measurementScale;
            for (let offset = 0; offset < buffer.length; offset += 4) {
                if (buffer[offset] > 0) buffer[offset] = Math.min(calibration.scanLayout.maxRangeM, buffer[offset] * scale);
            }
            const messages = [];
            if (calibration.products.points) {
                messages.push({ productId: "points", value: sampling.buildPointCloud2(buffer) });
            }
            if (calibration.products.packets) {
                messages.push({
                    productId: "packets",
                    streamId: "data",
                    payload: packet(1, this.sequence, captureTimeNs, buffer[0]),
                    offsetNs: 0,
                });
                if (this.sequence % calibration.parameters.statusEvery === 0) {
                    messages.push({
                        productId: "packets",
                        streamId: "status",
                        payload: packet(2, this.sequence, captureTimeNs, sampleIndex),
                        offsetNs: Math.min(scanDurationNs - 1, 1_000),
                    });
                }
            }
            this.sequence += 1;
            return {
                messages,
                ...(calibration.products.points ? { observation: sampling.buildObservation(buffer) } : {}),
            };
        },
        getDeterministicState() {
            return { sequence: this.sequence, prepared: this.prepared };
        },
        hydrateDeterministicState(state = {}) {
            this.sequence = Number(state.sequence) || 0;
            this.prepared = state.prepared === true;
        },
        finalize() {
            return { sequence: this.sequence };
        },
        dispose() {
            this.prepared = false;
        },
    };
}

const plugin = {
    register(api) {
        api.contributeSensorType({
            type: "test.range-image-fixture.synthetic-3x4",
            create: createSensor,
        });
    },
};

export default plugin;
