import { DEFAULT_CANVAS_VIEWPORT } from "./canvas/CanvasViewport.js";

export default function Grid({ viewport = DEFAULT_CANVAS_VIEWPORT } = {}) {
    const { x, y, scale } = viewport;
    const patternTransform = `translate(${x} ${y}) scale(${scale})`;

    return (
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" className="absolute top-0 left-0" style={{
            userSelect: "none",
            pointerEvents: "none"
        }}>
            <defs>
                <pattern id="scriptSmallGrid" width="10" height="10" patternUnits="userSpaceOnUse">
                    <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,0.025)" strokeWidth="0.5"/>
                </pattern>
                <pattern id="scriptGrid" width="100" height="100" patternUnits="userSpaceOnUse" patternTransform={patternTransform}>
                    <rect width="100" height="100" fill="url(#scriptSmallGrid)"/>
                    <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1"/>
                </pattern>
            </defs>

            <rect width="100%" height="100%" fill="url(#scriptGrid)" />
        </svg>
    )
}
