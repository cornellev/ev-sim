import { readProtobufFile } from "./ProtobufSourceLoader.js";
import { normalizeZenohBrowserConfig } from "../../app/client/ZenohBrowserConfig.js";

export { normalizeZenohBrowserConfig };

export async function readZenohBrowserConfig(env = process.env) {
    if (!env.CEV_SIM_ZENOH_BROWSER_CONFIG) return null;
    const bytes = await readProtobufFile(env.CEV_SIM_ZENOH_BROWSER_CONFIG, 16 * 1024);
    return normalizeZenohBrowserConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
