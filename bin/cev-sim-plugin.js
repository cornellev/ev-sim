#!/usr/bin/env -S node --experimental-default-type=module

const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-V") {
    const { CEV_SIM_VERSION } = await import("../app/version.js");
    process.stdout.write(`${CEV_SIM_VERSION}\n`);
    process.exitCode = 0;
} else {
    import("../server/plugins/PluginPackageCli.js")
        .then(async ({ main }) => {
            process.exitCode = await main();
        })
        .catch((error) => {
            process.stderr.write(`${JSON.stringify({
                ok: false,
                error: "PLUGIN_REQUEST_INVALID",
                message: error.message,
            })}\n`);
            process.exitCode = 1;
        });
}
