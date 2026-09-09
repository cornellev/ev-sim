/**
 * VIS-11 opt-in intrinsic-material-model@1 adapter. Construction of this
 * object never probes the network; capability checks run only when selected.
 */

import {
    BAKE_CONTRACT_VERSION,
    BAKE_PROVIDER_RESPONSE_KIND,
    hashBakeProviderRequest,
    normalizeBakeProviderRequest,
    normalizeBakeProviderResponse,
} from "./BakeRunCatalog.js";
import {
    assertIntrinsicModelSelection,
    buildBakeModelOutputSet,
    commonSourceDimensions,
    createFakeCapability,
    digestModelBuffer,
    digestRecordForChannel,
    channelFromModelBufferKey,
    FAKE_INTRINSIC_RUNTIME_STACK,
    INTRINSIC_MATERIAL_MODEL_PROVIDER,
    INTRINSIC_MATERIAL_MODEL_REVISION,
    INTRINSIC_MODEL_OUTPUT_CODEC,
    lookupCaptureBuffer,
    MODEL_OUTPUT_CHANNELS,
    modelOutputBufferKey,
    modelRightsForCachePolicy,
    normalizeBakeModelOutputSet,
    normalizeIntrinsicMaterialOptions,
    runFakeIntrinsicInference,
    float32LittleEndianBytes,
} from "./BakeModelOutput.js";
import {
    BAKE_V1_API_BASE,
    cancelBakeV1Job,
    createBakeV1Job,
    fetchBakeV1Buffer,
    fetchBakeV1Capability,
    fetchBakeV1Result,
    pollBakeV1Job,
    submitBakeV1Job,
    uploadBakeV1Input,
} from "../visualization/BakeRoundTrip.js";
import { sha256ExactBytes } from "../../../simulation/visual/VisualLayer.js";

function adapterError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : adapterError("BAKE_MODEL_CANCELLED", "Bake model job cancelled.");
}

function asUint8(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "Expected a binary transfer buffer.");
}

function inputKey(entry) {
    return `${entry.sampleId}:${entry.viewId}:${entry.role}`;
}

function bytesToChannelBuffer(channel, bytes) {
    const copy = asUint8(bytes);
    if (channel === "known-mask") return new Uint8Array(copy);
    if (copy.byteLength % 4 !== 0) {
        throw adapterError("BAKE_MODEL_OUTPUT_INVALID", `${channel} is not a float32 buffer.`);
    }
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    const values = new Float32Array(copy.byteLength / 4);
    for (let index = 0; index < values.length; index += 1) {
        values[index] = view.getFloat32(index * 4, true);
    }
    return values;
}

function capturedBytes(role, data) {
    if (role === "beauty" || role === "validity") return asUint8(data);
    if (data instanceof Float32Array || data instanceof Uint32Array || data instanceof Uint8Array) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return asUint8(data);
}

function groupInputs(request) {
    const groups = new Map();
    for (const entry of request.inputs) {
        const key = `${entry.sampleId}:${entry.viewId}`;
        if (!groups.has(key)) groups.set(key, { sampleId: entry.sampleId, viewId: entry.viewId, roles: new Map() });
        groups.get(key).roles.set(entry.role, entry);
    }
    return [...groups.values()];
}

function buildAckResponse({ request, requestHash, options, sourceDimensions, effectiveDimensions, runtimeStack, cachePolicy }) {
    return normalizeBakeProviderResponse({
        kind: BAKE_PROVIDER_RESPONSE_KIND,
        version: BAKE_CONTRACT_VERSION,
        requestHash,
        outputs: request.inputs.map((entry) => ({ ...entry })),
        providerRevision: INTRINSIC_MATERIAL_MODEL_REVISION,
        modelRevision: options.model.revision,
        weightsDigest: options.weightsDigest,
        prompts: options.prompts,
        configuration: {
            algorithmId: options.algorithm.id,
            algorithmRevision: options.algorithm.revision,
            resizePolicy: options.resizePolicy,
            inference: options.inference,
            modelOutputCodec: INTRINSIC_MODEL_OUTPUT_CODEC,
        },
        runtimeOptions: {
            transform: "intrinsic-material-model",
        },
        seed: request.seed,
        sourceDimensions,
        effectiveDimensions,
        codecRevisions: { capture: "aligned-products@1" },
        runtimeStack,
        nondeterminismScope: options.nondeterminismScope,
        cachePolicy,
    });
}

function inferFromCaptured({ request, buffers, options, sourceDimensions }) {
    const modelBuffers = new Map();
    const samples = groupInputs(request).map((group) => {
        const beauty = lookupCaptureBuffer(buffers, group.sampleId, group.viewId, "beauty");
        const validity = lookupCaptureBuffer(buffers, group.sampleId, group.viewId, "validity");
        if (!(beauty instanceof Uint8Array) || !(validity instanceof Uint8Array)) {
            throw adapterError("BAKE_MODEL_INCOMPLETE", `Captured beauty and validity are required for ${group.sampleId}.`);
        }
        const inferred = runFakeIntrinsicInference({
            beauty,
            validity,
            sourceDimensions,
            resizePolicy: options.resizePolicy,
            seed: request.seed,
        });
        const outputs = MODEL_OUTPUT_CHANNELS.map((channel) => {
            const data = inferred.channels[channel];
            const record = digestRecordForChannel(
                group.sampleId,
                group.viewId,
                channel,
                data,
                sourceDimensions.width,
                sourceDimensions.height,
            );
            modelBuffers.set(modelOutputBufferKey(group.sampleId, group.viewId, channel), data);
            return record;
        });
        return {
            sampleId: group.sampleId,
            viewId: group.viewId,
            width: sourceDimensions.width,
            height: sourceDimensions.height,
            sourceDimensions,
            effectiveDimensions: inferred.effectiveDimensions,
            outputs,
        };
    });
    return {
        modelOutputSet: buildBakeModelOutputSet({
            requestHash: hashBakeProviderRequest(request),
            samples,
        }),
        modelBuffers,
        effectiveDimensions: samples[0]?.effectiveDimensions ?? sourceDimensions,
    };
}

export function createMemoryBakeModelTransport({
    capability = createFakeCapability(),
    cache = new Map(),
    failCapability = false,
    failUpload = false,
    failSubmit = false,
    incompleteChannels = null,
    corruptCache = false,
    delayMs = 0,
    maxUploadBytes = capability.maxUploadBytes,
} = {}) {
    const jobs = new Map();

    function jobOrThrow(jobId) {
        const job = jobs.get(jobId);
        if (!job) throw adapterError("BAKE_PROVIDER_UNAVAILABLE", `Unknown bake model job ${jobId}.`);
        return job;
    }

    async function maybeDelay(signal) {
        if (!(delayMs > 0)) return;
        const started = Date.now();
        while (Date.now() - started < delayMs) {
            throwIfAborted(signal);
            await new Promise((resolve) => setTimeout(resolve, Math.min(20, delayMs)));
        }
    }

    return {
        local: true,
        capabilityDocument: capability,
        async capability({ signal } = {}) {
            throwIfAborted(signal);
            if (failCapability) {
                throw adapterError("BAKE_PROVIDER_CAPABILITY_MISMATCH", "Configured bake model service is unavailable.");
            }
            return capability;
        },
        async createJob({ request, signal } = {}) {
            throwIfAborted(signal);
            const requestHash = hashBakeProviderRequest(request);
            const existing = [...jobs.values()].find((entry) => entry.requestHash === requestHash && entry.state !== "cancelled");
            if (existing) return { jobId: existing.jobId, requestHash, state: existing.state };
            const jobId = `mem-${requestHash.slice(0, 16)}`;
            const cached = cache.get(requestHash);
            const job = {
                jobId,
                request,
                requestHash,
                inputs: new Map(),
                state: cached ? "completed" : "open",
                modelOutputSet: cached && !corruptCache ? cached.modelOutputSet : null,
                modelBuffers: cached && !corruptCache ? cached.modelBuffers : null,
                response: cached && !corruptCache ? cached.response : null,
                cancelled: false,
            };
            jobs.set(jobId, job);
            return { jobId, requestHash, state: job.state };
        },
        async uploadInput({ jobId, sampleId, viewId, role, bytes, sha256, signal } = {}) {
            throwIfAborted(signal);
            if (failUpload) throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "Upload rejected.");
            const job = jobOrThrow(jobId);
            if (job.state === "cancelled") throw adapterError("BAKE_MODEL_CANCELLED", "Bake model job cancelled.");
            const payload = asUint8(bytes);
            if (payload.byteLength > maxUploadBytes) {
                throw adapterError("BAKE_PROVIDER_CAPABILITY_MISMATCH", "Upload exceeds the configured byte limit.");
            }
            const digest = sha256ExactBytes(payload);
            if (digest !== sha256) throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "Upload digest mismatch.");
            job.inputs.set(`${sampleId}:${viewId}:${role}`, { bytes: payload, sha256: digest, byteSize: payload.byteLength });
            return { accepted: true, sha256: digest, byteSize: payload.byteLength };
        },
        async submit({ jobId, requestHash, signal } = {}) {
            throwIfAborted(signal);
            if (failSubmit) throw adapterError("BAKE_MODEL_INCOMPLETE", "Submit rejected.");
            const job = jobOrThrow(jobId);
            if (job.cancelled) throw adapterError("BAKE_MODEL_CANCELLED", "Bake model job cancelled.");
            if (job.requestHash !== requestHash) {
                throw adapterError("BAKE_RESPONSE_MISMATCH", "Submit requestHash does not match the job.");
            }
            await maybeDelay(signal);
            throwIfAborted(signal);
            if (job.state === "completed" && job.modelOutputSet) return { state: "completed", requestHash };
            if (cache.has(requestHash) && !corruptCache) {
                const cached = cache.get(requestHash);
                job.state = "completed";
                job.modelOutputSet = cached.modelOutputSet;
                job.modelBuffers = cached.modelBuffers;
                job.response = cached.response;
                return { state: "completed", requestHash, cacheHit: true };
            }
            const options = job.request.providerOptions;
            const sourceDimensions = {
                width: job.request.inputs[0].width,
                height: job.request.inputs[0].height,
            };
            const captured = new Map();
            for (const input of job.request.inputs) {
                const stored = job.inputs.get(inputKey(input));
                if (!stored) throw adapterError("BAKE_MODEL_INCOMPLETE", `Missing uploaded input ${inputKey(input)}.`);
                if (stored.sha256 !== input.sha256 || stored.byteSize !== input.byteSize) {
                    throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", `Uploaded ${input.role} digest mismatch.`);
                }
                captured.set(inputKey(input), input.role === "beauty" || input.role === "validity"
                    ? stored.bytes
                    : stored.bytes);
            }
            const inferred = inferFromCaptured({
                request: job.request,
                buffers: captured,
                options,
                sourceDimensions,
            });
            if (incompleteChannels) {
                throw adapterError("BAKE_MODEL_INCOMPLETE", "Backend omitted a required intrinsic channel.");
            }
            const response = buildAckResponse({
                request: job.request,
                requestHash,
                options,
                sourceDimensions,
                effectiveDimensions: inferred.effectiveDimensions,
                runtimeStack: capability.runtimeStack ?? FAKE_INTRINSIC_RUNTIME_STACK,
                cachePolicy: job.request.cachePolicy,
            });
            job.modelOutputSet = inferred.modelOutputSet;
            job.modelBuffers = inferred.modelBuffers;
            job.response = response;
            job.state = "completed";
            if (job.request.cachePolicy?.mode === "reuse-request") {
                if (corruptCache) {
                    throw adapterError("BAKE_CACHE_CORRUPT", "Cached model output publication failed.");
                }
                cache.set(requestHash, {
                    modelOutputSet: inferred.modelOutputSet,
                    modelBuffers: inferred.modelBuffers,
                    response,
                });
            }
            return { state: "completed", requestHash };
        },
        async status({ jobId, signal } = {}) {
            throwIfAborted(signal);
            const job = jobOrThrow(jobId);
            return {
                state: job.state,
                requestHash: job.requestHash,
                code: job.state === "failed" ? job.code : undefined,
                error: job.error,
            };
        },
        async result({ jobId, signal } = {}) {
            throwIfAborted(signal);
            const job = jobOrThrow(jobId);
            if (job.state !== "completed") throw adapterError("BAKE_MODEL_INCOMPLETE", "Model result is not ready.");
            if (corruptCache && job.request.cachePolicy?.mode === "reuse-request") {
                throw adapterError("BAKE_CACHE_CORRUPT", "Cached model output failed rehash.");
            }
            return {
                response: job.response,
                modelOutputSet: job.modelOutputSet,
            };
        },
        async downloadBuffer({ jobId, sha256, expectedLength, signal } = {}) {
            throwIfAborted(signal);
            const job = jobOrThrow(jobId);
            for (const [key, data] of job.modelBuffers ?? []) {
                const channel = channelFromModelBufferKey(key);
                const digest = digestModelBuffer(channel, data);
                if (digest === sha256) {
                    const packed = channel === "known-mask" ? asUint8(data) : float32LittleEndianBytes(data);
                    if (expectedLength != null && packed.byteLength !== expectedLength) {
                        throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "Result buffer length mismatch.");
                    }
                    if (sha256ExactBytes(packed) !== sha256) {
                        throw adapterError("BAKE_CACHE_CORRUPT", "Result buffer failed rehash.");
                    }
                    return { bytes: packed, digest: sha256 };
                }
            }
            throw adapterError("BAKE_MODEL_INCOMPLETE", `Unknown result buffer ${sha256}.`);
        },
        async cancel({ jobId } = {}) {
            const job = jobOrThrow(jobId);
            job.cancelled = true;
            job.state = "cancelled";
            return { state: "cancelled" };
        },
    };
}

export function createHttpBakeModelTransport({
    host,
    apiBase = BAKE_V1_API_BASE,
    timeoutMs = 300000,
    pollIntervalMs = 1000,
    fetchImpl = globalThis.fetch,
} = {}) {
    const server = { host };
    return {
        local: false,
        async capability({ signal } = {}) {
            return fetchBakeV1Capability(server, { apiBase, signal, fetchImpl });
        },
        async createJob({ request, signal } = {}) {
            return createBakeV1Job(server, { request, apiBase, signal, fetchImpl });
        },
        async uploadInput({ jobId, sampleId, viewId, role, bytes, sha256, signal } = {}) {
            return uploadBakeV1Input(server, {
                jobId, sampleId, viewId, role, bytes, sha256, apiBase, signal, fetchImpl,
            });
        },
        async submit({ jobId, requestHash, signal } = {}) {
            return submitBakeV1Job(server, { jobId, requestHash, apiBase, signal, fetchImpl });
        },
        async status({ jobId, signal } = {}) {
            return pollBakeV1Job(server, {
                jobId, timeoutMs, pollIntervalMs, apiBase, signal, fetchImpl,
            });
        },
        async result({ jobId, signal } = {}) {
            return fetchBakeV1Result(server, { jobId, apiBase, signal, fetchImpl });
        },
        async downloadBuffer({ jobId, sha256, expectedLength, signal } = {}) {
            return fetchBakeV1Buffer(server, {
                jobId, sha256, expectedLength, apiBase, signal, fetchImpl,
            });
        },
        async cancel({ jobId, signal } = {}) {
            return cancelBakeV1Job(server, { jobId, apiBase, signal, fetchImpl });
        },
    };
}

async function authorizeModelUses({ sourceUseHashes, authorizeSourceUse, cachePolicy }) {
    const operations = modelRightsForCachePolicy(cachePolicy);
    if (!sourceUseHashes?.length) return operations;
    if (typeof authorizeSourceUse !== "function") {
        throw adapterError(
            "BAKE_RIGHTS_DENIED",
            "External model upload requires a trusted rights validator.",
        );
    }
    for (const useHash of sourceUseHashes) {
        const allowed = await authorizeSourceUse({ useHash, operations: [...operations] });
        if (allowed === false) {
            throw adapterError("BAKE_RIGHTS_DENIED", `Model upload denied rights for use ${useHash}.`);
        }
    }
    return operations;
}

async function downloadModelBuffers(transport, jobId, modelOutputSet, signal) {
    const buffers = new Map();
    for (const sample of modelOutputSet.samples) {
        for (const output of sample.outputs) {
            throwIfAborted(signal);
            const downloaded = await transport.downloadBuffer({
                jobId,
                sha256: output.sha256,
                expectedLength: output.byteSize,
                signal,
            });
            const packed = asUint8(downloaded.bytes);
            if (packed.byteLength !== output.byteSize || sha256ExactBytes(packed) !== output.sha256) {
                throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", `Downloaded ${output.channel} failed digest verification.`);
            }
            buffers.set(
                modelOutputBufferKey(sample.sampleId, sample.viewId, output.channel),
                bytesToChannelBuffer(output.channel, packed),
            );
        }
    }
    return buffers;
}

export function createIntrinsicMaterialModelProvider({ transport = null } = {}) {
    const state = { transport };

    function resolveTransport(operational) {
        if (state.transport) return state.transport;
        const host = operational?.host;
        if (!host) {
            throw adapterError(
                "BAKE_PROVIDER_UNAVAILABLE",
                "intrinsic-material-model@1 requires an injected transport or operational host.",
            );
        }
        state.transport = createHttpBakeModelTransport({
            host,
            apiBase: operational.roundTrip?.apiBase ?? BAKE_V1_API_BASE,
            timeoutMs: operational.roundTrip?.timeoutMs ?? 300000,
            pollIntervalMs: operational.roundTrip?.pollIntervalMs ?? 1000,
        });
        return state.transport;
    }

    return {
        id: INTRINSIC_MATERIAL_MODEL_PROVIDER.id,
        version: INTRINSIC_MATERIAL_MODEL_PROVIDER.version,
        local: false,
        requiresModel: true,
        available: true,
        supportsBoundedStreaming: true,
        defaultOptions: {},
        normalizeOptions: normalizeIntrinsicMaterialOptions,
        validateSelection(context = {}) {
            return assertIntrinsicModelSelection(context);
        },
        async probe({ config, operational = config?.operational, signal } = {}) {
            throwIfAborted(signal);
            const selection = assertIntrinsicModelSelection({ config });
            const resolved = resolveTransport(operational);
            const capability = await resolved.capability({ signal });
            assertIntrinsicModelSelection({ config, capability });
            return { ...selection, capability };
        },
        async authorizeUses({ sourceUseHashes, authorizeSourceUse, cachePolicy }) {
            return authorizeModelUses({ sourceUseHashes, authorizeSourceUse, cachePolicy });
        },
        async execute(request, context = {}) {
            const signal = context.signal;
            throwIfAborted(signal);
            const normalized = normalizeBakeProviderRequest(request);
            const requestHash = context.requestHash ?? hashBakeProviderRequest(normalized);
            const options = normalizeIntrinsicMaterialOptions(normalized.providerOptions);
            const sourceDimensions = commonSourceDimensions(normalized.inputs);
            const operational = context.operational ?? {};
            const config = context.config ?? {
                provider: normalized.provider,
                providerOptions: options,
                construction: context.construction,
                views: [{ camera: sourceDimensions }],
                operational,
                cachePolicy: normalized.cachePolicy,
            };
            const transport = resolveTransport(operational);
            let remoteJobId = null;
            const cancelRemote = async () => {
                if (!remoteJobId || typeof transport.cancel !== "function") return;
                try {
                    await transport.cancel({ jobId: remoteJobId, signal: undefined });
                } catch {
                    // Cooperative cancellation already happened or the job never started.
                }
            };
            try {
                if (context.capability == null) {
                    const capability = await transport.capability({ signal });
                    assertIntrinsicModelSelection({ config, capability });
                }
                await authorizeModelUses({
                    sourceUseHashes: context.sourceUseHashes ?? [],
                    authorizeSourceUse: context.authorizeSourceUse,
                    cachePolicy: normalized.cachePolicy,
                });
                const created = await transport.createJob({ request: normalized, signal });
                remoteJobId = created.jobId;
                throwIfAborted(signal);
                if (created.state !== "completed") {
                    const maxUploadBytes = operational.roundTrip?.maxUploadBytes ?? 32 * 1024 * 1024;
                    for (const input of normalized.inputs) {
                        throwIfAborted(signal);
                        const captured = lookupCaptureBuffer(context.buffers, input.sampleId, input.viewId, input.role);
                        if (!captured) {
                            throw adapterError("BAKE_MODEL_INCOMPLETE", `Missing captured buffer ${inputKey(input)}.`);
                        }
                        const bytes = capturedBytes(input.role, captured);
                        if (bytes.byteLength !== input.byteSize || sha256ExactBytes(bytes) !== input.sha256) {
                            throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", `Captured ${input.role} digest mismatch before upload.`);
                        }
                        if (bytes.byteLength > maxUploadBytes) {
                            throw adapterError("BAKE_PROVIDER_CAPABILITY_MISMATCH", "Capture exceeds the configured upload limit.");
                        }
                        await transport.uploadInput({
                            jobId: remoteJobId,
                            sampleId: input.sampleId,
                            viewId: input.viewId,
                            role: input.role,
                            bytes,
                            sha256: input.sha256,
                            signal,
                        });
                    }
                    await transport.submit({ jobId: remoteJobId, requestHash, signal });
                }
                const status = await transport.status({ jobId: remoteJobId, signal });
                if (status.state !== "completed") {
                    throw adapterError(status.code ?? "BAKE_MODEL_INCOMPLETE", status.error ?? "Bake model job did not complete.");
                }
                const result = await transport.result({ jobId: remoteJobId, signal });
                const response = normalizeBakeProviderResponse(result.response ?? buildAckResponse({
                    request: normalized,
                    requestHash,
                    options,
                    sourceDimensions,
                    effectiveDimensions: sourceDimensions,
                    runtimeStack: FAKE_INTRINSIC_RUNTIME_STACK,
                    cachePolicy: normalized.cachePolicy,
                }));
                if (response.requestHash !== requestHash) {
                    throw adapterError("BAKE_RESPONSE_MISMATCH", "Provider response requestHash does not match the active request.");
                }
                const modelOutputSet = normalizeBakeModelOutputSet(result.modelOutputSet);
                if (modelOutputSet.requestHash !== requestHash) {
                    throw adapterError("BAKE_MODEL_OUTPUT_INVALID", "Model output set requestHash does not match the request.");
                }
                const modelBuffers = await downloadModelBuffers(transport, remoteJobId, modelOutputSet, signal);
                return {
                    response,
                    modelOutputSet,
                    modelBuffers,
                };
            } catch (error) {
                if (signal?.aborted || /cancel/i.test(error?.message ?? "") || error?.code === "BAKE_MODEL_CANCELLED") {
                    await cancelRemote();
                    const cancelled = adapterError("BAKE_MODEL_CANCELLED", error?.message ?? "Bake model job cancelled.");
                    throw cancelled;
                }
                throw error;
            }
        },
    };
}
