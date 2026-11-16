export const OCCUPANCY_NOT_CONFIGURED = "Occupancy is not configured to be imported.";
export const OCCUPANCY_AMBIGUOUS = "More than one occupancy import is configured.";

/** One subscribe route must map a protobuf message onto an enabled cev.occupancy input. */
export function occupancyImportStatus(resolvedRun) {
    const topicIds = new Set((resolvedRun?.manifest?.topics || [])
        .filter((topic) => topic?.enabled !== false && topic.direction === "input" && topic.valueContract?.id === "cev.occupancy")
        .map((topic) => topic.id));
    const routes = (resolvedRun?.protobufInterface?.document?.routes || []).filter((route) => (
        route?.direction === "subscribe" && topicIds.has(route.target?.topicId)
    ));
    if (routes.length > 1) return { configured: false, message: OCCUPANCY_AMBIGUOUS };
    if (routes.length !== 1) return { configured: false, message: OCCUPANCY_NOT_CONFIGURED };
    return { configured: true, message: "" };
}
