// Whisper transcription worker.
//
// Two-message protocol so the main app can pick CDN vs local
// transformers.js / models at runtime:
//
//   1. { type: 'init', transformersUrl, localModelPath,
//        allowLocalModels, allowRemoteModels }
//      Loaded once before the first transcribe call. transformersUrl
//      can be either './vendor/transformers/transformers.min.js'
//      (local vendor) or a jsdelivr CDN URL.
//
//   2. { type: 'transcribe', audio, model }
//      Runs the Whisper chunk loop. Posts status / progress / update /
//      complete / error messages back to the main thread.
//
// Old behaviour was a static `import` of the local file; that
// forced everyone to vendor the wasm runtime, which made hosted
// (CDN-only) deployments impossible. Dynamic import + init message
// lets the same worker file serve both modes.

let pipeline = null;
let env = null;
let currentModel = null;
let _initPromise = null;

function init(config) {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        const mod = await import(config.transformersUrl);
        pipeline = mod.pipeline;
        env = mod.env;
        env.backends.onnx.wasm.proxy = false;
        env.allowLocalModels  = !!config.allowLocalModels;
        env.allowRemoteModels = !!config.allowRemoteModels;
        if (config.localModelPath) {
            env.localModelPath = config.localModelPath;
        }
    })();
    return _initPromise;
}

async function getTranscriber(model) {
    if (pipeline === null) {
        throw new Error('transcribe-worker: received transcribe before init');
    }
    if (currentModel === model && self._transcriber) {
        return self._transcriber;
    }

    self.postMessage({ type: 'status', status: 'loading', message: `Loading ${model}...` });

    self._transcriber = await pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        progress_callback: (progress) => {
            if (progress.status === 'initiate' || progress.status === 'progress' || progress.status === 'done') {
                self.postMessage({ type: 'model_progress', ...progress });
            }
        },
    });
    currentModel = model;
    return self._transcriber;
}

self.addEventListener('message', async (e) => {
    if (e.data.type === 'init') {
        // Fire-and-forget — init() caches its own promise; the next
        // transcribe will await it.
        init(e.data);
        return;
    }

    if (e.data.type !== 'transcribe') return;

    // Block on init if the main thread sent transcribe before init
    // finished — race-safe across message ordering.
    if (_initPromise) {
        try { await _initPromise; }
        catch (err) {
            self.postMessage({ type: 'error', error: `init failed: ${err.message}` });
            return;
        }
    }

    const { audio, model } = e.data;

    try {
        const pipe = await getTranscriber(model);

        self.postMessage({ type: 'status', status: 'transcribing', message: 'Transcribing...' });

        // Replicate _call_whisper chunk loop with progress reporting
        const sampling_rate = pipe.processor.feature_extractor.config.sampling_rate;
        const hop_length = pipe.processor.feature_extractor.config.hop_length;
        const time_precision =
            pipe.processor.feature_extractor.config.chunk_length /
            pipe.model.config.max_source_positions;

        const chunk_length_s = 30;
        const stride_length_s = 5;
        const window = sampling_rate * chunk_length_s;
        const stride = sampling_rate * stride_length_s;
        const jump = window - 2 * stride;

        // Pre-build chunk list
        const chunks = [];
        let offset = 0;
        while (true) {
            const offset_end = offset + window;
            const subarr = audio.subarray(offset, offset_end);
            const is_first = offset === 0;
            const is_last = offset_end >= audio.length;
            chunks.push({ subarr, is_first, is_last, offset });
            if (is_last) break;
            offset += jump;
        }

        const totalChunks = chunks.length;
        const processed = [];
        let lastDecoded = null;

        for (let i = 0; i < totalChunks; i++) {
            const { subarr, is_first, is_last } = chunks[i];

            self.postMessage({
                type: 'progress',
                chunksProcessed: i,
                totalChunks,
                message: `Transcribing... chunk ${i + 1}/${totalChunks}`,
            });

            const feature = await pipe.processor(subarr);
            const num_frames = Math.floor(subarr.length / hop_length);

            const data = await pipe.model.generate({
                inputs: feature.input_features,
                return_timestamps: true,
                force_full_sequences: false,
                num_frames,
            });

            const chunkObj = {
                stride: [
                    subarr.length / sampling_rate,
                    is_first ? 0 : stride / sampling_rate,
                    is_last ? 0 : stride / sampling_rate,
                ],
                tokens: data[0].tolist(),
                is_last,
            };
            processed.push(chunkObj);

            // Decode all chunks so far and send incremental transcript
            const [text, meta] = pipe.tokenizer._decode_asr(processed, {
                time_precision,
                return_timestamps: true,
                force_full_sequences: false,
            });
            lastDecoded = [text, meta];

            self.postMessage({
                type: 'update',
                data: [text, meta],
                chunksProcessed: i + 1,
                totalChunks,
            });
        }

        // The last loop iteration already decoded the full `processed`
        // set — reuse it to signal completion rather than re-running the
        // identical (and expensive) ASR decode again.
        const [full_text, optional] = lastDecoded ?? ['', {}];

        self.postMessage({
            type: 'complete',
            result: { text: full_text, ...optional },
        });
    } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
    }
});
