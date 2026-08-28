# Autonomy interface contracts

Step 1 locks the first-wave perception, localization, and control dataflow as versioned contracts shared by run manifests, schema resolution, client preflight, and the in-simulation topic router.

## Catalog

`app/autonomy/AutonomyContractCatalog.js` is the single source of truth for:

- Catalog kind/version/hash (`cev-sim.autonomy-contract-catalog` v3)
- Logical contract IDs and default wire names
- ROS schema definitions (`.msg` text)
- Producer namespaces (`simulator`, `candidate`, `reference`, `oracle`, `replay`, `bypass`)
- Authority modes (same set minus `simulator`)
- Timeout, validity, fallback, units, and implementation mode (`live`, `catalog-only`, `stub`)

Resolved runs embed `autonomyCatalog` metadata and a transitive `schemas` closure derived from manifest topics. The closure always includes dependencies such as `sensor_fusion_msgs/AckermannDrive` when the default legacy control return is declared.

The catalog hash covers all compatibility-relevant contract metadata (stage, implementation, frame/timestamp policies, timeout/validity, schema version, and fallback), not only id/type/direction.

## Run manifest v5 topics

Each topic record includes:

| Field | Purpose |
| --- | --- |
| `id` | Stable manifest id referenced by sensors, scenarios, and bindings |
| `contractId` | Catalog contract id |
| `name` | Orchestrator wire name |
| `direction` | `output` (simulator → team) or `input` (team → simulator) |
| `schema.type` / `schema.version` | Required ROS type |
| `required` | Preflight fails when a required input is missing on the orchestrator |
| `producer` | Namespace that may write the producer path |
| `authority` | Which producer wins on `active.*` |
| `timeoutNs` / `validityNs` | Stale detection at step boundaries |
| `fallback` | Structured fallback target (`contractId`, optional mode) |

v1–v4 topic rows migrate through `migrateLegacyTopic`. Normalization always emits manifest version 5. v5 adds default localization sensors and topics to new manifests without silently inserting them into migrated runs.

## Namespaces and routing

Only `TopicContractRouter` may write `active.*`. Producers write:

- `simulator` → `topics.<wireName>` (legacy shadow) plus router metadata
- `candidate.*`, `reference.*`, `oracle.*` → contract-scoped producer paths

The router validates direction/type, extracts stamped header capture time for inbound contracts, records arrival and apply timestamps, assigns deterministic sequence ids, applies authority/fallback, enforces `validityNs` separately from transport `timeoutNs`, and emits telemetry events (`topic-routed`, `topic-rejected`, `topic-stale`, `topic-invalid`, `topic-fallback-applied`).

Live platform outputs now include `/clock`, `/tf`, `/tf_static`, default perception sensors, and the localization suite (`/sensors/imu/data`, `/sensors/gnss/fix`, `/sensors/wheel/odometry`, `/oracle/vehicle/odometry`). The candidate return path `/localization/odometry` is a live **input** contract routed through `candidate.*` and `active.*`. Oracle truth is never mixed into measured sensor topics.

### Localization contracts (Step 3)

| Contract | Wire name | Type | Producer | Notes |
| --- | --- | --- | --- | --- |
| `imu` | `/sensors/imu/data` | `sensor_msgs/Imu` | `simulator` | Gravity-inclusive specific force and angular rate in the sensor frame; `orientation_covariance[0] = -1` |
| `gnss` | `/sensors/gnss/fix` | `sensor_msgs/NavSatFix` | `simulator` | WGS84 fix from manifest datum + ENU offset; dropout omits the sample, outage publishes `STATUS_NO_FIX` |
| `wheel-odometry` | `/sensors/wheel/odometry` | `nav_msgs/Odometry` | `simulator` | Encoder-quantized dead reckoning in `odom → base_link`, independent of oracle truth |
| `truth-odometry` | `/oracle/vehicle/odometry` | `nav_msgs/Odometry` | `oracle` | Exact vehicle state for scoring; published in the transform phase before measured sensors |
| `localization-estimate` | `/localization/odometry` | `nav_msgs/Odometry` | `candidate` | External EKF/filter return with stamped capture time for later ATE/RPE/NEES scoring |

Measured localization sensors derive per-axis noise, turn-on bias, correlated drift, saturation, GNSS multipath/outage, and wheel slip/quantization from manifest `calibration` fields. Random streams are deterministic: `seed:sensor:<id>:sample:<index>`.

## Preflight

Before `SimulationEngine.applyRunManifest`, `RunSessionController` calls `ClientManager.preflight(resolved)`:

1. Every schema in the resolved closure must be registered locally.
2. The resolved catalog hash must match the runtime catalog hash when present.
3. The orchestrator WebSocket must be connected.
4. Echo/read of the orchestrator catalog must succeed.
5. A known topic with the wrong type fails immediately.
6. Missing **required** input topics fail; absent optional inputs remain valid.

## External orchestrator requirements

Mirror custom definitions from `public/messages/` into the orchestrator `custom_types/` directory (or sync through the types API). The simulator pushes the full autonomy catalog on startup via `syncTypesToServer`.

Legacy `/ackdrive` remains available through the `ackdrive-legacy` contract (mph/deg adapter in `SimulationEngine`). The authoritative SI controls contract is `controls-command` (`sensor_fusion_msgs/StampedAckermannDrive`).

## Related docs

- [Run manifests](./run-manifests.md) — manifest lifecycle and bundles
- [ROS integration](./ros-integration.md) — orchestrator setup and transport
