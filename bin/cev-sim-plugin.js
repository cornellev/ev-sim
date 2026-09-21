#!/usr/bin/env -S node --experimental-default-type=module

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
