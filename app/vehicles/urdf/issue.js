/** Diagnostic record shared by the URDF adapter. Not stored on a vehicle manifest. */

export function urdfIssue(code, path, message, severity = "error") {
    return { code, path, message, severity };
}

export function hasUrdfError(issues = []) {
    return issues.some((entry) => entry.severity !== "info" && entry.severity !== "warning");
}
