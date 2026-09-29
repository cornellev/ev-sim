import { authorizeBrowserPackage } from "./BrowserMarketplacePolicy.js";

function encodedPath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}

export class BrowserPluginModuleSource {
    constructor({
        baseUrl = "/api/storage/plugins",
        authorizePackage = typeof window === "undefined" ? null : authorizeBrowserPackage,
    } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.authorizePackage = authorizePackage;
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
        if (this.authorizePackage) await this.authorizePackage(verifiedPackage.resource.packageHash);
        return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ this.runtimeUrl(verifiedPackage));
    }

    async importUi(verifiedPackage) {
        const url = this.uiUrl(verifiedPackage);
        if (!url) return null;
        if (this.authorizePackage) await this.authorizePackage(verifiedPackage.resource.packageHash);
        return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
    }
}
