// CDN-vs-local source picker, dynamic script loader, and cache
// warm-up. Owned by sources.js so the rest of the app doesn't have
// to know whether ffmpeg.wasm/transformers/models came from the
// local vendor/ + models/ directories or from jsdelivr/HuggingFace.
//
// On import there's no work done — pickSources() lazily probes on
// first call and caches the result. The main editor calls it once at
// boot (to paint the LOCAL/CDN pill) and again from ensureFFmpeg() /
// the transcribe worker init (which reuses the cached promise).

// CDN URLs and local paths paired side-by-side. The probe in
// pickSources() picks per-asset which to use; swap the CDN URLs here
// when bumping versions (mirrored in setup.sh — keep in sync).
//
// ffmpeg is loaded as ES modules now (was UMD pre-refactor). The
// ESM bundles let us `import()` without polluting window.* globals
// and avoid the dynamic <script> tag dance.
export const SOURCES = {
    local: {
        ffmpegBase:       'vendor/ffmpeg/',
        ffmpegFFmpegEsm:  './vendor/ffmpeg/ffmpeg.esm.js',
        ffmpegUtilEsm:    './vendor/ffmpeg/util.esm.js',
        // ffmpeg.esm.js spawns `new Worker("./worker.js", import.meta.url)`
        // on ff.load(). We pass classWorkerURL explicitly (see editor.js)
        // because the bundle's URL doesn't resolve naturally — for /+esm
        // CDN URLs the implicit "./worker.js" lands on a non-existent
        // path. Explicit URL works for both modes consistently.
        ffmpegWorkerUrl:  './vendor/ffmpeg/worker.js',
        transformersJs:   './vendor/transformers/transformers.min.js',
        modelBase:        './models/',
    },
    cdn: {
        // ESM, not UMD: worker.js spawns as a module worker and
        // falls through to `import(coreURL).default` — only the ESM
        // build exports that. UMD yields "failed to import
        // ffmpeg-core.js". (Keep in lockstep with setup.sh.)
        ffmpegBase:       'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/',
        // jsdelivr's `/+esm` suffix bundles each package into one
        // self-contained ESM file — same shape we get on local via
        // setup.sh, so the import() path is identical in both modes.
        ffmpegFFmpegEsm:  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm',
        ffmpegUtilEsm:    'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm',
        ffmpegWorkerUrl:  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js/+esm',
        transformersJs:   'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js',
        // Models live on HuggingFace; transformers.js fetches from
        // `https://huggingface.co/<modelId>/resolve/main/`
        // automatically when env.allowRemoteModels=true.
        modelBase:        'https://huggingface.co/',
    },
};

// Pre-flight probe paths. If the file at PROBE_PATHS.ffmpeg exists,
// we pick local for ffmpeg; same independent check for the others.
//
// ffmpeg probe specifically targets ffmpeg.esm.js (not the wasm
// binary) because that's the file we actually `import()`. A stale
// vendor/ from before the UMD→ESM switch will still have
// ffmpeg-core.wasm but no .esm.js — probing the wasm would say
// "local!" and then the import would fail. Probing the .esm.js
// keeps the fallback to CDN clean.
export const PROBE_PATHS = {
    ffmpeg:       'vendor/ffmpeg/ffmpeg.esm.js',
    transformers: 'vendor/transformers/transformers.min.js',
    // One model file is enough to signal "models are vendored".
    models:       'models/onnx-community/whisper-tiny.en/onnx/encoder_model_quantized.onnx',
};

let _sourcesPromise = null;

export function pickSources() {
    if (_sourcesPromise) return _sourcesPromise;
    _sourcesPromise = (async () => {
        async function probe(url) {
            try {
                const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                return r.ok;
            } catch { return false; }
        }
        const [ffmpegLocal, transformersLocal, modelsLocal] = await Promise.all([
            probe(PROBE_PATHS.ffmpeg),
            probe(PROBE_PATHS.transformers),
            probe(PROBE_PATHS.models),
        ]);
        const sources = {
            ffmpeg:       ffmpegLocal       ? 'local' : 'cdn',
            transformers: transformersLocal ? 'local' : 'cdn',
            models:       modelsLocal       ? 'local' : 'cdn',
            resolved: {
                ffmpegBase:      (ffmpegLocal ? SOURCES.local : SOURCES.cdn).ffmpegBase,
                ffmpegFFmpegEsm: (ffmpegLocal ? SOURCES.local : SOURCES.cdn).ffmpegFFmpegEsm,
                ffmpegUtilEsm:   (ffmpegLocal ? SOURCES.local : SOURCES.cdn).ffmpegUtilEsm,
                ffmpegWorkerUrl: (ffmpegLocal ? SOURCES.local : SOURCES.cdn).ffmpegWorkerUrl,
                transformersJs:  (transformersLocal ? SOURCES.local : SOURCES.cdn).transformersJs,
                modelBase:       (modelsLocal ? SOURCES.local : SOURCES.cdn).modelBase,
                modelsLocal,
            },
        };
        console.log('[sources]', sources);
        return sources;
    })();
    return _sourcesPromise;
}

// Apply the source-mode pill in the header. Caller passes in the
// element ref (so this file doesn't have to know DOM ids); the
// editor calls renderSourceMode(document.getElementById('sourceMode'),
// await pickSources()) once at boot.
export function renderSourceMode(el, sources) {
    if (!el) return;
    const modes = new Set([sources.ffmpeg, sources.transformers, sources.models]);
    const mode = modes.size === 1 ? [...modes][0] : 'mixed';
    el.dataset.mode = mode;
    el.textContent = mode === 'mixed' ? 'Mixed' : (mode === 'local' ? 'Local' : 'CDN');
    el.title =
        `ffmpeg: ${sources.ffmpeg}\n` +
        `transformers: ${sources.transformers}\n` +
        `models: ${sources.models}\n` +
        `\nLocal = served from vendor/ + models/ in this repo.\n` +
        `CDN = fetched from jsdelivr / HuggingFace on demand.`;
}

// ---- Cache warm-up ----

// For a given Whisper model, return the list of remote files. Only
// relevant when models source is 'cdn' — local models are already
// on disk and don't need warming.
function whisperModelUrls(sources, modelId) {
    if (sources.models === 'local') return [];
    const base = sources.resolved.modelBase + modelId + '/resolve/main';
    return [
        `${base}/config.json`,
        `${base}/generation_config.json`,
        `${base}/tokenizer.json`,
        `${base}/tokenizer_config.json`,
        `${base}/preprocessor_config.json`,
        `${base}/onnx/encoder_model_quantized.onnx`,
        `${base}/onnx/decoder_model_merged_quantized.onnx`,
    ];
}

function collectWarmupUrls(sources, modelId) {
    const urls = [];
    if (sources.ffmpeg === 'cdn') {
        urls.push(sources.resolved.ffmpegUtilEsm);
        urls.push(sources.resolved.ffmpegFFmpegEsm);
        // worker.js is spawned by ffmpeg.esm.js on ff.load(). We pass
        // classWorkerURL explicitly (sources.resolved.ffmpegWorkerUrl)
        // — warm it too so the first encode doesn't pay the round-trip.
        urls.push(sources.resolved.ffmpegWorkerUrl);
        urls.push(sources.resolved.ffmpegBase + 'ffmpeg-core.js');
        urls.push(sources.resolved.ffmpegBase + 'ffmpeg-core.wasm');
    }
    if (sources.transformers === 'cdn') {
        const base = sources.resolved.transformersJs.replace(/[^/]+$/, '');
        urls.push(sources.resolved.transformersJs);
        urls.push(base + 'ort-wasm-simd-threaded.jsep.mjs');
        urls.push(base + 'ort-wasm-simd-threaded.jsep.wasm');
    }
    urls.push(...whisperModelUrls(sources, modelId));
    return urls;
}

// Fetches all CDN-served assets once so the browser HTTP cache
// stores them. Subsequent ffmpeg/Whisper loads hit the cache instead
// of the network. No-op when everything's already LOCAL.
export async function warmUpCache(modelId, onProgress) {
    const sources = await pickSources();
    const urls = collectWarmupUrls(sources, modelId);
    if (urls.length === 0) {
        return { fetched: 0, failed: 0, total: 0, alreadyLocal: true };
    }

    let fetched = 0;
    let failed = 0;
    // Parallelise modestly — 4 at a time keeps the network busy
    // without overwhelming the connection or hitting per-host
    // browser concurrency limits.
    const CONCURRENCY = 4;
    let nextIdx = 0;
    async function worker() {
        while (true) {
            const i = nextIdx++;
            if (i >= urls.length) return;
            const url = urls[i];
            try {
                // mode: cors + default browser caching. We deliberately
                // do NOT use 'force-cache' so the SW (coi-serviceworker)
                // can still rewrite COEP headers in-flight.
                const r = await fetch(url, { mode: 'cors' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                // Read the body so the browser actually caches it.
                // Without consuming the response, some browsers
                // discard the body even on a 200.
                await r.arrayBuffer();
                fetched++;
            } catch (e) {
                console.warn('warmUp: failed', url, e);
                failed++;
            }
            if (onProgress) onProgress(fetched + failed, urls.length, url);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { fetched, failed, total: urls.length, alreadyLocal: false };
}
