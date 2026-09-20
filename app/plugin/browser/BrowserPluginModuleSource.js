function encodedPath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}

export class BrowserPluginModuleSource {
    constructor({ baseUrl = "/api/storage/plugins" } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }

    runtimeUrl(verifiedPackage) {
        return `${this.baseUrl}/packages/${verifiedPackage.resource.packageHash}/files/${encodedPath(verifiedPackage.document.entry.runtime)}`;
    }

    uiUrl(verifiedPackage) {
        const entry = verifiedPackage.document.entry?.ui;
        if (!entry) return null;
        return `${this.baseUrl}/packages/${verifiedPackage.resource.packageHash}/files/${encodedPath(entry)}`;
    }

    assetUrl(verifiedPackage, relativePath) {
        const allowed = new Set(verifiedPackage.document.editor?.assets || []);
        const member = String(relativePath ?? "");
        if (!allowed.has(member)) {
            throw new Error(`Plugin asset "${member}" is not declared in editor.assets.`);
        }
        return `${this.baseUrl}/packages/${verifiedPackage.resource.packageHash}/files/${encodedPath(member)}`;
    }

    async importRuntime(verifiedPackage) {
        return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ this.runtimeUrl(verifiedPackage));
    }

    async importUi(verifiedPackage) {
        const url = this.uiUrl(verifiedPackage);
        if (!url) return null;
        return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
    }
}
