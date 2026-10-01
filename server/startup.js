const packageJson = require('../package.json');
const pluginJson = require('../plugin.json');

function startup(directoryRoot, env) {
    if (packageJson.version === '0.1.0' && !process.env.IN_DEVELOPMENT) {
        console.warn(
            '[WARNING] This is an early development build of ev-sim. \nIt is not intended for large scale usage and may contain bugs or incomplete features.\n\nPlease use at your own risk.'
        )
    }
    
    console.log(
        "\n==================================="
    )
    
    console.log(`                         _
   ___ _   __      _____(_)___ ___
  / _ \\ | / /_____/ ___/ / __ \`__ \\
 /  __/ |/ /_____(__  ) / / / / / /
 \\___/|___/     /____/_/_/ /_/ /_/ `)
    
    console.log(
        "\n===================================\n"
    )

    console.log(">> Starting ev-sim server... <<\n");

    console.log("Running v" + packageJson.version + " of ev-sim.\n");
    console.log("Checking that the plugin.json file is valid...");
    if (!pluginJson.name || !pluginJson.version) {
        console.error("Invalid plugin.json file. Please ensure that the name and version fields are set.");
        return false;
    }
    console.log("plugin.json file is valid.\n");
    console.log("Checking that the repository root is valid...");
    if (!directoryRoot) {
        console.error("Invalid repository root. Please ensure that the REPOSITORY_ROOT environment variable is set.");
        return false;
    }
    console.log("Repository root is valid.\n");
    console.log("Checking that the environment variables are valid...");
    if (!env.PORT) {
        console.warn("[WARNING] Warning is not set, defaulting to 3000. Please set the PORT environment variable to change this.");
    }
    if (env.CEV_SIM_JSON_LIMIT && isNaN(parseInt(env.CEV_SIM_JSON_LIMIT))) {
        console.error("Invalid CEV_SIM_JSON_LIMIT environment variable. Please ensure that it is a valid number.");
        return false;
    }
    if (env.CEV_SIM_HEADLESS_JSON_LIMIT && isNaN(parseInt(env.CEV_SIM_HEADLESS_JSON_LIMIT))) {
        console.error("Invalid CEV_SIM_HEADLESS_JSON_LIMIT environment variable. Please ensure that it is a valid number.");
        return false;
    }
    if (env.CEV_SIM_HEADLESS_JSON_LIMIT && env.CEV_SIM_JSON_LIMIT && parseInt(env.CEV_SIM_HEADLESS_JSON_LIMIT) > parseInt(env.CEV_SIM_JSON_LIMIT)) {
        console.error("Invalid CEV_SIM_HEADLESS_JSON_LIMIT environment variable. It cannot be greater than CEV_SIM_JSON_LIMIT.");
        return false;
    }
    if (env.CEV_SIM_MARKETPLACE_ENABLED) {
        console.log("[MARKETPLACE] Marketplace is enabled.");
    } else {
        console.log("[MARKETPLACE] Marketplace is disabled.");
    }
    console.log("Environment variables are valid.\n");




    console.log("Startup checks complete.");

    console.log("\n>> Server startup complete. <<\n");


    return true;
}

module.exports = {
    startup,
}