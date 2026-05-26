// ffmpeg.wasm encoding: lazy-load the ESM bundle, transcode a clip in
// the browser, and hand back an MP4 blob. Encode buttons in the clip
// list call encodeClip(); the "encode current selection" button is
// wired here.

import { state, layoutSettings } from './state.js';
import { CONFIG } from './config.js';
import {
    encodeBtn, encodeProgress, encodeProgressFill, encodeProgressText,
    clipList, labelInput,
} from './dom.js';
import { pickSources } from './sources.js';
import { renderClipList, getAutoLabel } from './clip-list.js';

// Set by the ffmpeg-based extractors (waveform / Whisper audio) so the
// shared ff 'progress' listener can report their progress — active only
// when state.encoding is false (i.e. not during a clip encode).
let ffmpegProgressCb = null;

// ffmpeg.wasm runs one command per instance, and we share a single instance
// across clip encoding, waveform extraction, and Whisper-audio extraction.
// Funnel every ffmpeg session through this queue so they serialize —
// overlapping exec/mount/unmount on one instance corrupts them.
let ffmpegQueue = Promise.resolve();

function runFfmpegExclusive(task) {
    const run = ffmpegQueue.then(task, task);
    // Advance the queue regardless of this task's outcome, without swallowing
    // the result/error for the caller.
    ffmpegQueue = run.then(() => {}, () => {});
    return run;
}

async function ensureFFmpeg(onStatus) {
    if (state.ffmpegInstance && state.ffmpegInstance.loaded) return state.ffmpegInstance;
    if (state.ffmpegLoading) {
        // Wait for ongoing load
        while (state.ffmpegLoading) await new Promise(r => setTimeout(r, 100));
        if (!state.ffmpegInstance) throw new Error('ffmpeg.wasm failed to load');
        return state.ffmpegInstance;
    }
    state.ffmpegLoading = true;

    const sources = await pickSources();
    const fromCdn = sources.ffmpeg === 'cdn';
    if (onStatus) onStatus('Loading ffmpeg.wasm (~31 MB)' + (fromCdn ? ' from CDN…' : '…'));

    try {
        // ESM dynamic import — pulls @ffmpeg/ffmpeg + @ffmpeg/util
        // straight as modules, no global window.* pollution, no
        // dynamic <script> dance. Browsers cache the import target
        // by URL so the second call is free.
        const [{ FFmpeg }, ffUtil] = await Promise.all([
            import(sources.resolved.ffmpegFFmpegEsm),
            import(sources.resolved.ffmpegUtilEsm),
        ]);
        const toBlobURL = ffUtil.toBlobURL;

        const ff = new FFmpeg();

        ff.on('log', ({ message }) => {
            console.log('[ffmpeg]', message);
        });

        ff.on('progress', ({ progress, time }) => {
            if (state.encoding && state.encodingClipDuration > 0) {
                // time is in microseconds, convert to seconds
                const timeSec = time / 1_000_000;
                const pct = Math.max(0, Math.min(100, Math.round((timeSec / state.encodingClipDuration) * 100)));
                encodeProgressFill.style.width = pct + '%';
                encodeProgressText.textContent = `Encoding... ${pct}%`;
                updateClipEncodeProgress(pct, `Encoding... ${pct}%`);
            } else if (ffmpegProgressCb) {
                // Reused for waveform extraction; `progress` is 0..1 of duration.
                ffmpegProgressCb(Math.max(0, Math.min(100, Math.round((progress || 0) * 100))));
            }
        });

        // toBlobURL handles both local paths (resolved against
        // location.href) and CDN URLs (resolved as-is).
        const baseURL = sources.resolved.ffmpegBase.startsWith('http')
            ? sources.resolved.ffmpegBase
            : new URL(sources.resolved.ffmpegBase, window.location.href).toString();
        // classWorkerURL override: ffmpeg.esm.js's default is to do
        // `new Worker(new URL("./worker.js", import.meta.url))`, which
        // resolves against the BUNDLE's URL — for jsdelivr's /+esm
        // that lands on a non-existent path. Passing the URL
        // explicitly makes both local and CDN work without relying
        // on bundler URL conventions. toBlobURL because the worker
        // is `type: "module"` and a same-origin blob avoids the
        // CORS dance when the source is CDN.
        const workerURL = sources.resolved.ffmpegWorkerUrl.startsWith('http')
            ? sources.resolved.ffmpegWorkerUrl
            : new URL(sources.resolved.ffmpegWorkerUrl, window.location.href).toString();
        await ff.load({
            coreURL: await toBlobURL(baseURL + 'ffmpeg-core.js', 'text/javascript'),
            wasmURL: await toBlobURL(baseURL + 'ffmpeg-core.wasm', 'application/wasm'),
            classWorkerURL: await toBlobURL(workerURL, 'text/javascript'),
        });

        state.ffmpegInstance = ff;
        return ff;
    } catch (err) {
        console.error('Failed to load ffmpeg.wasm:', err);
        if (onStatus) onStatus('Failed to load ffmpeg.wasm: ' + err.message);
        throw err;
    } finally {
        state.ffmpegLoading = false;
    }
}

function updateClipEncodeProgress(pct, text) {
    const fill = document.getElementById('clipEncodeFill');
    const label = document.getElementById('clipEncodeText');
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = text;
}

// Mount a File read-only via WORKERFS so ffmpeg reads it lazily (slices on
// demand) rather than copying the whole file into wasm memory — required
// for multi-GB sources, which can't be read into a single ArrayBuffer.
// Returns the path to the file inside ffmpeg's virtual FS.
async function mountFileLazily(ff, file, dir) {
    try { await ff.unmount(dir); } catch { /* nothing mounted there yet */ }
    try { await ff.createDir(dir); } catch { /* dir already exists */ }
    await ff.mount('WORKERFS', { files: [file] }, dir);
    return `${dir}/${file.name || 'input'}`;
}

export async function encodeClip(start, end, label, clipId) {
    if (state.encoding) return;
    if (!state.videoFile) { alert('No video loaded'); return; }

    state.encoding = true;
    state.encodingClipId = clipId ?? null;
    encodeBtn.disabled = true;
    encodeProgress.classList.add('visible');
    encodeProgressFill.style.width = '0%';
    encodeProgressText.textContent = 'Preparing...';

    // Disable all encode buttons and show inline progress
    clipList.querySelectorAll('.encode-clip-btn').forEach(b => b.disabled = true);
    if (state.encodingClipId != null) renderClipList();

    const safeName = (label || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputName = safeName + '.mp4';

    try {
        // Serialize the whole ffmpeg session so it can't overlap a waveform
        // or Whisper-audio extraction on the shared instance.
        const blob = await runFfmpegExclusive(async () => {
            const ff = await ensureFFmpeg(msg => { encodeProgressText.textContent = msg; });

            const mountDir = '/encin';
            try {
                // Mount the source lazily via WORKERFS. Copying a multi-GB file
                // into wasm memory (fetchFile + writeFile) fails — FileReader
                // can't read the whole file into one ArrayBuffer. WORKERFS lets
                // ffmpeg seek and read only the bytes this clip needs.
                encodeProgressText.textContent = 'Reading video file...';
                updateClipEncodeProgress(0, 'Reading video file...');
                const inputPath = await mountFileLazily(ff, state.videoFile, mountDir);

                encodeProgressText.textContent = 'Encoding...';
                encodeProgressFill.style.width = '0%';
                updateClipEncodeProgress(0, 'Encoding...');
                state.encodingClipDuration = end - start;

                const ss = start.toFixed(3);
                const duration = state.encodingClipDuration.toFixed(3);
                await ff.exec([
                    '-ss', ss,
                    '-i', inputPath,
                    '-t', duration,
                    '-c:v', 'libx264',
                    '-crf', String(layoutSettings.wasmCrf),
                    '-preset', layoutSettings.wasmPreset,
                    '-c:a', 'aac',
                    '-b:a', layoutSettings.wasmAudioBitrate,
                    '-movflags', '+faststart',
                    outputName,
                ]);

                encodeProgressText.textContent = 'Finalizing...';
                updateClipEncodeProgress(100, 'Finalizing...');
                const data = await ff.readFile(outputName);
                const out = new Blob([data.buffer], { type: 'video/mp4' });
                await ff.deleteFile(outputName);
                return out;
            } finally {
                // Release the WORKERFS mount (best-effort).
                try { await ff.unmount(mountDir); } catch { /* ignore */ }
            }
        });

        // Store blob on the clip if this was a bookmarked clip encode
        if (clipId != null) {
            const clip = state.bookmarks.find(c => c.id === clipId);
            if (clip) {
                clip.blob = blob;
                clip.outputName = outputName;
            }
            encodeProgressFill.style.width = '100%';
            encodeProgressText.textContent = 'Done! Click download on the clip.';
        } else {
            // No bookmarked clip — download immediately
            downloadBlob(blob, outputName);
            encodeProgressFill.style.width = '100%';
            encodeProgressText.textContent = 'Done! Download started.';
        }

        setTimeout(() => {
            if (!state.encoding) {
                encodeProgress.classList.remove('visible');
            }
        }, CONFIG.encodeHideDuration);
    } catch (err) {
        console.error('Encode failed:', err);
        encodeProgressText.textContent = 'Encode failed: ' + err.message;
    } finally {
        state.encoding = false;
        state.encodingClipId = null;
        encodeBtn.disabled = false;
        renderClipList();
    }
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// Build waveform peaks for files too large to decode in memory. ffmpeg
// reads the File lazily through a WORKERFS mount (FileReaderSync slices on
// demand — the multi-GB source is never fully copied into wasm memory),
// downsamples to low-rate mono 16-bit PCM, and we peak-reduce that to the
// same peaks-per-second the in-memory path produces. Memory stays bounded:
// the extracted PCM is capped (~32 MB) and read in place via a DataView.
export async function extractPeaksViaFfmpeg(file, peaksPerSecond, duration, onProgress) {
    return runFfmpegExclusive(async () => {
        const report = (pct, phase) => { if (onProgress) onProgress(pct, phase); };
        report(4, 'Loading ffmpeg');
        const ff = await ensureFFmpeg(msg => report(6, msg));

        // Cap total samples regardless of length (s16le = 2 bytes/sample, so
        // ~16M samples ≈ 32 MB). Pick a sample rate that fits, clamped so each
        // peak window still spans enough samples for a clean envelope.
        const PCM_SAMPLE_CAP = 16_000_000;
        const safeDuration = Math.max(1, duration || 0);
        const targetRate = Math.max(200, Math.min(8000, Math.floor(PCM_SAMPLE_CAP / safeDuration)));

        const mountDir = '/wfin';
        const outName = 'wf.pcm';

        ffmpegProgressCb = (pct) => report(6 + Math.round(pct * 0.84), 'Analyzing audio');
        try {
            const inputPath = await mountFileLazily(ff, file, mountDir);

            await ff.exec([
                '-i', inputPath,
                '-vn',                      // drop the video stream
                '-ac', '1',                 // downmix to mono
                '-ar', String(targetRate),  // low sample rate
                '-f', 's16le',              // 16-bit PCM — half the bytes of f32le
                outName,
            ]);

            report(92, 'Generating waveform');
            const data = await ff.readFile(outName);   // Uint8Array of s16le PCM
            // Read samples in place — no Float32 copy of the whole buffer.
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const numSamples = Math.floor(data.byteLength / 2);

            const samplesPerPeak = Math.max(1, Math.floor(targetRate / peaksPerSecond));
            const numPeaks = Math.max(1, Math.ceil(numSamples / samplesPerPeak));
            const peaksArr = new Array(numPeaks);
            for (let p = 0; p < numPeaks; p++) {
                const s = p * samplesPerPeak;
                const e = Math.min(s + samplesPerPeak, numSamples);
                let maxAbs = 0;
                for (let i = s; i < e; i++) {
                    const v = Math.abs(view.getInt16(i * 2, true));
                    if (v > maxAbs) maxAbs = v;
                }
                peaksArr[p] = maxAbs / 32768;   // normalize to 0..1 like the Web Audio path
            }
            report(100, 'Generating waveform');
            return peaksArr;
        } finally {
            ffmpegProgressCb = null;
            try { await ff.deleteFile(outName); } catch { /* ignore */ }
            try { await ff.unmount(mountDir); } catch { /* ignore */ }
        }
    });
}

// Decode the source to the 16 kHz mono Float32 PCM Whisper expects, by
// streaming through ffmpeg (WORKERFS) — avoids loading the whole file, or
// its full multi-channel decode, into memory. Returns a Float32Array whose
// buffer the caller can transfer straight to the transcription worker.
export async function extractAudioForWhisper(file, sampleRate, onProgress) {
    return runFfmpegExclusive(async () => {
        const report = (pct, phase) => { if (onProgress) onProgress(pct, phase); };
        report(2, 'Loading ffmpeg');
        const ff = await ensureFFmpeg(msg => report(4, msg));

        const mountDir = '/scin';
        const outName = 'speech.f32';
        ffmpegProgressCb = (pct) => report(4 + Math.round(pct * 0.92), 'Extracting audio');
        try {
            const inputPath = await mountFileLazily(ff, file, mountDir);
            await ff.exec([
                '-i', inputPath,
                '-vn',                      // drop the video stream
                '-ac', '1',                 // mono
                '-ar', String(sampleRate),  // Whisper's required 16 kHz
                '-f', 'f32le',              // raw float32 — what the pipeline wants
                outName,
            ]);
            const data = await ff.readFile(outName);   // Uint8Array of f32le PCM
            // View as Float32 with no extra copy (readFile returns an offset-0,
            // 4-byte-aligned buffer); the caller transfers this buffer.
            return new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
        } finally {
            ffmpegProgressCb = null;
            try { await ff.deleteFile(outName); } catch { /* ignore */ }
            try { await ff.unmount(mountDir); } catch { /* ignore */ }
        }
    });
}

// Encode the current selection (vs. a bookmarked clip).
encodeBtn.addEventListener('click', () => {
    const label = labelInput.value.trim() || getAutoLabel();
    encodeClip(state.clipStart, state.clipEnd, label);
});
