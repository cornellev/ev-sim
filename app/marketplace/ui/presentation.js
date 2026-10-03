const INSTALL_PHASE_LABELS = Object.freeze({
    queued: "Preparing",
    download: "Preparing",
    plan: "Preparing",
    verify: "Verifying",
    "awaiting-confirmation": "Ready to install",
    commit: "Installing",
    recover: "Recovering",
    "needs-attention": "Needs attention",
    failed: "Failed",
    cancelled: "Cancelled",
    complete: "Complete",
});

const PUBLISH_PHASE_LABELS = Object.freeze({
    queued: "Preparing",
    build: "Preparing",
    inspect: "Preparing",
    "awaiting-confirmation": "Ready to publish",
    "publish-artifacts": "Publishing",
    "publish-previews": "Publishing",
    "publish-items": "Publishing",
    "sign-releases": "Publishing",
    "publish-releases": "Publishing",
    refresh: "Publishing",
    "needs-attention": "Needs attention",
    failed: "Failed",
    cancelled: "Cancelled",
    complete: "Complete",
});

const HEALTH_LABELS = Object.freeze({
    ready: "Ready",
    complete: "Complete",
    offline: "Offline",
    stale: "Stale",
    expired: "Expired",
    untrusted: "Untrusted",
    unavailable: "Unavailable",
    yanked: "Yanked",
    blocked: "Blocked",
});

const DRAFT_STATE_LABELS = Object.freeze({
    incomplete: "Draft",
    ready: "Ready",
    "preflight-failed": "Preflight failed",
    prepared: "Prepared",
    publishing: "Publishing",
    "needs-attention": "Needs attention",
    published: "Published",
});

const SORT_LABELS = Object.freeze({
    name: "Name",
    kind: "Kind",
    version: "Release version",
    source: "Source",
});

function shown(value) {
    if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
    if (value === null || value === undefined || value === "") return "none";
    return String(value);
}

export function displayKind(value) {
    return String(value || "").split("-").filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (number < 1024) return `${number} B`;
    if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KiB`;
    if (number < 1024 ** 3) return `${(number / 1024 ** 2).toFixed(1)} MiB`;
    return `${(number / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatCompatibilityIssue(issue) {
    switch (issue?.code) {
    case "CEV_SIM_VERSION":
        return `Requires cev-sim ${shown(issue.required)}. This host is ${shown(issue.actual)}.`;
    case "PLATFORM":
        return `Requires platform ${shown(issue.required)}. This host is ${shown(issue.actual)}.`;
    case "ARCHITECTURE":
        return `Requires architecture ${shown(issue.required)}. This host is ${shown(issue.actual)}.`;
    case "RUNTIME":
        return `Requires runtime ${shown(issue.required)}. This host has ${shown(issue.actual)}.`;
    case "FEATURE":
        return `Requires feature ${shown(issue.required)}.`;
    case "CONTRACT":
        return `Requires contract ${shown(issue.required?.kind)}@${shown(issue.required?.versions)}.`;
    case "BACKEND":
        return `Requires backend ${shown(issue.required?.kind)}:${shown(issue.required?.id)}@${shown(issue.required?.version)}.`;
    case "LIFECYCLE_UNAVAILABLE":
        return "This content cannot be installed in this version.";
    case "ARTIFACT_LIMIT_EXCEEDED":
        return "The release is larger than this host allows.";
    case "PUBLISHER_NOT_APPROVED":
        return "The publisher is not approved on this host.";
    case "RELEASE_BLOCKED":
        return "A security advisory blocks this release.";
    default:
        return "This release is not eligible for this host.";
    }
}

export function installPhaseLabel(phase) {
    return INSTALL_PHASE_LABELS[phase] ?? "Unavailable";
}

export function publishPhaseLabel(phase) {
    return PUBLISH_PHASE_LABELS[phase] ?? "Unavailable";
}

export function publicationRecoveryActions(job) {
    const operationsComplete = Number.isSafeInteger(job?.progress?.operationsComplete) ? job.progress.operationsComplete : 0;
    const operationsTotal = Number.isSafeInteger(job?.progress?.operationsTotal) ? job.progress.operationsTotal : 0;
    if (operationsComplete > 0) {
        return Object.freeze({
            replan: false,
            resume: true,
            detail: `${operationsComplete} of ${operationsTotal} registry writes finished. Those writes stay on the registry. Resume continues the remaining uploads.`,
        });
    }
    return Object.freeze({ replan: true, resume: true, detail: null });
}

export function sourceHealthLabel(status) {
    return HEALTH_LABELS[status] ?? "Unavailable";
}

export function healthTone(status) {
    if (status === "ready" || status === "complete") return "success";
    if (status === "offline" || status === "stale" || status === "expired" || status === "update") return "warning";
    if (status === "untrusted" || status === "yanked" || status === "blocked") return "danger";
    return "neutral";
}

export function draftStateLabel(state) {
    return DRAFT_STATE_LABELS[state] ?? "Draft";
}

export function sortLabel(sort) {
    return SORT_LABELS[sort] ?? "Name";
}

export function releaseMatchesAdvisory(entry, record) {
    if (!entry || !record || record.registryId !== entry.registryId) return false;
    const packageHashes = new Set();
    for (const mapping of entry.mappings ?? []) {
        for (const hash of Object.values(mapping.hashes ?? {})) {
            if (typeof hash === "string") packageHashes.add(hash);
        }
    }
    return (record.advisory?.affected ?? []).some((subject) => (
        (subject.itemId === entry.itemId && subject.releaseVersion === entry.releaseVersion)
        || subject.artifactSha256 === entry.artifactSha256
        || (subject.packageHash && packageHashes.has(subject.packageHash))
    ));
}
