import { useEffect, useState } from "react";

export function useMapSize(ref) {
    const [size, setSize] = useState({ width: 800, height: 600 });

    useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            setSize({
                width: entry.contentRect.width,
                height: entry.contentRect.height,
            });
        });

        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);

    return size;
}
