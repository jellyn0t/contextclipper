// Settings modal, theme picker, and cache warm-up. Reads and persists
// layoutSettings; applies width/theme to the document. The settings
// modal also surfaces the Whisper model cache state (via transcription.js)
// and the encode/transcribe quality knobs.

import { state, layoutSettings } from './state.js';
import { CONFIG } from './config.js';
import {
    appEl, shortcutsPanel, helpBtn,
    settingsBtn, settingsBackdrop, settingsApply, settingsCancel,
    settingNormalWidth, settingExpandedWidth,
    settingCopyCrf, settingCopyPreset, settingCopyAudioBitrate,
    settingWasmCrf, settingWasmPreset, settingWasmAudioBitrate,
    settingKeybinds, settingWhisperModel,
    warmupBtn, warmupStatus, warmupProgress, warmupProgressFill,
} from './dom.js';
import { warmUpCache } from './sources.js';
import { renderModelCacheInfo, updateTranscriptDefault } from './transcription.js';
import { syncAll } from './editor.js';

function applyTheme(theme) {
    // 'amber' is the default :root palette — drop the attribute so we
    // don't ship a redundant override for the default case.
    if (theme && theme !== 'amber') {
        document.documentElement.dataset.theme = theme;
    } else {
        delete document.documentElement.dataset.theme;
    }
    // Reflect selection in the picker swatches if the settings modal
    // has been rendered (this also runs at boot, before the user has
    // opened settings — the querySelectorAll is harmless when empty).
    document.querySelectorAll('.theme-swatch').forEach(sw => {
        sw.setAttribute('aria-checked', sw.dataset.theme === (theme || 'amber') ? 'true' : 'false');
    });
    // The waveform-editor caches its canvas fill colors after the first
    // read, so a live theme change won't reach the highlighted bars
    // until we invalidate. Both waveforms expose refreshColors() for
    // this purpose; guard for cases where the element isn't upgraded
    // yet (early boot before the custom-element JS module has run).
    document.querySelectorAll('waveform-editor').forEach(wf => {
        if (typeof wf.refreshColors === 'function') wf.refreshColors();
    });
}

export function applyLayoutSettings() {
    appEl.style.setProperty('--normal-width', layoutSettings.normalWidth + 'px');
    appEl.style.setProperty('--expanded-width', layoutSettings.expandedWidth + 'px');
    applyTheme(layoutSettings.theme);
}
applyLayoutSettings();

// Theme picker — swatch clicks apply the theme live and persist to
// localStorage so the next reload remembers it. No need to wait for
// the "Apply" button since the visual preview IS the feedback.
document.querySelectorAll('.theme-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
        const theme = sw.dataset.theme;
        layoutSettings.theme = theme;
        applyTheme(theme);
        try {
            localStorage.setItem(CONFIG.settingsKey, JSON.stringify(layoutSettings));
        } catch (e) { /* ignore */ }
    });
});

// Keyboard shortcuts help panel
helpBtn.addEventListener('click', () => {
    shortcutsPanel.classList.toggle('visible');
});

settingsBtn.addEventListener('click', () => {
    settingNormalWidth.value = layoutSettings.normalWidth;
    settingExpandedWidth.value = layoutSettings.expandedWidth;
    settingCopyCrf.value = layoutSettings.copyCrf;
    settingCopyPreset.value = layoutSettings.copyPreset;
    settingCopyAudioBitrate.value = layoutSettings.copyAudioBitrate;
    settingWasmCrf.value = layoutSettings.wasmCrf;
    settingWasmPreset.value = layoutSettings.wasmPreset;
    settingWasmAudioBitrate.value = layoutSettings.wasmAudioBitrate;
    settingKeybinds.value = layoutSettings.keybinds;
    settingWhisperModel.value = layoutSettings.whisperModel;
    renderModelCacheInfo();
    settingsBackdrop.classList.add('visible');
});

settingsCancel.addEventListener('click', () => settingsBackdrop.classList.remove('visible'));
settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsBackdrop) settingsBackdrop.classList.remove('visible');
});

// Cache warm-up. Fetches all CDN-served assets once so future
// ffmpeg/Whisper loads hit the browser HTTP cache instead of the
// network. No-op when everything's already LOCAL.
warmupBtn.addEventListener('click', async () => {
    warmupBtn.disabled = true;
    warmupStatus.textContent = 'Probing sources…';
    warmupProgress.hidden = false;
    warmupProgressFill.style.width = '0%';
    try {
        const result = await warmUpCache(
            settingWhisperModel.value || layoutSettings.whisperModel,
            (done, total, url) => {
                const pct = Math.round((done / total) * 100);
                warmupProgressFill.style.width = pct + '%';
                const short = url.replace(/^https?:\/\/[^/]+\//, '').replace(/.*\//, '');
                warmupStatus.textContent = `${done}/${total} — ${short}`;
            },
        );
        if (result.alreadyLocal) {
            warmupStatus.textContent =
                'All assets already local — nothing to warm up.';
        } else {
            const summary = result.failed
                ? `Done: ${result.fetched}/${result.total} cached, ${result.failed} failed.`
                : `Done: ${result.total} files cached. Next encode/transcribe will be instant.`;
            warmupStatus.textContent = summary;
        }
    } catch (err) {
        console.error('warmUpCache failed', err);
        warmupStatus.textContent = 'Failed: ' + err.message;
    } finally {
        warmupBtn.disabled = false;
        // Leave progress bar visible so the user sees the final
        // state. It clears next time the modal reopens.
    }
});

settingsApply.addEventListener('click', () => {
    layoutSettings.normalWidth = Math.max(400, parseInt(settingNormalWidth.value) || 1200);
    layoutSettings.expandedWidth = Math.max(400, parseInt(settingExpandedWidth.value) || 1800);
    layoutSettings.copyCrf = Math.max(0, Math.min(51, parseInt(settingCopyCrf.value) || 18));
    layoutSettings.copyPreset = settingCopyPreset.value;
    layoutSettings.copyAudioBitrate = settingCopyAudioBitrate.value;
    layoutSettings.wasmCrf = Math.max(0, Math.min(51, parseInt(settingWasmCrf.value) || 23));
    layoutSettings.wasmPreset = settingWasmPreset.value;
    layoutSettings.wasmAudioBitrate = settingWasmAudioBitrate.value;
    layoutSettings.keybinds = settingKeybinds.value;
    layoutSettings.whisperModel = settingWhisperModel.value;
    localStorage.setItem(CONFIG.settingsKey, JSON.stringify(layoutSettings));
    applyLayoutSettings();
    // Refresh the ffmpeg command display if active
    if (state.peaks) syncAll();
    updateTranscriptDefault();
    settingsBackdrop.classList.remove('visible');
});
