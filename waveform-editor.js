// Two custom elements used by the clip editor:
//   <waveform-editor>  — interactive waveform with drag-to-select clip
//                        boundaries, view window, playhead, gap markers.
//   <time-ruler>       — labelled tick ruler that aligns to the editor.
//
// Both register on first import via customElements.define(). Idempotent
// guards mean a re-import (e.g. dev HMR) doesn't throw.

class WaveformEditor extends HTMLElement {
    static get observedAttributes() {
        return ['start', 'end', 'view-start', 'view-end', 'current-time', 'sample-rate', 'peak-offset', 'waveform-version'];
    }

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._peaks = [];
        this._duration = 0;
        this._sampleRate = 0;
        this._peakOffset = 0;
        this._lastPeaksRaw = null;
        this._peaksDataRef = null;
        this._start = 0;
        this._end = 10;
        this._viewStart = null;
        this._viewEnd = null;
        this._currentTime = null;
        this._isDragging = false;
        this._dragTarget = null;
        this._dragStartX = 0;
        this._dragStartValues = {};
        this._dragOverrides = {};
        this._gaps = [];
        this._canvas = null;
        this._ctx = null;
        this._rafId = null;
        this._elRegion = null;
        this._elHandleLeft = null;
        this._elHandleRight = null;
        this._elPlayhead = null;
        this._colors = null;
        this._gapsDirty = true;
        this._cachedViewPeaks = null;
        this._cachedViewKey = null;
        this._needsFullDraw = true;
        this._needsOverlayUpdate = true;
    }

    set peaksData(value) {
        if (value === this._peaksDataRef) return;
        this._peaksDataRef = value;
        if (Array.isArray(value) && value.length > 0) {
            this._peaks = value;
            this._sampleRate = parseInt(this.getAttribute('sample-rate')) || 10;
            this._peakOffset = parseFloat(this.getAttribute('peak-offset')) || 0;
            this._duration = this._peaks.length / this._sampleRate;
            this._cachedViewKey = null;
            this._needsFullDraw = true;
            this._needsOverlayUpdate = true;
            this.scheduleDraw();
        }
    }

    _getVal(prop) {
        if (prop in this._dragOverrides) return this._dragOverrides[prop];
        return this['_' + prop];
    }

    _getViewRange() {
        const viewStart = this._getVal('viewStart') ?? 0;
        const viewEnd = this._getVal('viewEnd') ?? this._duration ?? 0;
        return { viewStart, viewEnd };
    }

    _readColors() {
        if (this._colors) return;
        const s = getComputedStyle(this);
        this._colors = {
            bg: s.getPropertyValue('--wf-bg').trim() || '#121212',
            bar: s.getPropertyValue('--wf-bar').trim() || '#404040',
            barClip: s.getPropertyValue('--wf-bar-clip').trim() || '#eab308',
            placeholder: s.getPropertyValue('--wf-placeholder').trim() || '#333',
            gap: s.getPropertyValue('--wf-gap').trim() || 'rgba(239, 68, 68, 0.7)',
            gapFill: s.getPropertyValue('--wf-gap-fill').trim() || 'rgba(239, 68, 68, 0.8)',
        };
    }

    // Drop the color cache and force a full redraw. Called from the
    // theme picker so live theme switches repaint the canvas with the
    // new accent — the CSS custom properties get re-resolved via
    // getComputedStyle on next draw.
    refreshColors() {
        this._colors = null;
        this._needsFullDraw = true;
        this.draw();
    }

    _readChildren() {
        if (!this._peaksDataRef) {
            const peaksEl = this.querySelector('waveform-peaks');
            if (peaksEl) {
                const raw = peaksEl.getAttribute('data');
                if (raw !== this._lastPeaksRaw) {
                    this._lastPeaksRaw = raw;
                    try { this._peaks = JSON.parse(raw); } catch (e) { this._peaks = []; }
                    this._sampleRate = parseInt(peaksEl.getAttribute('sample-rate')) || 10;
                    this._duration = this._peaks.length / this._sampleRate;
                    this._peakOffset = parseFloat(peaksEl.getAttribute('offset')) || 0;
                    this._cachedViewKey = null;
                    this._needsFullDraw = true;
                    this._needsOverlayUpdate = true;
                }
            }
        }
        if (this._gapsDirty) {
            this._gaps = Array.from(this.querySelectorAll('waveform-gap')).map(el => ({
                start: parseFloat(el.getAttribute('start')) || 0,
                end: parseFloat(el.getAttribute('end')) || 0,
            }));
            this._gapsDirty = false;
            this._needsFullDraw = true;
        }
    }

    connectedCallback() {
        this._start = parseFloat(this.getAttribute('start')) || 0;
        this._end = parseFloat(this.getAttribute('end')) || 10;
        const vs = this.getAttribute('view-start');
        const ve = this.getAttribute('view-end');
        this._viewStart = vs !== null ? parseFloat(vs) : null;
        this._viewEnd = ve !== null ? parseFloat(ve) : null;
        const ct = this.getAttribute('current-time');
        this._currentTime = ct !== null ? parseFloat(ct) : null;
        this.render();
        this.setupEventListeners();
        this._childObserver = new MutationObserver(() => {
            this._gapsDirty = true;
            this._needsFullDraw = true;
            this.scheduleDraw();
        });
        this._childObserver.observe(this, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['data', 'sample-rate', 'offset', 'start', 'end'],
        });
        this.draw();
    }

    disconnectedCallback() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        if (this._childObserver) this._childObserver.disconnect();
        if (this._resizeObserver) this._resizeObserver.disconnect();
        document.removeEventListener('pointermove', this._onMouseMove);
        document.removeEventListener('pointerup', this._onMouseUp);
        document.removeEventListener('pointercancel', this._onMouseUp);
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;
        if (this._isDragging && (name === 'start' || name === 'end')) {
            const newVal = parseFloat(newValue) || 0;
            const oldVal = parseFloat(oldValue) || 0;
            const delta = newVal - oldVal;
            const override = this._dragOverrides[name];
            if (override !== undefined && Math.abs(newVal - override) > 0.5) {
                this._dragStartValues[name] += delta;
                this._dragOverrides[name] += delta;
            } else if (override === undefined) {
                this._dragStartValues[name] += delta;
            }
        }
        switch (name) {
            case 'start':
                this._start = parseFloat(newValue) || 0;
                this._needsFullDraw = true;
                this._needsOverlayUpdate = true;
                break;
            case 'end':
                this._end = parseFloat(newValue) || 10;
                this._needsFullDraw = true;
                this._needsOverlayUpdate = true;
                break;
            case 'view-start': {
                const v = newValue !== null ? parseFloat(newValue) : null;
                if (v !== this._viewStart) {
                    this._viewStart = v;
                    this._needsFullDraw = true;
                    this._needsOverlayUpdate = true;
                    this._cachedViewKey = null;
                }
                break;
            }
            case 'view-end': {
                const v = newValue !== null ? parseFloat(newValue) : null;
                if (v !== this._viewEnd) {
                    this._viewEnd = v;
                    this._needsFullDraw = true;
                    this._needsOverlayUpdate = true;
                    this._cachedViewKey = null;
                }
                break;
            }
            case 'sample-rate':
                this._sampleRate = parseInt(newValue) || 10;
                if (this._peaks.length > 0) {
                    this._duration = this._peaks.length / this._sampleRate;
                    this._needsFullDraw = true;
                }
                break;
            case 'peak-offset':
                this._peakOffset = parseFloat(newValue) || 0;
                break;
            case 'current-time':
                this._currentTime = newValue !== null ? parseFloat(newValue) : null;
                this._needsOverlayUpdate = true;
                break;
            case 'waveform-version':
                break;
        }
        this.scheduleDraw();
    }

    render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block; width: 100%; height: 100%; position: relative;
                    user-select: none; overflow: visible; touch-action: none;
                    --wf-bg: #121212; --wf-bar: #404040; --wf-bar-clip: #eab308;
                    --wf-placeholder: #333;
                    --wf-gap: rgba(239, 68, 68, 0.7); --wf-gap-fill: rgba(239, 68, 68, 0.8);
                    --wf-handle: rgba(255,255,255,0.4); --wf-handle-active: rgba(255,255,255,0.7);
                    --wf-region-border: rgba(255,255,255,0.3); --wf-region-bg: rgba(255,255,255,0.03);
                    --wf-region-hover-bg: rgba(255,255,255,0.06); --wf-region-hover-border: rgba(255,255,255,0.5);
                    --wf-playhead: #fff;
                    background: var(--wf-bg);
                }
                canvas { width: 100%; height: 100%; display: block; }
                .overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; overflow: visible; }
                .handle {
                    position: absolute; top: 0; width: 12px; height: 100%;
                    cursor: ew-resize; pointer-events: auto; z-index: 20; margin-left: -6px;
                    touch-action: none;
                }
                .handle::before {
                    content: ''; position: absolute; top: 0; left: 50%; transform: translateX(-50%);
                    width: 4px; height: 100%; background: var(--wf-handle); transition: background 0.1s, width 0.1s;
                }
                .handle:hover::before, .handle:active::before, .handle.active::before { background: var(--wf-handle-active); width: 5px; }
                @media (pointer: coarse) { .handle { width: 20px; margin-left: -10px; } }
                .region {
                    position: absolute; top: 0; height: 100%; cursor: grab; pointer-events: auto;
                    z-index: 5; box-sizing: border-box; transition: background 0.1s;
                    border-top: 1px solid var(--wf-region-border); border-bottom: 1px solid var(--wf-region-border);
                    background: var(--wf-region-bg); touch-action: none;
                }
                .region:hover, .region:active { background: var(--wf-region-hover-bg); border-color: var(--wf-region-hover-border); }
                .region:active { cursor: grabbing; }
                .playhead {
                    position: absolute; top: 5%; width: 1px; height: 90%; background: var(--wf-playhead);
                    pointer-events: none; z-index: 15; display: none;
                }
            </style>
            <canvas></canvas>
            <div class="overlay">
                <div class="region selection" data-drag="region"></div>
                <div class="handle left" data-drag="start"></div>
                <div class="handle right" data-drag="end"></div>
                <div class="playhead"></div>
            </div>`;
        this._canvas = this.shadowRoot.querySelector('canvas');
        this._ctx = this._canvas.getContext('2d');
        this._elRegion = this.shadowRoot.querySelector('.region.selection');
        this._elHandleLeft = this.shadowRoot.querySelector('.handle.left');
        this._elHandleRight = this.shadowRoot.querySelector('.handle.right');
        this._elPlayhead = this.shadowRoot.querySelector('.playhead');
        this.resizeCanvas();
    }

    resizeCanvas() {
        if (!this._canvas) return;
        const rect = this.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this._canvas.width = rect.width * dpr;
        this._canvas.height = rect.height * dpr;
        this._ctx.scale(dpr, dpr);
        this._canvasWidth = rect.width;
        this._canvasHeight = rect.height;
    }

    setupEventListeners() {
        this.shadowRoot.addEventListener('pointerdown', (e) => {
            const target = e.target.closest('[data-drag]');
            if (target) { e.preventDefault(); this.startDrag(target.dataset.drag, e.clientX); }
        });
        let clickStartX = 0;
        this.shadowRoot.addEventListener('pointerdown', (e) => {
            if (e.target === this._canvas || e.target.closest('.overlay')) clickStartX = e.clientX;
        });
        this.shadowRoot.addEventListener('click', (e) => {
            if (e.target !== this._canvas && !e.target.closest('.overlay')) return;
            if (Math.abs(e.clientX - clickStartX) > 3) return;
            const rect = this._canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, x / rect.width));
            const { viewStart, viewEnd } = this._getViewRange();
            const time = viewStart + ratio * (viewEnd - viewStart);
            this.dispatchEvent(new CustomEvent('waveform-click', { detail: { time }, bubbles: false }));
        });
        this._onMouseMove = this.onMouseMove.bind(this);
        this._onMouseUp = this.onMouseUp.bind(this);
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                this.resizeCanvas();
                this._needsFullDraw = true;
                this._needsOverlayUpdate = true;
                // Coalesce resize bursts through the RAF scheduler rather
                // than repainting synchronously on every callback.
                this.scheduleDraw();
            });
            this._resizeObserver.observe(this);
        }
    }

    startDrag(target, clientX) {
        this._isDragging = true;
        this._dragTarget = target;
        this._dragStartX = clientX;
        this._dragOverrides = {};
        this._dragStartValues = { start: this._start, end: this._end };
        const handle = this.shadowRoot.querySelector(`[data-drag="${target}"]`);
        if (handle) handle.classList.add('active');
        document.body.style.cursor = target === 'region' ? 'grabbing' : 'ew-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('pointermove', this._onMouseMove);
        document.addEventListener('pointerup', this._onMouseUp);
        document.addEventListener('pointercancel', this._onMouseUp);
    }

    onMouseMove(e) {
        if (!this._isDragging) return;
        const rect = this._canvas.getBoundingClientRect();
        this.handleDrag(e.clientX - this._dragStartX, rect.width);
        this._needsFullDraw = true;
        this._needsOverlayUpdate = true;
        this.scheduleDraw();
        this.dispatchDragEvent();
    }

    handleDrag(deltaX, width) {
        const { viewStart, viewEnd } = this._getViewRange();
        const viewDuration = viewEnd - viewStart;
        if (viewDuration <= 0) return;
        const timePerPx = viewDuration / width;
        const timeDelta = deltaX * timePerPx;
        const minSelection = 0.1;
        switch (this._dragTarget) {
            case 'start': {
                let newStart = this._dragStartValues.start + timeDelta;
                const end = this._dragOverrides.end ?? this._end;
                newStart = Math.max(viewStart, Math.min(newStart, end - minSelection));
                this._dragOverrides.start = newStart;
                break;
            }
            case 'end': {
                let newEnd = this._dragStartValues.end + timeDelta;
                const start = this._dragOverrides.start ?? this._start;
                newEnd = Math.min(viewEnd, Math.max(newEnd, start + minSelection));
                this._dragOverrides.end = newEnd;
                break;
            }
            case 'region': {
                const span = this._dragStartValues.end - this._dragStartValues.start;
                let newStart = this._dragStartValues.start + timeDelta;
                let newEnd = this._dragStartValues.end + timeDelta;
                if (newStart < viewStart) { newStart = viewStart; newEnd = viewStart + span; }
                if (newEnd > viewEnd) { newEnd = viewEnd; newStart = viewEnd - span; }
                this._dragOverrides.start = newStart;
                this._dragOverrides.end = newEnd;
                break;
            }
        }
    }

    onMouseUp(e) {
        if (!this._isDragging) return;
        const didDrag = Math.abs(e.clientX - this._dragStartX) > 3;
        const handle = this.shadowRoot.querySelector(`[data-drag="${this._dragTarget}"]`);
        if (handle) handle.classList.remove('active');
        this._isDragging = false;
        this._dragTarget = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('pointermove', this._onMouseMove);
        document.removeEventListener('pointerup', this._onMouseUp);
        document.removeEventListener('pointercancel', this._onMouseUp);
        if (!didDrag) { this._dragOverrides = {}; return; }
        this.dispatchDragEvent();
        this._dragOverrides = {};
        this._needsFullDraw = true;
        this._needsOverlayUpdate = true;
        this.scheduleDraw();
    }

    dispatchDragEvent() {
        this.dispatchEvent(new CustomEvent('waveform-drag', {
            detail: { start: this._getVal('start'), end: this._getVal('end'), isDragging: this._isDragging },
            bubbles: false
        }));
    }

    scheduleDraw() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => { this._rafId = null; this.draw(); });
    }

    draw() {
        if (!this._ctx || !this._canvas) return;
        this._readColors();
        if (this._needsFullDraw) {
            this._readChildren();
            const width = this._canvasWidth || this.getBoundingClientRect().width;
            const height = this._canvasHeight || this.getBoundingClientRect().height;
            this._ctx.fillStyle = this._colors.bg;
            this._ctx.fillRect(0, 0, width, height);
            this.drawWaveform(width, height);
            this._needsFullDraw = false;
        }
        if (this._needsOverlayUpdate) {
            this.updateOverlayPositions();
            this._needsOverlayUpdate = false;
        }
    }

    drawWaveform(width, height) {
        if (this._peaks.length === 0 || this._duration === 0) { this.drawPlaceholder(width, height); return; }
        const start = this._getVal('start');
        const end = this._getVal('end');
        const { viewStart, viewEnd } = this._getViewRange();
        const viewDuration = viewEnd - viewStart;
        if (viewDuration <= 0) return;
        const peaksPerSec = this._sampleRate || (this._peaks.length / this._duration);
        const startIdx = Math.max(0, Math.floor(viewStart * peaksPerSec));
        const endIdx = Math.min(this._peaks.length, Math.ceil(viewEnd * peaksPerSec));
        const viewKey = `${startIdx}:${endIdx}`;
        let viewPeaks;
        if (this._cachedViewKey === viewKey) { viewPeaks = this._cachedViewPeaks; }
        else { viewPeaks = this._peaks.slice(startIdx, endIdx); this._cachedViewPeaks = viewPeaks; this._cachedViewKey = viewKey; }
        if (viewPeaks.length === 0) return;
        const barWidth = 2, barGap = 1, step = barWidth + barGap;
        const numBars = Math.floor(width / step);
        const peaksPerBar = viewPeaks.length / numBars;
        const centerY = height / 2, hScale = height - 8;
        const { bar, barClip } = this._colors;
        const selStartBar = ((start - viewStart) / viewDuration) * numBars;
        const selEndBar = ((end - viewStart) / viewDuration) * numBars;
        this._ctx.fillStyle = bar;
        for (let i = 0; i < numBars; i++) {
            if (i >= selStartBar && i <= selEndBar) continue;
            const si = Math.floor(i * peaksPerBar), ei = Math.floor((i + 1) * peaksPerBar);
            let maxPeak = 0;
            for (let j = si; j < ei && j < viewPeaks.length; j++) { if (viewPeaks[j] > maxPeak) maxPeak = viewPeaks[j]; }
            const barH = Math.max(2, maxPeak * hScale);
            this._ctx.fillRect(i * step, centerY - barH / 2, barWidth, barH);
        }
        this._ctx.fillStyle = barClip;
        for (let i = Math.max(0, Math.floor(selStartBar)); i <= Math.min(numBars - 1, Math.ceil(selEndBar)); i++) {
            const si = Math.floor(i * peaksPerBar), ei = Math.floor((i + 1) * peaksPerBar);
            let maxPeak = 0;
            for (let j = si; j < ei && j < viewPeaks.length; j++) { if (viewPeaks[j] > maxPeak) maxPeak = viewPeaks[j]; }
            const barH = Math.max(2, maxPeak * hScale);
            this._ctx.fillRect(i * step, centerY - barH / 2, barWidth, barH);
        }
    }

    drawPlaceholder(width, height) {
        this._ctx.fillStyle = this._colors.placeholder;
        const barCount = 50, barWidth = width / barCount - 2;
        for (let i = 0; i < barCount; i++) {
            const barH = 4 + Math.random() * 8;
            this._ctx.fillRect(i * (barWidth + 2), (height - barH) / 2, barWidth, barH);
        }
    }

    updateOverlayPositions() {
        const { viewStart, viewEnd } = this._getViewRange();
        const viewDuration = viewEnd - viewStart;
        if (viewDuration <= 0) return;
        const start = this._getVal('start'), end = this._getVal('end');
        const selLeft = ((start - viewStart) / viewDuration) * 100;
        const selWidth = ((end - start) / viewDuration) * 100;
        if (this._elRegion) {
            this._elRegion.style.left = `${Math.max(0, selLeft)}%`;
            this._elRegion.style.width = `${Math.min(100 - Math.max(0, selLeft), selWidth)}%`;
        }
        if (this._elHandleLeft) this._elHandleLeft.style.left = `${Math.max(0, selLeft)}%`;
        if (this._elHandleRight) this._elHandleRight.style.left = `${Math.min(100, selLeft + selWidth)}%`;
        if (this._elPlayhead) {
            if (this._currentTime !== null) {
                const playheadPos = ((this._currentTime - viewStart) / viewDuration) * 100;
                if (playheadPos >= 0 && playheadPos <= 100) {
                    this._elPlayhead.style.display = 'block';
                    this._elPlayhead.style.left = `${playheadPos}%`;
                } else {
                    this._elPlayhead.style.display = 'none';
                }
            } else {
                this._elPlayhead.style.display = 'none';
            }
        }
    }
}

if (!customElements.get('waveform-editor')) customElements.define('waveform-editor', WaveformEditor);


// ============================================================
// Time Ruler Custom Element (inlined from waveform.js)
// ============================================================
class TimeRuler extends HTMLElement {
    static get observedAttributes() { return ['window-start', 'window-end', 'time-origin']; }

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._windowStart = 0;
        this._windowEnd = 10;
        this._canvas = null;
        this._ctx = null;
        this._rafId = null;
        this._color = null;
        this._timeOrigin = null;
        this._needsDraw = true;
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <style>
                :host { display: block; height: 20px; position: relative; --tr-color: #606878; }
                canvas { width: 100%; height: 100%; display: block; }
            </style>
            <canvas></canvas>`;
        this._canvas = this.shadowRoot.querySelector('canvas');
        this._ctx = this._canvas.getContext('2d');
        this._resizeCanvas();
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => { this._resizeCanvas(); this._needsDraw = true; this._scheduleDraw(); });
            this._resizeObserver.observe(this);
        }
        const ws = this.getAttribute('window-start');
        const we = this.getAttribute('window-end');
        if (ws !== null) this._windowStart = parseFloat(ws) || 0;
        if (we !== null) this._windowEnd = parseFloat(we) || 10;
        const to = this.getAttribute('time-origin');
        if (to !== null) this._timeOrigin = parseFloat(to);
        this._draw();
    }

    disconnectedCallback() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        if (this._resizeObserver) this._resizeObserver.disconnect();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;
        if (name === 'window-start') this._windowStart = parseFloat(newValue) || 0;
        if (name === 'window-end') this._windowEnd = parseFloat(newValue) || 10;
        if (name === 'time-origin') this._timeOrigin = newValue !== null ? parseFloat(newValue) : null;
        this._needsDraw = true;
        this._scheduleDraw();
    }

    _resizeCanvas() {
        if (!this._canvas) return;
        const rect = this.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this._canvas.width = rect.width * dpr;
        this._canvas.height = rect.height * dpr;
        this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._width = rect.width;
        this._height = rect.height;
    }

    _scheduleDraw() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => { this._rafId = null; this._draw(); });
    }

    _draw() {
        if (!this._ctx || !this._needsDraw) return;
        this._needsDraw = false;
        const w = this._width || this.getBoundingClientRect().width;
        const h = this._height || this.getBoundingClientRect().height;
        const ctx = this._ctx;
        if (!this._color) this._color = getComputedStyle(this).getPropertyValue('--tr-color').trim() || '#606878';
        const color = this._color;
        ctx.clearRect(0, 0, w, h);
        const viewDuration = this._windowEnd - this._windowStart;
        if (viewDuration <= 0) return;
        let interval, subSec;
        if (viewDuration < 4)        { interval = 2;    subSec = 1; }
        else if (viewDuration < 10)  { interval = 4;    subSec = 1; }
        else if (viewDuration < 20)  { interval = 6;    subSec = 1; }
        else if (viewDuration < 40)  { interval = 10;   subSec = 2; }
        else if (viewDuration < 80)  { interval = 20;   subSec = 2; }
        else if (viewDuration < 180) { interval = 30;   subSec = 3; }
        else if (viewDuration < 400) { interval = 60;   subSec = 5; }
        else if (viewDuration < 900) { interval = 120;  subSec = 10; }
        else if (viewDuration < 1800){ interval = 300;  subSec = 30; }
        else if (viewDuration < 3600){ interval = 600;  subSec = 60; }
        else if (viewDuration < 7200){ interval = 900;  subSec = 60; }
        else                         { interval = 1800; subSec = 120; }
        const halfInterval = interval / 2;
        const ws = this._windowStart;
        const origin = this._timeOrigin;
        const hasOrigin = origin !== null;
        const isOnInterval = (t, iv) => { const v = hasOrigin ? t - origin : t; const r = v / iv; return Math.abs(r - Math.round(r)) < 0.001; };
        const timeToX = (t) => ((t - ws) / viewDuration) * w;
        const subBase = hasOrigin ? origin : 0;
        const subStart = subBase + Math.ceil((ws - subBase) / subSec) * subSec;
        ctx.fillStyle = color;
        let t = subStart;
        while (t <= this._windowEnd + 0.001) {
            if (!isOnInterval(t, interval)) {
                const x = timeToX(t);
                const isHalf = isOnInterval(t, halfInterval);
                const tickH = isHalf ? 10 : 5;
                ctx.fillRect(Math.round(x) - 0.5, h - tickH, 1, tickH);
            }
            t += subSec;
        }
        const majBase = hasOrigin ? origin : 0;
        const majStart = majBase + Math.ceil((ws - majBase) / interval) * interval;
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'bottom';
        t = majStart;
        while (t <= this._windowEnd + 0.001) {
            const x = timeToX(t);
            ctx.fillStyle = color;
            ctx.fillRect(Math.round(x), h - 16, 1, 16);
            ctx.fillStyle = color;
            ctx.fillText(this._formatTime(hasOrigin ? t - origin : t), Math.round(x) + 3, h - 7);
            t += interval;
        }
    }

    _formatTime(seconds) {
        const total = Math.abs(seconds);
        const m = Math.floor(total / 60);
        const s = Math.floor(total % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }
}

if (!customElements.get('time-ruler')) customElements.define('time-ruler', TimeRuler);

export { WaveformEditor, TimeRuler };
