// Orchestration core — the entry module (index.html loads this). It
// loads videos, owns the clip/window selection state machine + syncAll,
// and wires the core interactions (drag/drop, waveform, playback,
// keyboard). Domain logic lives in siblings:
//
//   ./waveform-editor.js — registers <waveform-editor> + <time-ruler>
//                          custom elements as a side effect of import.
//   ./config.js          — tuneable constants (CONFIG).
//   ./state.js           — shared mutable state (state, layoutSettings).
//   ./dom.js             — DOM refs + escapeHtml.
//   ./timecode.js        — pure time/size formatters.
//   ./clip-list.js       — bookmarks: create/render/navigate/export.
//   ./encoding.js        — ffmpeg.wasm clip encoding.
//   ./transcription.js   — Whisper transcription via worker.
//   ./video-controls.js  — custom player chrome + dimming (self-wiring).
//   ./settings.js        — settings modal, theme, cache warm-up (self-wiring).
//   ./sources.js         — CDN-vs-local probe + cache warm-up.
//   ./export.js          — pure clip-export formatters (JSON, ffmpeg).

import './waveform-editor.js';
import { pickSources, renderSourceMode } from './sources.js';
import { state, layoutSettings } from './state.js';
import { CONFIG } from './config.js';
import {
    videoArea, videoEl, filePicker, loadingOverlay,
    fileInfo, fileNameEl, clearBtn, startInput, endInput, durationDisplay, playBtn,
    overviewSection, detailSection, ffmpegSection, ffmpegCmd, copyBtn, loopBtn,
    shortcutsPanel, controlsRow, labelInput, labelLock, clipListSection,
    overviewWf, detailWf, overviewRuler, detailRuler, sidebar,
    transcriptSection, transcribeBtn, transcriptList, transcriptProgress,
    progressBar, progressFill, loadingPhrase, loadingPct, appEl, maximizeBtn, sourceMode,
} from './dom.js';
import { formatTimecode, parseTimecode } from './timecode.js';
import {
    renderClipList, renderOverviewMarkers, bookmarkClip, deleteClip,
    updateLabel, buildFfmpegCommand,
} from './clip-list.js';
import {
    startTranscription, updateActiveTranscriptSegment, updateTranscriptDefault,
} from './transcription.js';
import { extractPeaksViaFfmpeg } from './encoding.js';
import { startLoadingGame, stopLoadingGame } from './loading-game.js';
// Self-wiring modules — imported for their side effects (event listeners
// + boot calls). No named exports consumed here.
import './settings.js';
import './video-controls.js';

// ---- Loading helpers ----

let loadingGameTimer = null;

function pickPhrase() {
    return CONFIG.loadingPhrases[Math.floor(Math.random() * CONFIG.loadingPhrases.length)];
}

function showLoading(phrase) {
    loadingPhrase.textContent = phrase || pickPhrase();
    loadingPct.textContent = '';
    progressBar.classList.add('indeterminate');
    progressFill.style.width = '0%';
    loadingOverlay.classList.add('visible');
    state.loading = true;
    // If the load drags on, drop a brick-breaker into the overlay to pass
    // the time. Cleared in hideLoading (or if the load finishes first).
    clearTimeout(loadingGameTimer);
    loadingGameTimer = setTimeout(startLoadingGame, CONFIG.loadingGameDelayMs);
}

function setLoadingProgress(pct, phrase) {
    if (phrase) loadingPhrase.textContent = phrase;
    progressBar.classList.remove('indeterminate');
    progressFill.style.width = pct + '%';
    loadingPct.textContent = pct > 0 ? `${pct}%` : '';
}

function hideLoading() {
    state.loading = false;
    clearTimeout(loadingGameTimer);
    stopLoadingGame();
    loadingOverlay.classList.remove('visible');
}

// ---- Clamp clip to window ----

function clampClipToWindow() {
    const windowSpan = state.windowEnd - state.windowStart;
    let clipSpan = state.clipEnd - state.clipStart;
    if (clipSpan > windowSpan) {
        clipSpan = Math.max(CONFIG.minClip, windowSpan);
        const mid = (state.windowStart + state.windowEnd) / 2;
        state.clipStart = mid - clipSpan / 2;
        state.clipEnd = mid + clipSpan / 2;
    }
    if (state.clipStart < state.windowStart) { state.clipStart = state.windowStart; state.clipEnd = state.clipStart + clipSpan; }
    if (state.clipEnd > state.windowEnd) { state.clipEnd = state.windowEnd; state.clipStart = state.clipEnd - clipSpan; }
    state.clipStart = Math.max(0, state.clipStart);
    state.clipEnd = Math.min(state.videoDuration, state.clipEnd);
    if (state.clipEnd - state.clipStart < CONFIG.minClip) state.clipEnd = Math.min(state.clipStart + CONFIG.minClip, state.videoDuration);
}

// ---- Sync all UI ----

export function syncAll() {
    // Timecodes
    if (document.activeElement !== startInput) startInput.value = formatTimecode(state.clipStart);
    if (document.activeElement !== endInput) endInput.value = formatTimecode(state.clipEnd);
    durationDisplay.textContent = (state.clipEnd - state.clipStart).toFixed(1) + 's';

    // Overview waveform: start/end = window selection (zoom), shows full duration
    overviewWf.setAttribute('start', state.windowStart.toFixed(3));
    overviewWf.setAttribute('end', state.windowEnd.toFixed(3));

    // Detail waveform: start/end = clip selection, view-start/view-end = window
    detailWf.setAttribute('start', state.clipStart.toFixed(3));
    detailWf.setAttribute('end', state.clipEnd.toFixed(3));
    detailWf.setAttribute('view-start', state.windowStart.toFixed(3));
    detailWf.setAttribute('view-end', state.windowEnd.toFixed(3));

    // Rulers
    overviewRuler.setAttribute('window-start', '0');
    overviewRuler.setAttribute('window-end', state.videoDuration.toFixed(3));
    detailRuler.setAttribute('window-start', state.windowStart.toFixed(3));
    detailRuler.setAttribute('window-end', state.windowEnd.toFixed(3));
    detailRuler.setAttribute('time-origin', state.clipStart.toFixed(3));

    // Label auto-update
    updateLabel();

    // FFmpeg (current selection)
    ffmpegCmd.textContent = buildFfmpegCommand();

    // Deselect active clip if selection has moved away from it
    if (state.activeClipId !== null) {
        const ac = state.bookmarks.find(c => c.id === state.activeClipId);
        if (ac && (Math.abs(ac.start - state.clipStart) > 0.05 || Math.abs(ac.end - state.clipEnd) > 0.05)) {
            state.activeClipId = null;
            renderClipList();
        }
    }
}

// ---- Waveform peak generation ----

// Pick the cheapest path that can handle this file. Small/medium files
// decode in-memory via Web Audio (fast, no ffmpeg download). Large files —
// or anything the in-memory decode chokes on — stream through ffmpeg.wasm
// so the file is never fully resident in memory.
async function extractPeaks(file, onProgress) {
    if (file.size <= CONFIG.maxInMemoryDecodeBytes) {
        try {
            return await extractPeaksWebAudio(file, onProgress);
        } catch (err) {
            console.warn('In-memory waveform decode failed; falling back to ffmpeg:', err);
        }
    }
    return await extractPeaksViaFfmpeg(file, CONFIG.peaksPerSecond, state.videoDuration, onProgress);
}

// Client-side waveform generation via Web Audio API (in-memory).
async function extractPeaksWebAudio(file, onProgress) {
    const pps = CONFIG.peaksPerSecond;

    // Phase 1: Read file
    if (onProgress) onProgress(5, 'Reading file');
    const arrayBuffer = await file.arrayBuffer();

    // Phase 2: Decode audio — no granular progress from browser,
    // so tick up an estimate while we wait
    if (onProgress) onProgress(10, 'Decoding audio');
    let decodePct = 10;
    const decodeTimer = setInterval(() => {
        // Ease toward 85% asymptotically
        decodePct += (85 - decodePct) * 0.08;
        if (onProgress) onProgress(Math.round(decodePct), 'Decoding audio');
    }, 200);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let audioBuffer;
    try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } finally {
        // Always clear the progress ticker and release the context —
        // even if decode rejects (corrupt/unsupported audio), otherwise
        // the interval fires forever and the AudioContext leaks.
        clearInterval(decodeTimer);
        audioCtx.close();
    }

    const duration = audioBuffer.duration;
    const numPeaks = Math.ceil(duration * pps);
    const sampleRate = audioBuffer.sampleRate;
    const samplesPerPeak = Math.floor(sampleRate / pps);

    // Phase 3: compute peaks directly from the decoded channels.
    if (onProgress) onProgress(90, 'Generating waveform');
    const numChannels = audioBuffer.numberOfChannels;
    const totalSamples = audioBuffer.length;
    // Read channel data by reference (getChannelData doesn't copy) and fold
    // channels into each peak inline — avoids allocating a full-length mono
    // buffer, which for a long stereo file is hundreds of MB on top of the
    // already-decoded audio.
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));
    const invChannels = 1 / numChannels;

    const peaksArr = new Array(numPeaks);
    for (let p = 0; p < numPeaks; p++) {
        const start = p * samplesPerPeak;
        const end = Math.min(start + samplesPerPeak, totalSamples);
        let maxAbs = 0;
        for (let i = start; i < end; i++) {
            let sum = 0;
            for (let ch = 0; ch < numChannels; ch++) sum += channels[ch][i];
            const v = Math.abs(sum * invChannels);
            if (v > maxAbs) maxAbs = v;
        }
        peaksArr[p] = maxAbs;
    }

    if (onProgress) onProgress(100, 'Generating waveform');
    return peaksArr;
}

// ---- Load a file (from drop or browse) ----

async function loadFile(file) {
    if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
        alert('Please drop a video or audio file.');
        return;
    }

    // Raise the loading overlay BEFORE any other DOM mutation so the
    // user never sees the in-between layout (drop prompt vanishing,
    // sections reflowing, video resizing). All visible churn happens
    // behind the full-viewport overlay; the page only transitions
    // visibly twice — drop zone → loading → finished editor.
    showLoading();

    state.fileName = file.name;
    state.videoFile = file;
    fileNameEl.textContent = state.fileName;

    // Clean up previous blob
    if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = URL.createObjectURL(file);

    videoEl.style.display = 'block';
    videoEl.classList.add('hidden');
    videoArea.classList.add('has-video');

    videoEl.src = state.blobUrl;

    // Wait for video metadata
    await new Promise((resolve) => {
        videoEl.addEventListener('loadedmetadata', resolve, { once: true });
    });

    state.videoDuration = videoEl.duration;

    // Replace the 16:9 placeholder aspect with the video's real ratio so
    // the .video-area is correctly sized the moment the overlay clears.
    if (videoEl.videoWidth && videoEl.videoHeight) {
        videoArea.style.setProperty(
            '--video-aspect',
            `${videoEl.videoWidth} / ${videoEl.videoHeight}`
        );
    }

    // Detect fps via requestVideoFrameCallback
    state.videoFps = 30; // reset default
    if ('requestVideoFrameCallback' in videoEl) {
        try {
            const fps = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject('timeout'), 2000);
                let firstTime = null;
                const onFrame = (now, meta) => {
                    if (firstTime === null) {
                        firstTime = meta.mediaTime;
                        videoEl.requestVideoFrameCallback(onFrame);
                    } else {
                        clearTimeout(timeout);
                        const delta = meta.mediaTime - firstTime;
                        resolve(delta > 0 ? Math.round(1 / delta) : 30);
                    }
                };
                videoEl.requestVideoFrameCallback(onFrame);
                videoEl.muted = true;
                // The probe pauses on the 2nd frame, which rejects this
                // play() with AbortError — expected, so swallow it.
                videoEl.play().catch(() => {});
            });
            videoEl.pause();
            videoEl.currentTime = 0;
            videoEl.muted = false;
            state.videoFps = fps;
        } catch {
            videoEl.pause();
            videoEl.currentTime = 0;
            videoEl.muted = false;
        }
    }

    // Default clip: first N seconds or full video if shorter
    state.clipStart = 0;
    state.clipEnd = Math.min(CONFIG.defaultClipDuration, state.videoDuration);

    // Window: full video if short, otherwise the default 5-min window —
    // but never below 5% of the total, so the overview drag handles stay
    // grabbable on very long videos.
    if (state.videoDuration <= CONFIG.maxInitialWindow) {
        state.windowStart = 0;
        state.windowEnd = state.videoDuration;
    } else {
        state.windowStart = 0;
        state.windowEnd = Math.max(
            CONFIG.maxInitialWindow,
            state.videoDuration * CONFIG.minWindowFraction,
        );
    }

    // Reset clips for new file
    state.bookmarks = [];
    state.nextClipId = 1;
    state.activeClipId = null;
    state.labelLocked = false;
    labelLock.checked = false;
    labelInput.disabled = true;
    labelInput.value = '';

    // Show UI sections
    fileInfo.classList.add('visible');
    controlsRow.classList.add('visible');
    overviewSection.classList.add('visible');
    detailSection.classList.add('visible');
    ffmpegSection.classList.add('visible');
    sidebar.classList.add('visible');
    transcriptSection.classList.add('visible');
    state.transcriptSegments = [];
    state.activeTranscriptIndex = -1;
    state.resampledAudio = null;
    transcriptList.innerHTML = '';
    transcriptProgress.classList.remove('visible');
    transcribeBtn.classList.remove('active');
    transcribeBtn.textContent = 'Transcribe';
    updateTranscriptDefault();
    clipListSection.classList.add('visible');
    renderClipList();
    renderOverviewMarkers();

    // Initial sync (before peaks, so waveforms show placeholder)
    syncAll();

    // Extract peaks in background
    const wittyPhrase = pickPhrase();
    setLoadingProgress(0, wittyPhrase);
    try {
        state.peaks = await extractPeaks(file, (pct, phase) => {
            setLoadingProgress(pct, pct < 85 ? wittyPhrase : phase);
        });
        overviewWf.peaksData = state.peaks;
        detailWf.peaksData = state.peaks;
    } catch (err) {
        console.warn('Could not decode audio for waveform:', err);
    }

    // Reveal video, hide overlay
    videoEl.classList.remove('hidden');
    hideLoading();
    syncAll();
}

// ---- Clear ----

function clearVideo() {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.style.display = 'none';
    videoEl.classList.remove('hidden');
    hideLoading();
    videoArea.classList.remove('has-video');
    if (state.blobUrl) { URL.revokeObjectURL(state.blobUrl); state.blobUrl = null; }
    state.fileName = '';
    state.videoFile = null;
    state.peaks = null;
    state.bookmarks = [];
    state.nextClipId = 1;
    state.activeClipId = null;
    state.loopActive = false;
    loopBtn.classList.remove('active');
    loopBtn.textContent = 'Preview';
    fileInfo.classList.remove('visible');
    controlsRow.classList.remove('visible');
    overviewSection.classList.remove('visible');
    detailSection.classList.remove('visible');
    ffmpegSection.classList.remove('visible');
    sidebar.classList.remove('visible');
    transcriptSection.classList.remove('visible');
    if (state.transcriptWorker) { state.transcriptWorker.terminate(); state.transcriptWorker = null; }
    state.transcribing = false;
    state.transcriptSegments = [];
    state.activeTranscriptIndex = -1;
    state.resampledAudio = null;
    clipListSection.classList.remove('visible');
}

// ---- Loop toggle ----

function toggleLoop() {
    state.loopActive = !state.loopActive;
    loopBtn.classList.toggle('active', state.loopActive);
    loopBtn.textContent = state.loopActive ? 'Stop Preview' : 'Preview';
    if (state.loopActive) {
        videoEl.currentTime = state.clipStart;
        videoEl.play();
    }
}

// ---- Event wiring ----

// Drag and drop
videoArea.addEventListener('dragover', (e) => { e.preventDefault(); videoArea.classList.add('drag-over'); });
videoArea.addEventListener('dragleave', () => { videoArea.classList.remove('drag-over'); });
videoArea.addEventListener('drop', (e) => {
    e.preventDefault();
    videoArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
});

// Click to browse (only when no video loaded)
videoArea.addEventListener('click', (e) => {
    if (!videoArea.classList.contains('has-video') && e.target !== videoEl) {
        filePicker.click();
    }
});
filePicker.addEventListener('change', () => {
    if (filePicker.files[0]) loadFile(filePicker.files[0]);
});

// Clear button
clearBtn.addEventListener('click', clearVideo);

// Overview drag → update window
overviewWf.addEventListener('waveform-drag', (e) => {
    const { start, end } = e.detail;
    state.windowStart = Math.max(0, start);
    state.windowEnd = Math.min(state.videoDuration, end);
    if (state.windowEnd - state.windowStart < CONFIG.minWindow) {
        state.windowEnd = Math.min(state.videoDuration, state.windowStart + CONFIG.minWindow);
    }
    clampClipToWindow();
    syncAll();
});

// Detail drag → update clip
detailWf.addEventListener('waveform-drag', (e) => {
    const { start, end } = e.detail;
    state.clipStart = Math.max(0, start);
    state.clipEnd = Math.min(state.videoDuration, end);
    if (state.clipEnd - state.clipStart < CONFIG.minClip) state.clipEnd = Math.min(state.clipStart + CONFIG.minClip, state.videoDuration);
    syncAll();
});

// Detail click → seek video
detailWf.addEventListener('waveform-click', (e) => {
    videoEl.currentTime = e.detail.time;
    videoEl.play();
});

// Video timeupdate → update both playheads + enforce loop + transcript sync
videoEl.addEventListener('timeupdate', () => {
    const ct = videoEl.currentTime;
    overviewWf.setAttribute('current-time', ct.toFixed(3));
    detailWf.setAttribute('current-time', ct.toFixed(3));

    // Loop: when playhead passes clip end (or is before clip start), wrap back
    if (state.loopActive && !videoEl.paused) {
        if (ct >= state.clipEnd || ct < state.clipStart - 0.5) {
            videoEl.currentTime = state.clipStart;
        }
    }

    updateActiveTranscriptSegment();
});

// Overview click → seek video
overviewWf.addEventListener('waveform-click', (e) => {
    videoEl.currentTime = e.detail.time;
});

// Play button → jump to clip start
playBtn.addEventListener('click', () => {
    videoEl.currentTime = state.clipStart;
    videoEl.play();
});

// Timecode inputs
const commitStart = () => {
    const val = parseTimecode(startInput.value);
    if (val !== null && val >= 0 && val < state.clipEnd - 0.1) {
        state.clipStart = Math.max(0, val);
        syncAll();
    } else {
        startInput.value = formatTimecode(state.clipStart);
    }
};

const commitEnd = () => {
    const val = parseTimecode(endInput.value);
    if (val !== null && val > state.clipStart + 0.1 && val <= state.videoDuration) {
        state.clipEnd = Math.min(state.videoDuration, val);
        syncAll();
    } else {
        endInput.value = formatTimecode(state.clipEnd);
    }
};

startInput.addEventListener('change', commitStart);
endInput.addEventListener('change', commitEnd);
startInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startInput.blur(); });
endInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') endInput.blur(); });

// Copy button (current selection's ffmpeg command)
copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(ffmpegCmd.textContent).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, CONFIG.flashDuration);
    }).catch(() => {
        // clipboard API needs HTTPS/permission — select the command
        // text so the user can copy it manually.
        const range = document.createRange();
        range.selectNodeContents(ffmpegCmd);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
});

// Loop button
loopBtn.addEventListener('click', toggleLoop);

// Fire the source probe immediately and surface the result in the
// header pill. Probe is cached, so later ensureFFmpeg() /
// transcribe-worker init reuse the same result without a re-probe.
pickSources().then(s => renderSourceMode(sourceMode, s));

// Maximize toggle
maximizeBtn.addEventListener('click', () => appEl.classList.toggle('maximized'));

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (e) => {
    // Skip when focused on inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    // Let browser handle Ctrl/Cmd combos (Ctrl+F, Ctrl+C, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Skip if no video loaded
    if (!state.videoDuration) return;

    // Skip while a load is in progress — the overlay is up and shortcuts
    // could kick off ffmpeg/transcription mid-extraction.
    if (state.loading) return;

    // Keybind modes: 'none' blocks all, 'minimal' allows only space to play/pause
    if (layoutSettings.keybinds === 'none') return;
    if (layoutSettings.keybinds === 'minimal') {
        if (e.key === ' ' && !e.shiftKey) {
            e.preventDefault();
            if (videoEl.paused) videoEl.play(); else videoEl.pause();
        }
        return;
    }

    if (e.key === '?') {
        e.preventDefault();
        shortcutsPanel.classList.toggle('visible');
    } else if (e.key === ' ' && e.shiftKey) {
        // Shift+Space: play from clip start
        e.preventDefault();
        videoEl.currentTime = state.clipStart;
        videoEl.play();
    } else if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        if (videoEl.paused) {
            videoEl.play();
        } else {
            videoEl.pause();
        }
    } else if (e.key === 'l') {
        e.preventDefault();
        videoEl.currentTime = Math.min(videoEl.currentTime + 10, state.videoDuration);
    } else if (e.key === 'j') {
        e.preventDefault();
        videoEl.currentTime = Math.max(videoEl.currentTime - 10, 0);
    } else if (e.key === '.') {
        e.preventDefault();
        videoEl.pause();
        videoEl.currentTime = Math.min(videoEl.currentTime + 1 / state.videoFps, state.videoDuration);
    } else if (e.key === ',') {
        e.preventDefault();
        videoEl.pause();
        videoEl.currentTime = Math.max(videoEl.currentTime - 1 / state.videoFps, 0);
    } else if (e.key === 'm') {
        e.preventDefault();
        videoEl.muted = !videoEl.muted;
    } else if (e.key === 'p') {
        e.preventDefault();
        toggleLoop();
    } else if (e.key === 'f') {
        e.preventDefault();
        appEl.classList.toggle('maximized');
    } else if (e.key === 's') {
        e.preventDefault();
        bookmarkClip();
    } else if (e.key === 't') {
        e.preventDefault();
        startTranscription();
    } else if (e.key === 'x') {
        e.preventDefault();
        if (state.activeClipId !== null) deleteClip(state.activeClipId);
    }
});
