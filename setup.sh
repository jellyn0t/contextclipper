#!/usr/bin/env bash
# Download the ~170MB of vendor + model files so the standalone clip
# editor can run fully offline. After this completes you can serve
# this directory over HTTP (e.g. `python3 -m http.server 8080`) and
# the app's source-mode pill will read "Local".
#
# Skip this entirely if you're happy with the hosted/CDN mode — the
# app falls back to jsdelivr / HuggingFace automatically when these
# files are missing.
#
# Idempotent: re-runs skip files that already exist with non-zero size.
# Use --force to redownload everything (e.g. after a version bump).
#
# Requires: bash, curl, tar. Tested on Linux/macOS. Adapts to WSL.

set -eu
cd "$(dirname "$0")"

FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=1 ;;
        --help|-h)
            sed -n '2,17p' "$0" | sed 's/^# //; s/^#//'
            exit 0
            ;;
        *) echo "unknown arg: $arg (try --help)" >&2; exit 2 ;;
    esac
done

# Version pins — bump in lockstep with CONFIG.sources.cdn in index.html
FFMPEG_CORE_VER="0.12.6"
FFMPEG_FFMPEG_VER="0.12.10"
FFMPEG_UTIL_VER="0.12.1"
TRANSFORMERS_VER="3.8.1"

MODELS=(whisper-tiny.en whisper-base.en)
MODEL_JSON_FILES=(
    config.json
    generation_config.json
    tokenizer.json
    tokenizer_config.json
    preprocessor_config.json
)
MODEL_ONNX_FILES=(
    encoder_model_quantized.onnx
    decoder_model_merged_quantized.onnx
)

# Tally counters for the final summary.
DOWNLOADED=0
SKIPPED=0
FAILED=0

# Download $2 to $1 unless the file exists already (or --force).
# Friendly status output; pipes curl output through nothing.
fetch() {
    local dest="$1" url="$2"
    if [ "$FORCE" -eq 0 ] && [ -s "$dest" ]; then
        printf '  skip  %s\n' "$dest"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi
    mkdir -p "$(dirname "$dest")"
    printf '  fetch %s ... ' "$dest"
    if curl -fsSL -o "$dest" "$url"; then
        local size
        size="$(wc -c < "$dest" 2>/dev/null || echo 0)"
        printf '%s bytes\n' "$size"
        DOWNLOADED=$((DOWNLOADED + 1))
    else
        printf 'FAILED\n'
        FAILED=$((FAILED + 1))
    fi
}

# Pull selected files out of an npm tarball.
# $1 = output dir, $2 = npm package name, $3 = version, rest = files
fetch_npm() {
    local outdir="$1" pkg="$2" ver="$3"
    shift 3
    local need=0
    for f in "$@"; do
        local target
        target="$(basename "$f")"
        if [ "$FORCE" -eq 1 ] || [ ! -s "$outdir/$target" ]; then
            need=1
            break
        fi
    done
    if [ "$need" -eq 0 ]; then
        for f in "$@"; do
            printf '  skip  %s/%s\n' "$outdir" "$(basename "$f")"
            SKIPPED=$((SKIPPED + 1))
        done
        return 0
    fi
    mkdir -p "$outdir"
    printf '  fetch npm:%s@%s -> %s\n' "$pkg" "$ver" "$outdir"
    # tar paths inside an npm tarball start with `package/...`; strip 2
    # to drop `package/dist/`. Use --strip-components 1 if pkg layout differs.
    local url="https://registry.npmjs.org/${pkg}/-/$(basename "$pkg")-${ver}.tgz"
    local tmp
    tmp="$(mktemp -d)"
    if curl -fsSL "$url" | tar xz -C "$tmp"; then
        for f in "$@"; do
            local target_name
            target_name="$(basename "$f")"
            if [ -f "$tmp/package/$f" ]; then
                cp "$tmp/package/$f" "$outdir/$target_name"
                printf '    %s/%s\n' "$outdir" "$target_name"
                DOWNLOADED=$((DOWNLOADED + 1))
            else
                printf '    MISSING in tarball: %s\n' "$f"
                FAILED=$((FAILED + 1))
            fi
        done
    else
        printf '    failed to download %s\n' "$url"
        FAILED=$((FAILED + 1))
    fi
    rm -rf "$tmp"
}

echo "==> ffmpeg.wasm (~31MB total — wasm binary is most of it)"

# Core wasm + JS loader. We need the ESM build of ffmpeg-core.js,
# not UMD: ffmpeg.esm.js spawns its worker as `type: "module"`, and
# module workers have no `importScripts`. worker.js falls through to
# `import(coreURL).default`, which only resolves for the ESM bundle —
# the UMD file has no exports and yields "failed to import
# ffmpeg-core.js". The .wasm binary is the same in both dists.
fetch_npm vendor/ffmpeg "@ffmpeg/core" "$FFMPEG_CORE_VER" \
    dist/esm/ffmpeg-core.js dist/esm/ffmpeg-core.wasm

# ffmpeg.esm.js + util.esm.js — single-file bundled ESM via jsdelivr's
# `/+esm` suffix. We get one self-contained file per package instead
# of the dist/esm/ multi-file tree (which uses relative imports and
# would need us to vendor every transitive sibling).
#
# worker.js: ffmpeg.esm.js does `new Worker(new URL("./worker.js",
# import.meta.url), ...)` on ff.load(), so the worker file must sit
# next to ffmpeg.esm.js on disk. We pull the bundled `worker.js/+esm`
# (self-contained, ~2.6KB) so it doesn't drag in dist/esm siblings.
JSDELIVR_NPM="https://cdn.jsdelivr.net/npm"
fetch vendor/ffmpeg/ffmpeg.esm.js \
    "${JSDELIVR_NPM}/@ffmpeg/ffmpeg@${FFMPEG_FFMPEG_VER}/+esm"
fetch vendor/ffmpeg/util.esm.js \
    "${JSDELIVR_NPM}/@ffmpeg/util@${FFMPEG_UTIL_VER}/+esm"
fetch vendor/ffmpeg/worker.js \
    "${JSDELIVR_NPM}/@ffmpeg/ffmpeg@${FFMPEG_FFMPEG_VER}/dist/esm/worker.js/+esm"

echo
echo "==> transformers.js + ONNX runtime (~22MB)"
JSDELIVR="https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VER}/dist"
fetch vendor/transformers/transformers.min.js                   "$JSDELIVR/transformers.min.js"
fetch vendor/transformers/ort-wasm-simd-threaded.jsep.mjs       "$JSDELIVR/ort-wasm-simd-threaded.jsep.mjs"
fetch vendor/transformers/ort-wasm-simd-threaded.jsep.wasm      "$JSDELIVR/ort-wasm-simd-threaded.jsep.wasm"

echo
echo "==> Whisper models (~118MB total)"
HF="https://huggingface.co"
for MODEL in "${MODELS[@]}"; do
    echo "  ${MODEL}"
    for FILE in "${MODEL_JSON_FILES[@]}"; do
        fetch "models/onnx-community/${MODEL}/${FILE}" \
              "${HF}/onnx-community/${MODEL}/resolve/main/${FILE}"
    done
    for FILE in "${MODEL_ONNX_FILES[@]}"; do
        fetch "models/onnx-community/${MODEL}/onnx/${FILE}" \
              "${HF}/onnx-community/${MODEL}/resolve/main/onnx/${FILE}"
    done
done

echo
echo "Done — downloaded ${DOWNLOADED}, skipped ${SKIPPED}, failed ${FAILED}."
if [ "$FAILED" -gt 0 ]; then
    echo "Some files failed to download. Re-run to retry; --force redownloads everything." >&2
    exit 1
fi
echo "Serve this directory over HTTP to run in Local mode:"
echo "    python3 -m http.server 8080   # then open http://localhost:8080/"
