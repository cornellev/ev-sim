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

    async importRuntime(verifiedPackage) {
        return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ this.runtimeUrl(verifiedPackage));
    }
}
