export function createTileSourceProjector() {
    return {
        id: "tile-source",
        apply(ctx) {
            const scalars = ctx.changeSet?.scalars ?? {};
            const tileChanged = ctx.changeSet?.domains?.objects?.after?.has?.("tile") === true;
            const host = ctx.data?.environment?.()?.tiles?.();
            if (tileChanged) host?.setVisible?.(ctx.document.getObject("tile")?.components?.editorHidden !== true);
            if (("earth" in scalars) || ("geoFrame" in scalars)) {
                host?.reconcile?.(ctx.document.earth, ctx.document.geoFrame).catch?.((error) => {
                    console.warn("[environment] tile source reconciliation failed:", error);
                });
            }
        },
    };
}
