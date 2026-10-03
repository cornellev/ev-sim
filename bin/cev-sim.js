#!/usr/bin/env -S node --experimental-default-type=module

const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-V") {
    const { CEV_SIM_VERSION } = await import("../app/version.js");
    process.stdout.write(`${CEV_SIM_VERSION}\n`);
    process.exitCode = 0;
} else {
    const marketplace = args[0] === "mkt";
    if (marketplace) process.argv.splice(2, 1);

    import(marketplace ? "../server/marketplace/RegistryCli.js" : "../server/headless/Cli.js")
        .then(async ({ main }) => {
            process.exitCode = await main();
        })
        .catch((error) => {
            process.stderr.write(`${JSON.stringify({
                kind: "cev-sim.headless.error",
                version: 1,
                code: "INTERNAL",
                message: error.message,
            })}\n`);
            process.exitCode = 5;
        });
}
