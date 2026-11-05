import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtobufChannel } from '../app/client/ProtobufChannel.js';

test('ProtoJSON acknowledgements, exact integers, subscriptions and run isolation', async () => {
    const sent = [];
    const channel = new ProtobufChannel(async (text) => {
        const message = JSON.parse(text);
        sent.push(message);
        await channel.receive(JSON.stringify({ protocol: 'orch.protobuf.v1', op: 'ack', request_id: message.request_id }));
    });
    await channel.bind({ runId: 'run-a', fingerprint: 'hash' });
    await channel.publish('note', { timeNs: 18446744073709551615n });
    assert.equal(sent.at(-1).value.timeNs, '18446744073709551615');
    const values = [];
    await channel.subscribe('reply', (v) => values.push(v));
    const sample = { protocol: 'orch.protobuf.v1', op: 'sample', run_id: 'run-a', fingerprint: 'hash', route: 'reply', value: { ok: true } };
    await channel.receive(JSON.stringify({ ...sample, run_id: 'old' }));
    await channel.receive(JSON.stringify(sample));
    assert.deepEqual(values, [{ ok: true }]);
    await channel.unsubscribe('reply');
    await channel.receive(JSON.stringify(sample));
    assert.equal(values.length, 1);
    await assert.rejects(channel.publish('note', { value: NaN }), /Non-finite/);
    channel.close();
    await assert.rejects(channel.publish('note', {}), /bindProtobuf/);
});

test('server errors reject operations and closing clears run binding', async () => {
    let channel;
    channel = new ProtobufChannel(async (text) => {
        const message = JSON.parse(text);
        await channel.receive(JSON.stringify({ protocol: 'orch.protobuf.v1', op: message.op === 'hello' ? 'ack' : 'error', error: 'route forbidden', request_id: message.request_id }));
    });
    await channel.bind({ runId: 'new', fingerprint: 'schema' });
    await assert.rejects(channel.publish('command', {}), /forbidden/);
    await assert.rejects(channel.subscribe('private', () => {}), /forbidden/);
    assert.equal(channel.callbacks.size, 0);
    channel.close();
    assert.equal(channel.pending.size, 0);
    assert.equal(channel.binding, null);
});
