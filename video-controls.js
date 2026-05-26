// Custom video-controls bar — replaces the default HTML5 player chrome
// (videoEl.controls is off; see index.html). Drives the .video-controls
// bar inside .video-area, plus the brightness/dim overlay. The bar's
// z-index sits above .video-dim-overlay so controls stay operable when
// the video is dimmed. Self-contained: only reads state.videoDuration.

import { state } from './state.js';
import {
    videoEl, vcPlayBtn, vcTimeDisplay, vcScrubber, vcScrubberFill, vcMuteBtn, vcVolume,
    dimBtn, dimSlider, dimOverlay, appEl, videoArea,
} from './dom.js';

const VC_PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20"/></svg>';
const VC_PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="3.5" height="14"/><rect x="14.5" y="5" width="3.5" height="14"/></svg>';
const VC_VOLUME_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const VC_MUTED_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

function vcFormatTime(t) {
    if (!isFinite(t) || t < 0) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function updateVcTime() {
    const dur = state.videoDuration || 0;
    vcTimeDisplay.textContent = `${vcFormatTime(videoEl.currentTime)} / ${vcFormatTime(dur)}`;
    const pct = dur > 0 ? (videoEl.currentTime / dur) * 100 : 0;
    vcScrubberFill.style.width = pct + '%';
}

function updateVcPlayState() {
    vcPlayBtn.innerHTML = videoEl.paused ? VC_PLAY_ICON : VC_PAUSE_ICON;
    vcPlayBtn.setAttribute('aria-label', videoEl.paused ? 'Play' : 'Pause');
}

function updateVcMuteState() {
    const muted = videoEl.muted || videoEl.volume === 0;
    vcMuteBtn.innerHTML = muted ? VC_MUTED_ICON : VC_VOLUME_ICON;
    vcMuteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

// Paints the amber fill gradient on the volume slider's background.
// Mirrors how updateDimming paints the dim slider — the native slider
// track itself is left transparent (via the ::-webkit-slider-runnable-
// track and ::-moz-range-track rules) so the gradient on the input's
// background shows through cleanly.
function updateVcVolumeFill() {
    const pct = (videoEl.muted ? 0 : videoEl.volume) * 100;
    vcVolume.style.background = `linear-gradient(to right, var(--accent-glow) ${pct}%, rgba(255, 255, 255, 0.18) ${pct}%)`;
}

vcPlayBtn.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play(); else videoEl.pause();
});

videoEl.addEventListener('play', updateVcPlayState);
videoEl.addEventListener('pause', updateVcPlayState);
videoEl.addEventListener('timeupdate', updateVcTime);
videoEl.addEventListener('loadedmetadata', updateVcTime);
videoEl.addEventListener('durationchange', updateVcTime);
videoEl.addEventListener('volumechange', () => {
    vcVolume.value = videoEl.muted ? 0 : videoEl.volume;
    updateVcMuteState();
    updateVcVolumeFill();
});

// Click the video to toggle playback (matches native HTML5 behavior).
videoEl.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play(); else videoEl.pause();
});

// Scrubber — pointer-based so a single drag handler covers click and
// drag. setPointerCapture keeps events flowing if the cursor leaves
// the track mid-drag.
function seekFromPointer(e) {
    if (!state.videoDuration) return;
    const rect = vcScrubber.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    videoEl.currentTime = state.videoDuration * pct;
}

vcScrubber.addEventListener('pointerdown', (e) => {
    vcScrubber.setPointerCapture(e.pointerId);
    vcScrubber.classList.add('scrubbing');
    seekFromPointer(e);
});

vcScrubber.addEventListener('pointermove', (e) => {
    if (!vcScrubber.hasPointerCapture(e.pointerId)) return;
    seekFromPointer(e);
});

vcScrubber.addEventListener('pointerup', (e) => {
    vcScrubber.releasePointerCapture(e.pointerId);
    vcScrubber.classList.remove('scrubbing');
});

vcMuteBtn.addEventListener('click', () => {
    videoEl.muted = !videoEl.muted;
});

vcVolume.addEventListener('input', () => {
    const v = parseFloat(vcVolume.value);
    videoEl.volume = v;
    // Adjusting the slider away from 0 should always unmute; dragging
    // to 0 leaves audio at zero but doesn't toggle the muted flag.
    if (v > 0 && videoEl.muted) videoEl.muted = false;
});

updateVcPlayState();
updateVcMuteState();
updateVcVolumeFill();

// ---- Video dimming ----

let videoDimming = 0;

// videoDimming stays internal-facing as "amount of dim applied" (0 = no
// dim, 1 = fully dimmed). The slider, however, represents BRIGHTNESS:
// thumb at the right = full bright (no dim), thumb at the left = darkest
// (full dim). This matches the convention of every brightness control
// and means the slider "fills up" the brighter it gets.
function updateDimming(val) {
    videoDimming = Math.max(0, Math.min(1, val));
    dimOverlay.style.background = videoDimming > 0 ? `rgba(0, 0, 0, ${videoDimming})` : 'transparent';
    const brightness = 1 - videoDimming;
    dimSlider.value = brightness;
    dimBtn.classList.toggle('active', videoDimming > 0);
    // Slider fill: amber from min up to current brightness. More amber
    // = more brightness; less amber = the user has "turned it down."
    const pct = brightness * 100;
    dimSlider.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--screen-border) ${pct}%)`;
}

dimBtn.addEventListener('click', () => {
    // Toggle: if currently dimmed, restore to full bright; otherwise
    // pull the brightness down to 50%.
    updateDimming(videoDimming > 0 ? 0 : 0.5);
});

dimSlider.addEventListener('input', () => {
    // Slider value is brightness; convert back to dim amount.
    updateDimming(1 - parseFloat(dimSlider.value));
});

updateDimming(0);

// Track video area height for sidebar constraint
new ResizeObserver(entries => {
    const h = entries[0].contentRect.height;
    if (h > 0) appEl.style.setProperty('--video-height', h + 'px');
}).observe(videoArea);
