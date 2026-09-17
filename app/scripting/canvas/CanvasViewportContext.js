import { createContext } from "react";
import { DEFAULT_CANVAS_VIEWPORT } from "./CanvasViewport.js";

export const CanvasViewportContext = createContext({
    viewport: DEFAULT_CANVAS_VIEWPORT,
    viewportRef: { current: DEFAULT_CANVAS_VIEWPORT },
    isPanModeRef: { current: false },
    canvasRef: { current: null },
    setViewport: () => {},
});
