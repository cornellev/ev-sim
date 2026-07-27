import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/ui",
    outputDir: "./test-results",
    fullyParallel: false,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? "github" : "list",
    use: {
        baseURL: "http://127.0.0.1:3100",
        colorScheme: "dark",
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        video: "retain-on-failure",
    },
    expect: {
        toHaveScreenshot: { animations: "disabled" },
    },
    projects: [
        {
            name: "chromium-desktop",
            use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
        },
    ],
    webServer: {
        command: "npm run build && npm run start",
        url: "http://127.0.0.1:3100",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
            ...process.env,
            NODE_ENV: "production",
            PORT: "3100",
            CEV_SIM_NEXT_DIR: ".next-playwright",
            CEV_SIM_DATA_DIR: ".playwright-data/storage",
            CEV_SIM_LOGS_DIR: ".playwright-data/logs",
        },
    },
});
