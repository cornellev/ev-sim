#!/usr/bin/env -S node --experimental-default-type=module

import("./RegistryCli.js")
    .then(async ({ main }) => {
        process.exitCode = await main();
    })
    .catch(() => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: { code: "INTERNAL", message: "Marketplace registry command failed." },
        })}\n`);
        process.exitCode = 1;
    });
