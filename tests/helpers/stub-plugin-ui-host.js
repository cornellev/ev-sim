const STUB_URL = new URL("./plugin-ui-host-stub.js", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
    if (specifier === "./PluginUiHost.js" || specifier.endsWith("/PluginUiHost.js")) {
        return { url: STUB_URL.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
