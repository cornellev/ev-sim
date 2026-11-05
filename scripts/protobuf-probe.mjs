// Maintainer transport probe: uses the same Client API as the browser.
import assert from 'node:assert/strict';
import { Client } from '../app/client/Client.js';
const [url, runId, fingerprint] = process.argv.slice(2);
let opened;
const ready = new Promise((resolve) => { opened = resolve; });
const client = new Client({ url, reconnect: false, autoSubscribe: false, onOpen: opened });
const running = client.start();
try {
    await Promise.race([ready, running.then(() => { throw new Error('Connection closed'); })]);
    await client.bindProtobuf({ runId, fingerprint });
    let replied;
    const response = new Promise((resolve) => { replied = resolve; });
    await client.subscribeProtobuf('reply', replied);
    await client.publishProtobuf('note', { title: 'browser', nonce: '18446744073709551615' });
    const value = await Promise.race([response, new Promise((_, reject) => setTimeout(() => reject(new Error('Reply timeout')), 5000))]);
    assert.equal(value.accepted, true);
    await client.unsubscribeProtobuf('reply');
    console.log('JavaScript received the Rust Protobuf response');
} finally { await client.stop(); await running; }
