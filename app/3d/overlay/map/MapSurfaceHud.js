export function MapSurfaceHud({ viewport, layers, showDetail }) {
    return (
        <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2 text-[11px] text-zinc-300 backdrop-blur-xl">
            <p className="font-semibold uppercase tracking-[0.12em] text-zinc-400">Map Mode</p>
            <p className="mt-1 font-mono text-zinc-200">
                {viewport.centerX.toFixed(1)}, {viewport.centerZ.toFixed(1)}
            </p>
            <p className="mt-0.5 text-zinc-500">
                Zoom {viewport.zoom.toFixed(2)}x
                {!showDetail ? " · Overview" : ""}
                {viewport.snapEnabled ? ` · Snap ${viewport.snapSize}m` : " · Snap off"}
            </p>
            {layers.roads && showDetail && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800/80 pt-2 text-[10px] text-zinc-500">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-2.5 w-2.5 rotate-45 rounded-[1px] border border-amber-500 bg-amber-500/30" />
                        Intersection
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-3 rounded-full bg-amber-300" />
                        Road link
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full bg-zinc-500" />
                        Road endpoint
                    </span>
                    <span className="text-zinc-600">Select items to inspect · drag props and road ends</span>
                </div>
            )}
        </div>
    );
}
