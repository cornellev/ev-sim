# Vehicle physics configuration work packages

This maintenance change follows the November 10, 2026 onboarding-log audit.
It extends the existing vehicle, physics, and plugin contracts; it is not a
headless PR 13 or a replacement for the completed PHY/RZ programs.

| Package | Implementation | Acceptance |
| --- | --- | --- |
| WP01 — Contract/resolver | Optional six-key plugin overrides; immutable shared configuration; declared-key validation | Positive after rounding, omitted-value stability, precedence, unsupported-key tests |
| WP02 — Runtime/identity | Shared WASM/plant/tire/chassis values; contact host 3; reset and browser/headless plumbing | Current contact characterization, historical integrity/admission, compiled-plugin parity |
| WP03 — Editor | Four RC-capable fields; effective defaults; command undo; confirmed incompatible switches | Focused-field keyboard save, undo, accessible controls, switch preservation/cancel tests |
| WP04 — Odometry review | Rear geometry helper; pre-publication session/draft-bound review; one-command sync | Valid/tolerant/incomplete pairs, cancel/skip/sync, stale consent, conflict retention, UI focus |
| WP05 — Frame diagnostics | `processedFrames` and local `publishedFrames`; legacy `deliveredFrames` retained | Mapping/schema/encoding/sink/route/partial failures, observation-only frames, strict failures, reset, external failures |
| WP06 — Verification/docs | Synthetic RC fixture; focused/full suites; lint; UI and characterization checks | Verification results recorded below; pinned tapes never mechanically regenerated |

## Decisions

- The minicar is a physical 30 cm RC car. Test constants are synthetic, not a
  substitute for weighing the real vehicle or measuring its tire response.
- Mass/inertia/stiffness are independent authored values, not inferred from
  mesh scale. Front/rear axle distances retain the selected plant's behavior.
- Rear track width and wheel radius are derived from wheel geometry. There
  are no duplicate vehicle-wide odometry constants.
- Publication means successful simulator topic/native product publication,
  not remote socket acknowledgment. Every declared frame product must succeed.
- Missing old-log diagnostics are unknown, never fabricated as zero.
- New counts are diagnostic and excluded from deterministic state identity.
- No automatic topic remapping, package rewriting, suspension, wheel spin,
  LiDAR repositioning, or hardware calibration is included.

## Verification

All six packages are implemented. Final verification on November 10, 2026:

- Focused physics, odometry-save, publication-count, and collider suites:
  15 passed, none failed or skipped. This includes stale consent after reopening
  the same vehicle and preserving unrelated plugin geometry parameters.
- Compiled Rust/WASM RC parity with `CEV_PLANT_CARGO=1`: 3 passed, none skipped.
  Synthetic RC cases cover shared chassis mass/inertia, browser/headless/built-in
  parity, steering, stopping, reversing, and reset.
- Focused characterization and identity checks: 22 passed. Committed
  kinematic, dynamic-bicycle, and contact tapes remain unchanged.
- `npm run test:parity`: all four cases passed across engine, direct headless,
  CLI, gRPC, and Python execution.
- Final `npm test -- --test-concurrency=4`: 2,646 passed, zero failed or
  cancelled, eight existing opt-in skips. The earlier collider mock failures
  were corrected; the final run has no Marketplace timeout.
- Final `npm run lint`: zero errors and three existing hook warnings.
  Temporary `.next-physics-check` build output was removed before this check.
- Playwright was not run at the user's explicit request. The new UI tests
  remain unexecuted, including browser focus and accessibility checks.
- Optional production build was not verified: sandboxed Turbopack stalled and
  was cancelled; the Webpack retry failed in the existing Spark asset loader
  (`asset/inline` rejects generator `filename`). No unrelated build changes
  were made.

Real RC calibration and topic mapping repairs remain outside this change.
Historical contact-host-2 runs must be re-resolved before execution.
