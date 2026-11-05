# Generic Protobuf publication

The existing browser Client now supports schema-bound publication/subscription:

```js
await client.bindProtobuf({ runId, fingerprint });
await client.subscribeProtobuf('reply', (value) => console.log(value));
await client.publishProtobuf('note', { title: 'hello', nonce: '18446744073709551615' });
await client.unsubscribeProtobuf('reply');
```

Register the descriptor set and explicit routes with orchestrator first. Values
use standard ProtoJSON. The browser sends versioned text frames on its existing
WebSocket; orchestrator validates them, encodes binary Protobuf, and publishes to
the route's Zenoh key. Reverse subscriptions deliver ProtoJSON values. Existing
binary `.msg` methods remain compatible. New text samples go only to subscribers.
A routing acknowledgement confirms acceptance, not physical command application.

Bindings require an exact descriptor fingerprint and run ID. Connection loss clears
the binding and subscriptions. A fresh run requires a new bind; there is no automatic
resume. Failed operations reject promises. Source timestamps/sequence identity belong
to message contracts; a route does not infer frames, units, or actuator safety.

Use decimal strings or BigInt for 64-bit integer fields. BigInt is converted to a
decimal string before sending. Non-finite JavaScript numbers are rejected. The
channel bounds outstanding requests and subscriptions; existing socket backpressure
limits still apply.

`--onboarding` on the combined installer includes orchestrator's Protobuf extra and
the checksum-pinned Zenoh 1.10.2 router. `--orchestrator-ref` selects its exact Git
revision. Modified existing orchestrator checkouts are preserved by refusing a
revision switch. Native Windows setup remains documented rather than automated.

For isolated services, set `NEXT_PUBLIC_ORCHESTRATOR_API` and
`NEXT_PUBLIC_ORCHESTRATOR_WS` before starting/building the browser application.
Defaults remain localhost ports 8090 and 8080. The generic client example is
`scripts/protobuf-probe.mjs`; orchestrator's integration runner pairs it with the
onboarding Rust probe through a real router. Visual field wiring is deferred.
