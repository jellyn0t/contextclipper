// All tuneable constants in one place. Leaf module — imports nothing.

export const CONFIG = {
    // Waveform constraints
    minWindow: 5,               // minimum overview window span (seconds)
    minClip: 0.1,               // minimum clip selection span (seconds)
    peaksPerSecond: 10,         // waveform resolution (peaks extracted per second)
    // Files larger than this skip the in-memory Web Audio decode (which must
    // allocate the whole file + its decoded PCM in RAM — multi-GB files fail
    // the ArrayBuffer allocation) and build the waveform by streaming through
    // ffmpeg.wasm instead. ~800 MB sits comfortably under browser limits.
    maxInMemoryDecodeBytes: 800 * 1024 * 1024,
    // Warn before transcribing videos longer than this — in-browser Whisper
    // is slow and memory-heavy on long inputs.
    transcriptWarnSeconds: 60 * 60,   // 60 minutes

    // Initial clip/window defaults
    defaultClipDuration: 30,    // initial clip end when loading a video (seconds)
    maxInitialWindow: 300,      // max overview window on load (5 min)
    // Floor for the initial overview window, as a fraction of total
    // duration. On long videos a fixed 5-min window is a tiny sliver of
    // the full-duration overview, leaving the drag handles too thin to
    // grab — keep the window at least this wide so they stay visible.
    minWindowFraction: 0.05,    // 5% of total duration

    // Clip list
    clipColors: [
        '#f472b6', '#a78bfa', '#60a5fa', '#34d399',
        '#fbbf24', '#fb923c', '#f87171', '#2dd4bf',
    ],

    // UI feedback durations (ms)
    flashDuration: 1500,        // "Copied" / "Bookmarked" button flash
    encodeHideDuration: 3000,   // how long to show "Done" before hiding progress
    loadingGameDelayMs: 10000,  // show the loading-screen brick-breaker after this long

    // Clip window padding (when jumping to a bookmarked clip)
    clipPaddingMin: 5,          // minimum padding around clip in window (seconds)
    clipPaddingRatio: 0.5,      // padding as fraction of clip span
    // Persisted settings
    settingsKey: 'clipEditorSettings',
    settingsDefaults: {
        theme: 'amber',
        normalWidth: 1200,
        expandedWidth: 1800,
        copyCrf: 18,
        copyPreset: 'fast',
        copyAudioBitrate: '192k',
        wasmCrf: 23,
        wasmPreset: 'ultrafast',
        wasmAudioBitrate: '192k',
        whisperModel: 'onnx-community/whisper-tiny.en',
        keybinds: 'all',
    },

    // Loading overlay phrases
    loadingPhrases: [
        'Reticulating splines',
        'Warming up the flux capacitor',
        'Convincing pixels to cooperate',
        'Summoning video demons',
        'Bribing the bandwidth gods',
        'Untangling the tubes',
        'Feeding the hamsters',
        'Calibrating the framebuffer',
        'Negotiating with codecs',
        'Polishing each frame by hand',
        'Teaching bits to dance',
        'Waking up the audio gnomes',
    ],
};
