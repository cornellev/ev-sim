// Independent maintainer probe through the pinned official remote-API SDK.
import assert from "node:assert/strict";
import { Config, Session, Encoding } from "@eclipse-zenoh/zenoh-ts";
import { loadDescriptorSet, encodeMessage, decodeMessage } from "../app/interfaces/ProtobufSchema.js";
import { promises as fs } from "node:fs";
const [endpoint, key, descriptorFile, requestTypeName, replyTypeName] = process.argv.slice(2);
if (![endpoint, key, descriptorFile, requestTypeName, replyTypeName].every(Boolean)) throw new Error("Provide WS endpoint, key prefix, descriptor file, request and reply message types.");
const schema = loadDescriptorSet(await fs.readFile(descriptorFile));
const requestType = schema.root.lookupType(requestTypeName), replyType = schema.root.lookupType(replyTypeName);
const session = await Session.open(new Config(endpoint, 5000));
let subscriber, publisher, timer;
try {
    let accept, rejectReply;
    const reply = new Promise((resolve, reject) => { accept = resolve; rejectReply = reject; });
    subscriber = await session.declareSubscriber(`${key}/reply`, { handler: (sample) => { try { accept(decodeMessage(replyType, sample.payload().toBytes())); } catch (error) { rejectReply(error); } } });
    timer = setTimeout(() => rejectReply(new Error("Reply timeout")), 5000);
    publisher = await session.declarePublisher(`${key}/note`, { encoding: Encoding.APPLICATION_PROTOBUF });
    await publisher.put(encodeMessage(requestType, { title: "browser", nonce: "18446744073709551615" }));
    const value = await reply;
    assert.equal(value.accepted, true);
    console.log("Official JavaScript SDK received the independent Rust Protobuf response");
} finally { clearTimeout(timer); await publisher?.undeclare(); await subscriber?.undeclare(); await session.close(); }
