import { expect } from "@playwright/test";

export function environmentsDialog(page) {
    return page.getByRole("dialog", { name: "Environments" });
}

export async function openEnvironmentsDialog(page) {
    const dialog = environmentsDialog(page);
    if (!await dialog.isVisible()) {
        await page.getByRole("button", { name: "Environment", exact: true }).click();
    }
    await expect(dialog).toBeVisible();
    return dialog;
}

export async function openStoredEnvironment(page, name) {
    const dialog = await openEnvironmentsDialog(page);
    await dialog.getByRole("option", { name, exact: true }).dblclick();
    await expect(dialog).toBeHidden();
}
