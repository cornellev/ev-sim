import { clonePluginJson } from "./PluginJson.js";

export const PLUGIN_EFFECT_KINDS = Object.freeze([
    "signal-write",
    "reference-command",
    "topic-publish",
    "overlay-spawn",
]);

const EFFECT_KIND_SET = new Set(PLUGIN_EFFECT_KINDS);

export class PluginEffectJournal {
    constructor() {
        this.frames = [];
    }

    begin() {
        const token = Object.freeze({ index: this.frames.length });
        this.frames.push([]);
        return token;
    }

    _assertTop(token) {
        if (!token || token.index !== this.frames.length - 1) {
            throw new Error("Plugin effect frames must close in stack order.");
        }
    }

    stage(effect) {
        if (this.frames.length === 0) throw new Error("Plugin effects require an active evaluation.");
        const normalized = clonePluginJson(effect, "plugin effect");
        if (!EFFECT_KIND_SET.has(normalized.kind)) {
            throw new Error(`Unsupported plugin effect "${normalized.kind}".`);
        }
        this.frames[this.frames.length - 1].push(Object.freeze(normalized));
    }

    commit(token, apply) {
        this._assertTop(token);
        const effects = this.frames.pop();
        if (this.frames.length > 0) {
            this.frames[this.frames.length - 1].push(...effects);
            return;
        }
        try {
            for (const effect of effects) apply(effect);
        } catch (error) {
            this.frames.push(effects);
            throw error;
        }
    }

    rollback(token) {
        this._assertTop(token);
        this.frames.pop();
    }

    reset() {
        this.frames = [];
    }
}
