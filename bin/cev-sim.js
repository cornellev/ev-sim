#!/usr/bin/env -S node --experimental-default-type=module

const marketplace = process.argv[2] === "mkt";
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
