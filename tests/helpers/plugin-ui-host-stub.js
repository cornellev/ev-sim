export class PluginUiHost {
    constructor({ moduleSource = null } = {}) {
        this.moduleSource = moduleSource;
        this.diagnostics = new Map();
    }

    async loadPackageUi(verified) {
        if (typeof this.moduleSource?.importUi === "function") {
            await this.moduleSource.importUi(verified);
        }
    }

    diagnostic(type) {
        return this.diagnostics.get(type) || null;
    }

    noteDiagnostic(type, message) {
        const text = String(message ?? "").trim();
        if (!type || !text) return;
        const current = this.diagnostics.get(type);
        this.diagnostics.set(type, current ? `${current} ${text}` : text);
    }
}
