#!/usr/bin/env -S node --experimental-default-type=module

const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-V") {
    const { CEV_SIM_VERSION } = await import("../../app/version.js");
    process.stdout.write(`${CEV_SIM_VERSION}\n`);
    process.exitCode = 0;
} else {
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
}
