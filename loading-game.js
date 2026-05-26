// Brick-breaker mini-game for the loading overlay. editor.js starts it
// once a load has been running for a while and stops it when the load
// finishes. Pure entertainment — it never reads or writes app state; the
// whole module is self-contained. Controls: mouse / touch, or arrow keys.

const LOGICAL_W = 480;
const LOGICAL_H = 320;
const BRICK_COLORS = ['#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#2dd4bf'];

let canvas = null;
let ctx = null;
let container = null;
let rafId = null;
let running = false;
let accent = '#eab308';
let lastTs = 0;

// Game state
let paddleX = 0;
const paddleW = 74;
const paddleH = 10;
let ballX = 0;
let ballY = 0;
let ballVX = 0;
let ballVY = 0;
const ballR = 5;
let score = 0;
let bricks = [];
let leftHeld = false;
let rightHeld = false;

function resolveEls() {
    if (canvas) return true;
    container = document.getElementById('loadingGame');
    canvas = document.getElementById('loadingGameCanvas');
    if (!canvas) return false;
    ctx = canvas.getContext('2d');
    // Crisp on HiDPI: size the backing buffer to the device pixel ratio
    // and scale the context so we can draw in logical (480×320) units.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = LOGICAL_W * dpr;
    canvas.height = LOGICAL_H * dpr;
    ctx.scale(dpr, dpr);
    return true;
}

function buildBricks() {
    const cols = 9;
    const rows = 5;
    const gap = 6;
    const left = 14;
    const top = 30;
    const bw = (LOGICAL_W - left * 2 - gap * (cols - 1)) / cols;
    const bh = 14;
    const arr = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            arr.push({
                x: left + c * (bw + gap),
                y: top + r * (bh + gap),
                w: bw,
                h: bh,
                color: BRICK_COLORS[r % BRICK_COLORS.length],
                alive: true,
            });
        }
    }
    return arr;
}

function resetBall() {
    ballX = LOGICAL_W / 2;
    ballY = LOGICAL_H - 40;
    const speed = 270;
    ballVX = (Math.random() < 0.5 ? -1 : 1) * speed * 0.55;
    ballVY = -speed * 0.82;
}

function init() {
    paddleX = (LOGICAL_W - paddleW) / 2;
    score = 0;
    bricks = buildBricks();
    resetBall();
}

function update(dt) {
    // Keyboard paddle movement (mouse/touch is handled directly in onPointer)
    const paddleSpeed = 440;
    if (leftHeld) paddleX -= paddleSpeed * dt;
    if (rightHeld) paddleX += paddleSpeed * dt;
    paddleX = Math.max(0, Math.min(LOGICAL_W - paddleW, paddleX));

    ballX += ballVX * dt;
    ballY += ballVY * dt;

    // Side + top walls
    if (ballX - ballR < 0) { ballX = ballR; ballVX = Math.abs(ballVX); }
    if (ballX + ballR > LOGICAL_W) { ballX = LOGICAL_W - ballR; ballVX = -Math.abs(ballVX); }
    if (ballY - ballR < 0) { ballY = ballR; ballVY = Math.abs(ballVY); }

    // Paddle
    const py = LOGICAL_H - 18;
    if (ballVY > 0 && ballY + ballR >= py && ballY - ballR <= py + paddleH &&
        ballX >= paddleX && ballX <= paddleX + paddleW) {
        ballVY = -Math.abs(ballVY);
        ballY = py - ballR;
        // Steer based on where it hit the paddle (-1 left .. 1 right).
        const hit = (ballX - (paddleX + paddleW / 2)) / (paddleW / 2);
        ballVX = hit * 280;
    }

    // Missed — friendly endless respawn (no game over during a wait).
    if (ballY - ballR > LOGICAL_H) resetBall();

    // Bricks (one hit per frame keeps the bounce sane)
    for (const b of bricks) {
        if (!b.alive) continue;
        if (ballX + ballR > b.x && ballX - ballR < b.x + b.w &&
            ballY + ballR > b.y && ballY - ballR < b.y + b.h) {
            b.alive = false;
            score++;
            const overlapX = Math.min(ballX + ballR - b.x, b.x + b.w - (ballX - ballR));
            const overlapY = Math.min(ballY + ballR - b.y, b.y + b.h - (ballY - ballR));
            if (overlapX < overlapY) ballVX = -ballVX; else ballVY = -ballVY;
            break;
        }
    }

    // Cleared the board — rebuild and keep going.
    if (bricks.every(b => !b.alive)) {
        bricks = buildBricks();
        resetBall();
    }
}

function draw() {
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

    for (const b of bricks) {
        if (!b.alive) continue;
        ctx.fillStyle = b.color;
        ctx.fillRect(b.x, b.y, b.w, b.h);
    }

    ctx.fillStyle = accent;
    ctx.fillRect(paddleX, LOGICAL_H - 18, paddleW, paddleH);

    ctx.beginPath();
    ctx.arc(ballX, ballY, ballR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('SCORE ' + score, 10, 17);
}

function frame(ts) {
    if (!running) return;
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    update(dt);
    draw();
    rafId = requestAnimationFrame(frame);
}

function onPointer(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const x = ((e.clientX - rect.left) / rect.width) * LOGICAL_W;
    paddleX = Math.max(0, Math.min(LOGICAL_W - paddleW, x - paddleW / 2));
}

function onKeyDown(e) {
    if (e.key === 'ArrowLeft') { leftHeld = true; e.preventDefault(); }
    else if (e.key === 'ArrowRight') { rightHeld = true; e.preventDefault(); }
}

function onKeyUp(e) {
    if (e.key === 'ArrowLeft') leftHeld = false;
    else if (e.key === 'ArrowRight') rightHeld = false;
}

export function startLoadingGame() {
    if (running || !resolveEls()) return;
    accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#eab308';
    init();
    running = true;
    lastTs = 0;
    leftHeld = rightHeld = false;
    container.hidden = false;
    canvas.addEventListener('pointermove', onPointer);
    canvas.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    rafId = requestAnimationFrame(frame);
}

export function stopLoadingGame() {
    if (running) {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        canvas.removeEventListener('pointermove', onPointer);
        canvas.removeEventListener('pointerdown', onPointer);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
    }
    if (container) container.hidden = true;
}
