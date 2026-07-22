/**
 * Decide which document domains are authoritative for a persisted manifest.
 * Missing flags mean "hydrated template data" for backward compatibility.
 */
export function getEnvironmentApplyPolicy(manifest = {}, templateId = "blank") {
    const document = manifest.document ?? {};
    const roadsAuthored = manifest.roadsAuthored === true || document.roadsAuthored === true;
    const buildingsAuthored = manifest.buildingsAuthored === true || document.buildingsAuthored === true;
    const featuresAuthored = manifest.featuresAuthored === true || document.featuresAuthored === true;

    return {
        roadsAuthored,
        buildingsAuthored,
        featuresAuthored,
        rebuildRoads: templateId === "blank" || roadsAuthored,
        rebuildBuildings: buildingsAuthored,
        rebuildFeatures: featuresAuthored,
    };
}

