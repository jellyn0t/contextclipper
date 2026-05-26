// In-browser speech-to-text via Whisper running in a Web Worker
// (transcribe-worker.js + transformers.js). Decodes the loaded video's
// audio to 16 kHz mono, streams it to the worker, and renders clickable
// timestamped segments.

import { state, layoutSettings } from './state.js';
import { CONFIG } from './config.js';
import {
    transcribeBtn, transcriptProgress, transcriptProgressFill, transcriptProgressText,
    transcriptList, modelCacheInfo, videoEl, escapeHtml,
} from './dom.js';
import { formatTimecode } from './timecode.js';
import { pickSources } from './sources.js';
import { extractAudioForWhisper } from './encoding.js';

async function getResampledAudio(onProgress) {
    if (state.resampledAudio) return state.resampledAudio;
    const mono = state.videoFile.size <= CONFIG.maxInMemoryDecodeBytes
        ? await decodeAudioInMemory(state.videoFile)
        // Large files: stream through ffmpeg so we never load the whole file
        // (or its full multi-channel decode) into memory.
        : await extractAudioForWhisper(state.videoFile, 16000, onProgress);
    state.resampledAudio = mono;
    return mono;
}

// 16 kHz mono Float32 via Web Audio — fast path for small/medium files.
async function decodeAudioInMemory(file) {
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const arrayBuffer = await file.arrayBuffer();
    let audioBuffer;
    try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } finally {
        audioCtx.close();
    }

    // Mix down to mono
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    const numChannels = audioBuffer.numberOfChannels;
    for (let ch = 0; ch < numChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) mono[i] += channelData[i];
    }
    if (numChannels > 1) {
        const scale = 1 / numChannels;
        for (let i = 0; i < length; i++) mono[i] *= scale;
    }

    return mono;
}

const WHISPER_MODELS = [
    'onnx-community/whisper-tiny.en',
    'onnx-community/whisper-base.en',
];

async function isModelAvailable(modelId) {
    // Returns 'local' / 'cdn' / false. Local = vendored model
    // file is present (offline-ready). CDN = no local file but
    // transformers.js will fall back to HuggingFace remote on
    // first transcribe (works, just downloads ~40-75 MB live).
    try {
        const resp = await fetch(
            `./models/${modelId}/onnx/encoder_model_quantized.onnx`,
            { method: 'HEAD' },
        );
        if (resp.ok) return 'local';
    } catch { /* ignore */ }
    // CDN availability not pre-checked — trust HuggingFace is up.
    return 'cdn';
}

export async function renderModelCacheInfo() {
    const results = await Promise.all(WHISPER_MODELS.map(async id => ({
        id, where: await isModelAvailable(id),
    })));
    modelCacheInfo.innerHTML = results.map(e => {
        const shortName = e.id.split('/').pop();
        const status = e.where === 'local'
            ? '<span style="color:var(--success)">local</span>'
            : '<span style="color:var(--accent)">CDN (will download)</span>';
        return `<div class="model-cache-item">
            <span class="cache-name">${escapeHtml(shortName)}</span>
            <span>${status}</span>
        </div>`;
    }).join('');
}

function modelShortName(modelId) {
    return modelId.split('/').pop().replace('whisper-', '');
}

function formatDurationHuman(seconds) {
    const totalMin = Math.round(seconds / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export async function updateTranscriptDefault() {
    if (state.transcriptSegments.length > 0 || state.transcribing) return;
    const model = layoutSettings.whisperModel;
    const where = await isModelAvailable(model);  // 'local' | 'cdn'
    const name = modelShortName(model);
    const badge = where === 'local'
        ? '<span style="color:var(--success)"> (local, ready)</span>'
        : '<span style="color:var(--accent)"> (will download from HuggingFace)</span>';
    const warning = state.videoDuration > CONFIG.transcriptWarnSeconds
        ? `<div class="transcript-warning">
            <span class="tw-icon" aria-hidden="true">⚠</span>
            <span>This video is ${formatDurationHuman(state.videoDuration)}. Transcription runs entirely in your browser — for a clip this long it'll take several minutes and use a lot of memory.</span>
        </div>`
        : '';
    transcriptList.innerHTML = warning + `<div style="padding:8px;font-size:11px;color:var(--monitor-dim)">
        Model: <strong style="color:var(--monitor-glow)">${escapeHtml(name)}</strong>
        ${badge}
    </div>`;
}

export function startTranscription() {
    if (state.transcribing || !state.videoFile) return;
    state.transcribing = true;
    transcribeBtn.classList.add('active');
    transcribeBtn.textContent = 'Transcribing...';
    transcriptProgress.classList.add('visible');
    transcriptProgressFill.style.width = '0%';
    transcriptProgressText.textContent = 'Preparing audio...';
    state.transcriptSegments = [];
    transcriptList.innerHTML = '';

    // Track model download progress across multiple files
    let modelFiles = {};

    getResampledAudio((pct, phase) => {
        transcriptProgressFill.style.width = pct + '%';
        transcriptProgressText.textContent = phase || 'Preparing audio...';
    }).then(async audio => {
        // The user may have cleared or swapped the video while we were
        // decoding (esp. the slow ffmpeg path) — don't spin up a worker
        // against stale audio.
        if (!state.transcribing || !state.videoFile) {
            state.resampledAudio = null;
            return;
        }

        // Resolve sources before constructing the worker so the
        // init message carries the right URLs. Probe is cached, so
        // this is a no-op after the first call.
        const sources = await pickSources();

        // Create worker
        if (state.transcriptWorker) state.transcriptWorker.terminate();
        state.transcriptWorker = new Worker('transcribe-worker.js', { type: 'module' });
        state.transcriptWorker.postMessage({
            type: 'init',
            transformersUrl: sources.resolved.transformersJs,
            localModelPath: sources.resolved.modelBase,
            // If the user has local models, prefer them. Always
            // allow remote so a model the user hasn't vendored
            // (e.g. base.en when only tiny.en is local) auto-falls
            // back to HuggingFace CDN.
            allowLocalModels: sources.resolved.modelsLocal,
            allowRemoteModels: true,
        });

        state.transcriptWorker.addEventListener('message', (e) => {
            const msg = e.data;

            if (msg.type === 'model_progress') {
                handleModelProgress(msg);
            } else if (msg.type === 'status') {
                transcriptProgressText.textContent = msg.message;
                if (msg.status === 'transcribing') {
                    transcriptProgressFill.style.width = '0%';
                }
            } else if (msg.type === 'progress') {
                const pct = Math.round((msg.chunksProcessed / msg.totalChunks) * 100);
                transcriptProgressFill.style.width = pct + '%';
                transcriptProgressText.textContent = msg.message;
            } else if (msg.type === 'update') {
                handleTranscriptUpdate(msg);
            } else if (msg.type === 'complete') {
                handleTranscriptComplete(msg.result);
            } else if (msg.type === 'error') {
                transcriptProgressText.textContent = 'Error: ' + msg.error;
                state.transcribing = false;
                transcribeBtn.classList.remove('active');
                transcribeBtn.textContent = 'Transcribe';
            }
        });

        function handleModelProgress(progress) {
            const file = progress.file;
            if (!modelFiles[file]) modelFiles[file] = 0;

            if (progress.status === 'progress') {
                modelFiles[file] = progress.progress || 0;
            } else if (progress.status === 'done') {
                modelFiles[file] = 100;
            }

            const files = Object.values(modelFiles);
            const totalFiles = files.length;
            if (totalFiles > 0) {
                const sum = files.reduce((a, b) => a + b, 0);
                const pct = Math.min(100, Math.round(sum / totalFiles));
                transcriptProgressFill.style.width = pct + '%';
                transcriptProgressText.textContent = `Downloading model... ${pct}%`;
            }
        }

        // Transfer the audio buffer to the worker — no copy. It's detached
        // afterward, so clear the cache first; a re-transcribe rebuilds it.
        state.resampledAudio = null;
        state.transcriptWorker.postMessage(
            { type: 'transcribe', audio, model: layoutSettings.whisperModel },
            [audio.buffer]
        );
    }).catch(err => {
        transcriptProgressText.textContent = 'Audio decode failed: ' + err.message;
        state.transcribing = false;
        transcribeBtn.classList.remove('active');
        transcribeBtn.textContent = 'Transcribe';
    });
}

function handleTranscriptUpdate(msg) {
    // msg.data is [text, { chunks }] from _decode_asr
    const [text, meta] = msg.data;
    if (meta && meta.chunks && meta.chunks.length > 0) {
        state.transcriptSegments = meta.chunks.map(c => ({
            text: (c.text || '').trim(),
            start: c.timestamp[0] ?? 0,
            end: c.timestamp[1] ?? state.videoDuration,
        })).filter(seg => seg.text.length > 0);

        renderTranscript();
    }

    const pct = Math.round((msg.chunksProcessed / msg.totalChunks) * 100);
    transcriptProgressFill.style.width = pct + '%';
    transcriptProgressText.textContent = `Transcribing... ${msg.chunksProcessed}/${msg.totalChunks} chunks`;
}

function handleTranscriptComplete(result) {
    state.transcribing = false;
    transcribeBtn.classList.remove('active');
    transcribeBtn.textContent = 'Transcribe';
    transcriptProgressFill.style.width = '100%';
    transcriptProgressText.textContent = 'Done';

    // Replace with final result for accuracy (handles stride dedup)
    if (result && result.chunks && result.chunks.length > 0) {
        state.transcriptSegments = result.chunks.map(chunk => ({
            text: chunk.text.trim(),
            start: chunk.timestamp[0] ?? 0,
            end: chunk.timestamp[1] ?? state.videoDuration,
        })).filter(seg => seg.text.length > 0);
    } else if (state.transcriptSegments.length === 0 && result && result.text) {
        state.transcriptSegments = [{ text: result.text.trim(), start: 0, end: state.videoDuration }];
    }

    renderTranscript();
    setTimeout(() => transcriptProgress.classList.remove('visible'), 1500);
}

function renderTranscript() {
    if (state.transcriptSegments.length === 0) {
        transcriptList.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--monitor-dim)">No transcript segments found</div>';
        return;
    }

    transcriptList.innerHTML = state.transcriptSegments.map((seg, i) => {
        const timeStr = formatTimecode(seg.start);
        return `<div class="transcript-segment" data-index="${i}">
            <span class="ts-time">${escapeHtml(timeStr)}</span>
            <span class="ts-text">${escapeHtml(seg.text)}</span>
        </div>`;
    }).join('');

    // Click to seek
    transcriptList.querySelectorAll('.transcript-segment').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.index);
            const seg = state.transcriptSegments[idx];
            if (seg) {
                videoEl.currentTime = seg.start;
                videoEl.play();
            }
        });
    });

    state.activeTranscriptIndex = -1;
}

export function updateActiveTranscriptSegment() {
    if (state.transcriptSegments.length === 0) return;
    const ct = videoEl.currentTime;
    let newIndex = -1;
    for (let i = 0; i < state.transcriptSegments.length; i++) {
        if (ct >= state.transcriptSegments[i].start && ct < state.transcriptSegments[i].end) {
            newIndex = i;
            break;
        }
    }

    if (newIndex === state.activeTranscriptIndex) return;

    // Remove old active
    if (state.activeTranscriptIndex >= 0) {
        const old = transcriptList.querySelector(`[data-index="${state.activeTranscriptIndex}"]`);
        if (old) old.classList.remove('active');
    }

    state.activeTranscriptIndex = newIndex;

    // Add new active
    if (newIndex >= 0) {
        const el = transcriptList.querySelector(`[data-index="${newIndex}"]`);
        if (el) {
            el.classList.add('active');
            // Auto-scroll into view
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
}

transcribeBtn.addEventListener('click', startTranscription);
