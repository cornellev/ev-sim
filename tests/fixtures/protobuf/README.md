# Protobuf interface fixtures

- `onboarding/autonomy.proto` and `autonomy.binpb`: `cornellev/auto-onboarding-fa26`,
  commit `08c658f3dfcf7f8483f6715fa5b6b65ee687b37e`, copied from the local onboarding
  checkout. Descriptor SHA-256: `d3002f3091ed00f14441f5158f78f6935df72f802024e0341a56f57e9f39c87c`.
- `cev-interfaces/proto/cev_interfaces.proto` and `cev/interfaces/v1/common.proto`:
  `cornellev/cev-interfaces`, commit `4e720ae831d3a5dc5c49946f82049041ce157977`.
  These are the stable source files; the repository's `untested` draft is not admitted implicitly.
- `features/`: local codec and modular-import fixtures, including a bundled well-known type.
- `run-{disabled,publish,controls}.v12.json` and `run-snapshots.v12.json`:
  synthetic ZPB-03 snapshots from `tests/helpers/protobufRunFixture.js`, with
  export time fixed at `2026-11-12T00:00:00.000Z`. The vectors pin exact bundle
  bytes, definition/resolved/simulation/episode identities, and schema/interface
  hashes. Bootstrap coefficients exercise integer map-key ordering and precise
  numeric JSON. These are separate from the historical v10/v11 goldens and
  characterization tapes. Review future deltas as contract changes.

The upstream fixtures are pinned evidence. Tests do not download or update them.
