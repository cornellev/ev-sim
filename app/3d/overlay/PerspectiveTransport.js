"use client";

import { useEffect, useRef, useState } from "react";
import {
    IconPlayerPause as FaPause,
    IconPlayerPlay as FaPlay,
    IconX as FaTimes,
} from "@tabler/icons-react";

import { useShortcut } from "../../ui";
import { MenuButton } from "./ui/MenuButton";
import { pauseSimulation, playSimulation } from "./runPlayback";

const IDLE_MS = 2500;

export function PerspectiveTransport({ data, snapshot }) {
    const sim = data?.simulation?.();
    const perspectiveView = sim?.perspectiveView;
    const [simState, setSimState] = useState(() => sim?.getSnapshot?.() ?? null);
    const [revealed, setRevealed] = useState(true);
    const revealedRef = useRef(true);
    const hoveringRef = useRef(false);
    const timerRef = useRef(0);
    const armHideRef = useRef(() => {});

    useEffect(() => {
        if (!sim?.subscribe) return undefined;
        return sim.subscribe(setSimState);
    }, [sim]);

    useEffect(() => {
        const publish = (next) => {
            revealedRef.current = next;
            setRevealed(next);
            document.documentElement.dataset.perspectiveView = next ? "active" : "idle";
        };
        const cancelHide = () => window.clearTimeout(timerRef.current);
        const armHide = () => {
            cancelHide();
            if (hoveringRef.current) return;
            timerRef.current = window.setTimeout(() => publish(false), IDLE_MS);
        };
        const onMove = () => {
            if (!revealedRef.current) publish(true);
            armHide();
        };
        armHideRef.current = armHide;
        document.documentElement.dataset.perspectiveView = "active";
        armHide();
        window.addEventListener("pointermove", onMove);
        return () => {
            window.removeEventListener("pointermove", onMove);
            cancelHide();
            delete document.documentElement.dataset.perspectiveView;
        };
    }, []);

    useShortcut({
        id: "perspective-exit",
        keys: "Escape",
        priority: 50,
        handler: () => {
            perspectiveView?.exit?.();
            return true;
        },
    });

    useShortcut({
        id: "perspective-play-pause",
        keys: "Space",
        priority: 50,
        handler: () => {
            if (simState?.status === "playing") pauseSimulation(data);
            else playSimulation(data);
            return true;
        },
    });

    const playing = simState?.status === "playing";

    return (
        <div
            className="sf-perspective-transport"
            data-revealed={revealed ? "true" : "false"}
            role="toolbar"
            aria-label="Perspective playback"
            aria-hidden={revealed ? undefined : true}
            onPointerEnter={() => {
                hoveringRef.current = true;
                window.clearTimeout(timerRef.current);
            }}
            onPointerLeave={() => {
                hoveringRef.current = false;
                armHideRef.current();
            }}
        >
            {!snapshot?.locked && (
                <p className="sf-perspective-transport-note">{snapshot?.label || "No vehicle camera"}</p>
            )}
            <div className="flex items-center gap-1 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/90 p-1 text-zinc-100 shadow-[0_20px_70px_rgba(0,0,0,0.5)]">
                <MenuButton
                    iconOnly
                    onClick={() => perspectiveView?.exit?.()}
                    title="Exit perspective"
                    ariaLabel="Exit perspective"
                >
                    <FaTimes className="h-3 w-3" />
                </MenuButton>
                <MenuButton
                    iconOnly
                    active={simState?.status === "paused"}
                    onClick={() => pauseSimulation(data)}
                    title="Pause simulation"
                    ariaLabel="Pause"
                >
                    <FaPause className="h-3 w-3" />
                </MenuButton>
                <MenuButton
                    iconOnly
                    variant="primary"
                    active={playing}
                    onClick={() => playSimulation(data)}
                    title="Run simulation"
                    ariaLabel="Play"
                >
                    <FaPlay className="h-3 w-3" />
                </MenuButton>
            </div>
        </div>
    );
}
