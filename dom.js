// DOM element references, resolved once at module load. Loaded as a
// module (deferred), so the document is fully parsed by the time this
// runs and getElementById succeeds. Also holds escapeHtml — a generic
// DOM-backed helper kept here so every module can import it from a
// leaf without creating an import cycle.

export const videoArea = document.getElementById('videoArea');
export const videoEl = document.getElementById('videoEl');
export const filePicker = document.getElementById('filePicker');
export const urlInput = document.getElementById('urlInput');
export const urlLoadBtn = document.getElementById('urlLoadBtn');
export const loadingOverlay = document.getElementById('loadingOverlay');
export const fileInfo = document.getElementById('fileInfo');
export const fileNameEl = document.getElementById('fileName');
export const clearBtn = document.getElementById('clearBtn');
export const startInput = document.getElementById('startInput');
export const endInput = document.getElementById('endInput');
export const durationDisplay = document.getElementById('durationDisplay');
export const playBtn = document.getElementById('playBtn');
export const overviewSection = document.getElementById('overviewSection');
export const detailSection = document.getElementById('detailSection');
export const ffmpegSection = document.getElementById('ffmpegSection');
export const ffmpegCmd = document.getElementById('ffmpegCmd');
export const copyBtn = document.getElementById('copyBtn');
export const loopBtn = document.getElementById('loopBtn');
export const shortcutsPanel = document.getElementById('shortcutsPanel');
export const controlsRow = document.getElementById('controlsRow');
export const labelInput = document.getElementById('labelInput');
export const labelLock = document.getElementById('labelLock');
export const bookmarkBtn = document.getElementById('bookmarkBtn');
export const clipListSection = document.getElementById('clipListSection');
export const clipListLabel = document.getElementById('clipListLabel');
export const exportBtn = document.getElementById('exportBtn');
export const exportBackdrop = document.getElementById('exportBackdrop');
export const exportPreview = document.getElementById('exportPreview');
export const exportClose = document.getElementById('exportClose');
export const exportCopy = document.getElementById('exportCopy');
export const exportDownload = document.getElementById('exportDownload');
export const clipList = document.getElementById('clipList');
export const overviewMarkers = document.getElementById('overviewMarkers');
export const appEl = document.querySelector('.app');
export const maximizeBtn = document.getElementById('maximizeBtn');
export const dimBtn = document.getElementById('dimBtn');
export const dimSlider = document.getElementById('dimSlider');
export const dimOverlay = document.getElementById('dimOverlay');
export const settingsBtn = document.getElementById('settingsBtn');
export const settingsBackdrop = document.getElementById('settingsBackdrop');
export const settingNormalWidth = document.getElementById('settingNormalWidth');
export const settingExpandedWidth = document.getElementById('settingExpandedWidth');
export const settingsApply = document.getElementById('settingsApply');
export const settingsCancel = document.getElementById('settingsCancel');
export const warmupBtn = document.getElementById('warmupBtn');
export const warmupStatus = document.getElementById('warmupStatus');
export const warmupProgress = document.getElementById('warmupProgress');
export const warmupProgressFill = document.getElementById('warmupProgressFill');
export const settingCopyCrf = document.getElementById('settingCopyCrf');
export const settingCopyPreset = document.getElementById('settingCopyPreset');
export const settingCopyAudioBitrate = document.getElementById('settingCopyAudioBitrate');
export const settingWasmCrf = document.getElementById('settingWasmCrf');
export const settingWasmPreset = document.getElementById('settingWasmPreset');
export const settingWasmAudioBitrate = document.getElementById('settingWasmAudioBitrate');
export const encodeBtn = document.getElementById('encodeBtn');
export const encodeProgress = document.getElementById('encodeProgress');
export const encodeProgressFill = document.getElementById('encodeProgressFill');
export const encodeProgressText = document.getElementById('encodeProgressText');
export const progressBar = document.getElementById('progressBar');
export const progressFill = document.getElementById('progressFill');
export const loadingPhrase = document.getElementById('loadingPhrase');
export const loadingPct = document.getElementById('loadingPct');
export const overviewWf = document.getElementById('overviewWf');
export const detailWf = document.getElementById('detailWf');
export const overviewRuler = document.getElementById('overviewRuler');
export const detailRuler = document.getElementById('detailRuler');
export const sidebar = document.getElementById('sidebar');
export const transcriptSection = document.getElementById('transcriptSection');
export const transcribeBtn = document.getElementById('transcribeBtn');
export const transcriptProgress = document.getElementById('transcriptProgress');
export const transcriptProgressFill = document.getElementById('transcriptProgressFill');
export const transcriptProgressText = document.getElementById('transcriptProgressText');
export const transcriptList = document.getElementById('transcriptList');
export const settingKeybinds = document.getElementById('settingKeybinds');
export const settingWhisperModel = document.getElementById('settingWhisperModel');
export const modelCacheInfo = document.getElementById('modelCacheInfo');
export const sourceMode = document.getElementById('sourceMode');
export const helpBtn = document.getElementById('helpBtn');

// Custom video-controls bar
export const videoControls = document.getElementById('videoControls');
export const vcPlayBtn = document.getElementById('vcPlayBtn');
export const vcTimeDisplay = document.getElementById('vcTimeDisplay');
export const vcScrubber = document.getElementById('vcScrubber');
export const vcScrubberFill = document.getElementById('vcScrubberFill');
export const vcMuteBtn = document.getElementById('vcMuteBtn');
export const vcVolume = document.getElementById('vcVolume');

export function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}
