import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: { rules: { "*.wasm": { type: "wasm" } } },
  webpack(config) {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    config.module.rules.push({ test: /\.wasm$/, type: "webassembly/async" });
    // Next's shared filename generator is invalid for Spark's inline data assets.
    config.module.generator["asset/resource"] = config.module.generator.asset;
    delete config.module.generator.asset;
    return config;
  },
  // Keep browser-test compilation independent from a developer's live server.
  distDir: process.env.CEV_SIM_NEXT_DIR || ".next",
  allowedDevOrigins: ['127.0.0.1'],
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || version,
  },
};

export default nextConfig;
