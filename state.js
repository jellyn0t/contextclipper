// Shared mutable editor state. Every module reads and writes through
// these two exported objects rather than module-level `let` bindings,
// because an imported ESM binding is live but read-only — a sibling
// module can read `state.clipStart` and see updates, but cannot
// reassign it. Mutating object properties sidesteps that limitation.

import { CONFIG } from './config.js';

export const state = {
    // Selection + window (seconds)
    clipStart: 0,
    clipEnd: 10,
    windowStart: 0,
    windowEnd: 30,

    // Loaded video
    videoDuration: 0,
    videoFps: 30,            // detected from video, fallback 30
    peaks: null,
    fileName: '',
    videoFile: null,         // raw File object for ffmpeg.wasm
    blobUrl: null,

    // Playback
    loopActive: false,

    // A file load is in progress (loading overlay up). Gates keyboard
    // shortcuts so they can't trigger ffmpeg/transcription mid-extraction.
    loading: false,

    // ffmpeg.wasm
    ffmpegInstance: null,
    ffmpegLoading: false,
    encoding: false,
    encodingClipId: null,
    encodingClipDuration: 0,

    // Bookmarks (clips)
    bookmarks: [],           // { id, start, end, label }
    nextClipId: 1,
    activeClipId: null,      // currently selected clip in list
    labelLocked: false,

    // Transcription
    transcriptSegments: [],
    transcriptWorker: null,
    transcribing: false,
    activeTranscriptIndex: -1,
    resampledAudio: null,
};

// Persisted user preferences. Mutated in place by settings.js; loaded
// from localStorage at import so any module reading it gets the saved
// values, not just defaults.
export const layoutSettings = { ...CONFIG.settingsDefaults };
try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.settingsKey));
    if (saved) Object.assign(layoutSettings, saved);
} catch (e) { /* ignore malformed persisted settings */ }
