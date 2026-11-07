export async function preferRunConfigMode(page, mode) {
    await page.addInitScript((value) => {
        localStorage.setItem("cev-sim.ui.runConfig.mode", value);
    }, mode);
}
