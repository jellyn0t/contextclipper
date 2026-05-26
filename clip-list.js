// Bookmarks ("clips"): create, render, navigate, delete, and export.
// Owns the clip list panel, the label input, and the bookmark-export
// modal (JSON / ffmpeg-script preview backed by the pure formatters in
// export.js).

import { state, layoutSettings } from './state.js';
import { CONFIG } from './config.js';
import {
    clipList, clipListLabel, exportBtn, overviewMarkers, labelInput, labelLock,
    bookmarkBtn, exportBackdrop, exportPreview, exportClose, exportCopy, exportDownload,
    escapeHtml,
} from './dom.js';
import { formatTimecode, formatFileSize } from './timecode.js';
import { encodeClip, downloadBlob } from './encoding.js';
import { syncAll } from './editor.js';
import { exportJson, exportFfmpegSh, exportFilename } from './export.js';

// ---- Auto-label ----

export function getAutoLabel() {
    const base = state.fileName.replace(/\.[^.]+$/, '') || 'Clip';
    return `${base} - ${formatTimecode(state.clipStart)}`;
}

export function updateLabel() {
    if (!state.labelLocked) {
        labelInput.value = getAutoLabel();
    }
}

export function clipColor(index) {
    return CONFIG.clipColors[index % CONFIG.clipColors.length];
}

// ---- FFmpeg command ----

export function buildFfmpegCommand(start, end, name) {
    start = start ?? state.clipStart;
    end = end ?? state.clipEnd;
    name = name ?? state.fileName;
    const ss = start.toFixed(3);
    const duration = (end - start).toFixed(3);
    const safeName = name.replace(/"/g, '\\"');
    const baseName = name.replace(/\.[^.]+$/, '');
    const output = `${baseName}_clip.mp4`;
    return `ffmpeg -ss ${ss} -i "${safeName}" -t ${duration} -c:v libx264 -crf ${layoutSettings.copyCrf} -preset ${layoutSettings.copyPreset} -c:a aac -b:a ${layoutSettings.copyAudioBitrate} -movflags +faststart "${output}"`;
}

// ---- Bookmark management ----

export function bookmarkClip() {
    const label = labelInput.value.trim() || getAutoLabel();
    state.bookmarks.push({
        id: state.nextClipId++,
        start: state.clipStart,
        end: state.clipEnd,
        label: label,
    });

    // Reset label to auto mode
    state.labelLocked = false;
    labelLock.checked = false;
    labelInput.disabled = true;
    labelInput.placeholder = 'Auto-generated label';
    state.activeClipId = null;

    // Flash bookmark button
    bookmarkBtn.textContent = 'Bookmarked!';
    bookmarkBtn.classList.add('bookmarked');
    setTimeout(() => { bookmarkBtn.textContent = 'Bookmark'; bookmarkBtn.classList.remove('bookmarked'); }, CONFIG.flashDuration);

    renderClipList();
    renderOverviewMarkers();
    updateLabel();
}

export function deleteClip(id) {
    state.bookmarks = state.bookmarks.filter(c => c.id !== id);
    if (state.activeClipId === id) state.activeClipId = null;
    renderClipList();
    renderOverviewMarkers();
}

export function loadClip(clip) {
    state.clipStart = clip.start;
    state.clipEnd = clip.end;
    state.activeClipId = clip.id;

    // Adjust window to contain clip
    const clipSpan = state.clipEnd - state.clipStart;
    const padding = Math.max(CONFIG.clipPaddingMin, clipSpan * CONFIG.clipPaddingRatio);
    state.windowStart = Math.max(0, state.clipStart - padding);
    state.windowEnd = Math.min(state.videoDuration, state.clipEnd + padding);
    if (state.windowEnd - state.windowStart < CONFIG.minWindow) {
        state.windowEnd = Math.min(state.videoDuration, state.windowStart + CONFIG.minWindow);
    }

    labelInput.value = clip.label;
    syncAll();
    renderClipList();
}

function copyClipCommand(clip, btnEl) {
    const cmd = buildFfmpegCommand(clip.start, clip.end);
    navigator.clipboard.writeText(cmd).then(() => {
        btnEl.textContent = 'Copied';
        btnEl.classList.add('copied-btn');
        setTimeout(() => { btnEl.textContent = 'Copy ffmpeg'; btnEl.classList.remove('copied-btn'); }, CONFIG.flashDuration);
    }).catch(() => {
        // clipboard API needs HTTPS/permission — surface the failure
        // instead of silently doing nothing.
        btnEl.textContent = 'Copy failed';
        setTimeout(() => { btnEl.textContent = 'Copy ffmpeg'; }, CONFIG.flashDuration);
    });
}

export function renderClipList() {
    // Export only makes sense when there's something to export.
    if (exportBtn) exportBtn.disabled = state.bookmarks.length === 0;

    if (state.bookmarks.length === 0) {
        clipList.innerHTML = '<div class="clip-list-empty">No bookmarks yet</div>';
        clipListLabel.textContent = 'Bookmarks';
        return;
    }

    clipListLabel.textContent = `Bookmarks (${state.bookmarks.length})`;
    clipList.innerHTML = state.bookmarks.map((clip, i) => {
        const dur = (clip.end - clip.start).toFixed(1);
        const isActive = clip.id === state.activeClipId;
        const sizeStr = clip.blob ? ` — ${formatFileSize(clip.blob.size)}` : '';
        const isEncoding = state.encodingClipId === clip.id;
        return `<div class="clip-item${isActive ? ' active' : ''}" data-clip-id="${clip.id}">
            <span class="clip-dot" style="background:${clipColor(i)}"></span>
            <div class="clip-item-info">
                <span class="clip-item-label">${escapeHtml(clip.label)}</span>
                <span class="clip-item-meta">${formatTimecode(clip.start)} - ${formatTimecode(clip.end)} (${dur}s)${sizeStr}</span>
                ${isEncoding ? `<div class="clip-encode-progress"><div class="clip-encode-bar"><div class="clip-encode-fill" id="clipEncodeFill"></div></div><span class="clip-encode-text" id="clipEncodeText">Preparing...</span></div>` : ''}
            </div>
            <div class="clip-item-actions">
                ${isEncoding
                    ? ''
                    : clip.blob
                        ? `<button class="clip-item-btn download-clip-btn" data-clip-id="${clip.id}">Download</button><button class="clip-item-btn clear-encode-btn" data-clip-id="${clip.id}" title="Remove encoded file">Clear</button>`
                        : `<button class="clip-item-btn encode-btn encode-clip-btn" data-clip-id="${clip.id}">Encode</button>`
                }
                ${isEncoding ? '' : `<button class="clip-item-btn copy-clip-btn" data-clip-id="${clip.id}">Copy ffmpeg</button>`}
                <button class="clip-item-btn delete-btn" data-clip-id="${clip.id}" title="Delete clip">&times;</button>
            </div>
        </div>`;
    }).join('');

    // Bind click handlers
    clipList.querySelectorAll('.clip-item').forEach(el => {
        el.addEventListener('click', (e) => {
            // Don't navigate if clicking action buttons
            if (e.target.closest('.clip-item-actions')) return;
            const clip = state.bookmarks.find(c => c.id === parseInt(el.dataset.clipId));
            if (clip) loadClip(clip);
        });
    });

    clipList.querySelectorAll('.copy-clip-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const clip = state.bookmarks.find(c => c.id === parseInt(btn.dataset.clipId));
            if (clip) copyClipCommand(clip, btn);
        });
    });

    clipList.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteClip(parseInt(btn.dataset.clipId));
        });
    });

    clipList.querySelectorAll('.encode-clip-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const clip = state.bookmarks.find(c => c.id === parseInt(btn.dataset.clipId));
            if (clip) encodeClip(clip.start, clip.end, clip.label, clip.id);
        });
    });

    clipList.querySelectorAll('.download-clip-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const clip = state.bookmarks.find(c => c.id === parseInt(btn.dataset.clipId));
            if (clip && clip.blob) {
                const name = (clip.label || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_') + '.mp4';
                downloadBlob(clip.blob, name);
            }
        });
    });

    clipList.querySelectorAll('.clear-encode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const clip = state.bookmarks.find(c => c.id === parseInt(btn.dataset.clipId));
            if (clip) {
                delete clip.blob;
                delete clip.outputName;
                renderClipList();
            }
        });
    });
}

export function renderOverviewMarkers() {
    if (!state.videoDuration) { overviewMarkers.innerHTML = ''; return; }
    overviewMarkers.innerHTML = state.bookmarks.map((clip, i) => {
        const leftPct = (clip.start / state.videoDuration) * 100;
        return `<div class="clip-marker" style="left:${leftPct}%;background:${clipColor(i)}" title="${escapeHtml(clip.label)}"></div>`;
    }).join('');
}

// ---- Clip-export UI glue ----
// Pure formatters live in export.js; these UI helpers stay here
// because they read DOM state (radio buttons, textarea) and
// mutate visibility on the modal.

function currentExportFormat() {
    const checked = document.querySelector('input[name="exportFmt"]:checked');
    return checked ? checked.value : 'json';
}

function renderExportPreview() {
    const fmt = currentExportFormat();
    exportPreview.value = fmt === 'json'
        ? exportJson(state.bookmarks, state.fileName)
        : exportFfmpegSh(state.bookmarks, state.fileName, formatTimecode);
}

function openExport() {
    if (state.bookmarks.length === 0) return;
    renderExportPreview();
    exportBackdrop.classList.add('visible');
}

function closeExport() {
    exportBackdrop.classList.remove('visible');
}

// ---- Event wiring ----

// Bookmark export: button in clip-list header → modal with
// JSON / ffmpeg script preview, plus Copy / Download buttons.
exportBtn.addEventListener('click', openExport);
exportClose.addEventListener('click', closeExport);
exportBackdrop.addEventListener('click', (e) => {
    if (e.target === exportBackdrop) closeExport();
});
document.querySelectorAll('input[name="exportFmt"]').forEach(r => {
    r.addEventListener('change', renderExportPreview);
});
exportCopy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(exportPreview.value);
        const prev = exportCopy.textContent;
        exportCopy.textContent = 'Copied';
        setTimeout(() => { exportCopy.textContent = prev; }, CONFIG.flashDuration);
    } catch (err) {
        // navigator.clipboard requires HTTPS or localhost; fall
        // back to selecting the text so the user can Ctrl+C.
        exportPreview.focus();
        exportPreview.select();
    }
});
exportDownload.addEventListener('click', () => {
    const fmt = currentExportFormat();
    const blob = new Blob([exportPreview.value], {
        type: fmt === 'json' ? 'application/json' : 'text/x-shellscript',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(state.fileName, currentExportFormat());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
});

// Bookmark button + Enter in label input
bookmarkBtn.addEventListener('click', bookmarkClip);
labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); bookmarkClip(); }
    if (e.key === 'Escape') { labelInput.blur(); }
});

// Label lock checkbox
labelLock.addEventListener('change', () => {
    state.labelLocked = labelLock.checked;
    labelInput.disabled = !state.labelLocked;
    if (state.labelLocked) {
        labelInput.placeholder = 'Clip name...';
        labelInput.focus();
    } else {
        labelInput.placeholder = 'Auto-generated label';
        labelInput.value = getAutoLabel();
    }
});
