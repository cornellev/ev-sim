import ReactMarkdown from "react-markdown";

function safeUrl(value) {
    try {
        const parsed = new URL(value);
        return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
        return "";
    }
}

export default function SafeMarketplaceMarkdown({ children, className }) {
    return (
        <div className={className}>
            <ReactMarkdown
                skipHtml
                urlTransform={safeUrl}
                components={{
                    a: ({ href, children: linkChildren }) => href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer">{linkChildren}</a>
                    ) : <span>{linkChildren}</span>,
                    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
                }}
            >
                {String(children ?? "")}
            </ReactMarkdown>
        </div>
    );
}

export const MARKETPLACE_ACTION_LABELS = Object.freeze({
    plugin: "Install plugin",
    vehicle: "Import vehicle",
    "run-template": "Import run template",
    "run-package": "Retain run package",
    environment: "Import environment",
    "asset-pack": "Import asset pack",
    collection: "Install collection",
});
