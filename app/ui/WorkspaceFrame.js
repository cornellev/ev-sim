import { IconAlertTriangle, IconCheck, IconFolderOff, IconLayoutGrid, IconLoader2 } from "@tabler/icons-react";

import { Button } from "./Button";
import { cx } from "./cx";

export function WorkspaceFrame({
    title,
    subtitle,
    onOpenWorkspace,
    actions,
    sidebar,
    inspector,
    children,
    className,
    contentClassName,
}) {
    return (
        <div className={cx("sf-workspace", className)}>
            <header className="sf-workspace-header">
                <button type="button" className="sf-workspace-identity" onClick={onOpenWorkspace} aria-label="Open workspace switcher">
                    <span className="sf-workspace-identity__product">cev-sim</span>
                    <span className="sf-workspace-identity__divider" aria-hidden="true" />
                    <IconLayoutGrid size={15} stroke={1.75} aria-hidden="true" />
                    <span className="sf-workspace-identity__title">{title}</span>
                    {subtitle && <span className="sf-workspace-identity__subtitle">{subtitle}</span>}
                </button>
                {actions && <div className="sf-workspace-header__actions">{actions}</div>}
            </header>
            <div className="sf-workspace-grid">
                {sidebar && <aside className="sf-workspace-sidebar">{sidebar}</aside>}
                <main className={cx("sf-workspace-content", contentClassName)}>{children}</main>
                {inspector && <aside className="sf-workspace-inspector">{inspector}</aside>}
            </div>
        </div>
    );
}

export function Panel({ material = "inline", className, children, ...props }) {
    return <section className={cx("sf-panel", `sf-panel--${material}`, className)} {...props}>{children}</section>;
}

export function StatusMessage({ tone = "neutral", title, children, className, role }) {
    const Icon = tone === "danger" ? IconAlertTriangle : tone === "success" ? IconCheck : null;
    return (
        <div className={cx("sf-status", `sf-status--${tone}`, className)} role={role || (tone === "danger" ? "alert" : "status")}>
            {Icon && <Icon className="sf-status__icon" size={16} stroke={1.75} aria-hidden="true" />}
            <div>
                {title && <div className="sf-status__title">{title}</div>}
                {children && <div className="sf-status__detail">{children}</div>}
            </div>
        </div>
    );
}

export function AsyncState({ status, title, detail, onRetry, className }) {
    const loading = status === "loading";
    const error = status === "error";
    const Icon = loading ? IconLoader2 : error ? IconAlertTriangle : IconFolderOff;
    return (
        <div className={cx("sf-async-state", className)} role={error ? "alert" : "status"} aria-busy={loading || undefined}>
            <Icon className={cx("sf-async-state__icon", loading && "sf-async-state__icon--spin")} size={20} stroke={1.5} aria-hidden="true" />
            <div className="sf-async-state__title">{title}</div>
            {detail && <p className="sf-async-state__detail">{detail}</p>}
            {error && onRetry && <Button onClick={onRetry}>Retry</Button>}
        </div>
    );
}

export function DesktopRequired() {
    return (
        <div className="sf-desktop-required" role="status">
            <div className="sf-desktop-required__brand">cev-sim</div>
            <h1>Desktop workspace required</h1>
            <p><span className="font-bold">cev-sim</span> is designed for a desktop workspace. Please use a larger screen or increase the window size.</p>
        </div>
    );
}
