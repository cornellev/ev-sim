# cev-sim interface system

cev-sim uses one dark, instrument-grade interface system. The live scene and recorded data provide the visual interest. Application chrome stays neutral, compact, and predictable.

## Principles

- Use matte surfaces for permanent chrome. Translucency is reserved for dialogs, popovers, drawers, and floating scene controls.
- Use stepped surface lightness and hairline rules for hierarchy. Do not add gradients, glows, decorative shadows, or nested cards.
- Use sentence case. Geist Sans is the interface face; Geist Mono is for values, time, coordinates, and identifiers.
- Use neutral contrast for selection and completion feedback. Color is reserved for errors, warnings, operational enabled/disabled states, graph series, typed scripting ports, map layers, and 3D axes or gizmos.
- Use one primary near-white action per view.

## Tokens

The source of truth is `app/globals.css`.

| Role | Token | Value |
| --- | --- | --- |
| Ground | `--slate-bg` | `#17181a` |
| Surface 1 | `--slate-surface-1` | `#1c1e20` |
| Surface 2 | `--slate-surface-2` | `#1f2123` |
| Surface 3 | `--slate-surface-3` | `#212325` |
| Primary text | `--slate-fg` | `#f4f4f4` |
| Secondary text | `--slate-fg-2` | `#c2c4c6` |
| Muted text | `--slate-muted` | `#8a8a8a` |
| Operational enabled | `--slate-success` | `#78b98d` |
| Error | `--slate-danger` | `#d98a8a` |
| Radius | `--radius` | `4px` |

Spacing follows a 4px scale. Standard controls are 32px or 36px tall and expand to at least 44px for coarse pointers.

## Typography

| Role | Size | Notes |
| --- | --- | --- |
| Caption | 11px | Supporting copy only |
| Data | 12-13px | Geist Mono, tabular numbers |
| Label | 13px | Medium weight, sentence case |
| Body/control | 13-14px | Default interface copy |
| Section title | 18-20px | Tight tracking |
| Page title | 24px | Used sparingly |

Do not use interface text below 11px. Do not use uppercase as a substitute for hierarchy.

## Components

Shared primitives live in `app/ui`. Use them before creating local controls:

- `Button` and `IconButton`
- `Field`, `TextInput`, `Textarea`, `Select`, and `Switch`
- `Tabs` and `SegmentedControl`
- `DialogSurface`, `PopoverSurface`, `Tooltip`, and `ScrollPane`
- `WorkspaceFrame`, `Panel`, `StatusMessage`, and `AsyncState`

Icon-only controls require an accessible label and tooltip. Use `@tabler/icons-react` at 1.75 stroke. Do not mix icon families or use text glyphs as control icons.

## Motion

- Press, hover, and color feedback: 140ms.
- Popovers: 180ms from the trigger origin.
- Drawers: 220ms.
- Animate transform and opacity, not layout dimensions.
- Repeated keyboard actions are instant.
- Focus indicators appear without animation.
- Reduced motion removes spatial transitions; reduced transparency makes floating materials opaque.

## Layout and accessibility

Full authoring is supported at widths of 768px and above. Workspaces collapse rails into drawers or list-detail layouts at their documented compact breakpoints. Below 768px, the app shows the desktop-workspace message while retaining runtime state behind it.

Every interactive component must cover default, hover, focus-visible, active, disabled, loading, error, and success states where applicable. Keyboard shortcuts must not fire from editable controls. Dialogs trap and restore focus, and hidden panels must not leave focusable descendants in the tab order.
