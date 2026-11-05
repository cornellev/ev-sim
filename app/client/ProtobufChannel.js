/** ProtoJSON transport; binary Protobuf encoding belongs to orchestrator. */
export class ProtobufChannel {
    constructor(send) {
        this.send = send;
        this.pending = new Map();
        this.callbacks = new Map();
        this.serial = 0;
        this.binding = null;
    }

    async bind({ runId, fingerprint }) {
        this.close();
        this.binding = { run_id: runId, fingerprint };
        try { await this.request("hello"); }
        catch (error) { this.close(); throw error; }
    }

    async request(op, fields = {}) {
        if (!this.binding) throw new Error("Call bindProtobuf before using Protobuf routes");
        if (this.pending.size >= 32) throw new Error("Too many pending Protobuf operations");
        const request_id = String(++this.serial);
        const text = JSON.stringify({ protocol: "orch.protobuf.v1", op, request_id, ...this.binding, ...fields }, (_, value) => {
            if (typeof value === "bigint") return value.toString();
            if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite Protobuf value");
            return value;
        });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request_id);
                reject(new Error("Protobuf acknowledgement timed out"));
            }, 2000);
            this.pending.set(request_id, { resolve, reject, timer });
            Promise.resolve(this.send(text)).catch((error) => {
                clearTimeout(timer);
                this.pending.delete(request_id);
                reject(error);
            });
        });
    }

    publish(route, value) { return this.request("publish", { route, value }); }

    async subscribe(route, callback) {
        if (this.callbacks.size >= 64 && !this.callbacks.has(route)) throw new Error("Too many Protobuf subscriptions");
        this.callbacks.set(route, callback);
        try { await this.request("subscribe", { route }); }
        catch (error) { this.callbacks.delete(route); throw error; }
    }

    async unsubscribe(route) {
        await this.request("unsubscribe", { route });
        this.callbacks.delete(route);
    }

    async receive(text) {
        const message = JSON.parse(text);
        if (message.protocol !== "orch.protobuf.v1") throw new Error("Unknown text protocol");
        if (message.op === "sample") {
            if (!this.binding || message.run_id !== this.binding.run_id || message.fingerprint !== this.binding.fingerprint) return;
            await this.callbacks.get(message.route)?.(message.value);
        } else {
            const pending = this.pending.get(message.request_id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(message.request_id);
                if (message.op === "error") pending.reject(new Error(message.error));
                else if (message.op === "ack") pending.resolve(message);
                else pending.reject(new Error("Unexpected Protobuf response"));
            }
        }
    }

    close() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Protobuf connection closed; bind a fresh run"));
        }
        this.pending.clear();
        this.callbacks.clear();
        this.binding = null;
    }
}
