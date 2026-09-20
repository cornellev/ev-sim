#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPluginDirectory } from "../../scripts/create-cev-plugin.mjs";

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "acme.pure-pursuit");
await verifyPluginDirectory(packageRoot);
process.stdout.write("acme.pure-pursuit verify ok\n");
