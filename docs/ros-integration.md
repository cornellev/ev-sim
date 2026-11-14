# Historical ROS integration

ZPB-09 removed the orchestrator client, ROS codecs and builders, fallback `.msg`
assets, ROS scripting units, and installer flags. Current runs use native topic
contracts and direct [Zenoh / Protobuf integration](protobuf-routing.md).

Historical bundles retain their original bytes, metadata, and identity checks in
`server/interfaces/historical/` and `server/headless/RunBundleInspection.js`.
Reviewed native adoption publishes new resources without rewriting originals.
Historical ROS SFLogs remain readable for metadata and scalar analysis; ROS sensor
payload previews and camera export decoding are unavailable.
