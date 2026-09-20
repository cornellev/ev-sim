import { expect } from "@playwright/test";

export async function waitForCatalogType(request, type) {
    await expect.poll(async () => {
        const response = await request.get("/api/scripting/units");
        if (!response.ok()) return "";
        const body = await response.json();
        return (body.units || []).some((unit) => unit.type === type) ? type : "";
    }, { timeout: 30_000 }).toBe(type);
}
