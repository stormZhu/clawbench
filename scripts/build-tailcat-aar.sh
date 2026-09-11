#!/usr/bin/env bash
#
# build-tailcat-aar.sh — generates android/app/libs/tailcatbridge.aar from
# mobile/tailcatbridge using gomobile.
#
# The AAR is a ~12MB generated binary and is deliberately NOT committed (see
# .git/info/exclude). Both local builds and CI regenerate it here, so the source of
# truth stays mobile/tailcatbridge/*.go and no binary can drift from it.
#
# Usage:
#   ./scripts/build-tailcat-aar.sh            # regenerate only when missing/stale
#   ./scripts/build-tailcat-aar.sh --force    # always regenerate
#   ./scripts/build-tailcat-aar.sh --check    # report status, build nothing
#
# Requirements: go, gomobile (go install golang.org/x/mobile/cmd/gomobile@latest),
# and an Android NDK reachable via ANDROID_NDK_HOME or the SDK's ndk/ directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Keep in sync with android/app/build.gradle: gomobile builds arm64-v8a only and
# the manifest pins minSdk 24, so the binding must not target anything lower.
GOMOBILE_TARGET="android/arm64"
ANDROID_API=24
GO_PACKAGE="./mobile/tailcatbridge"
AAR_REL="android/app/libs/tailcatbridge.aar"
AAR_PATH="$REPO_ROOT/$AAR_REL"

FORCE=0
CHECK_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --check) CHECK_ONLY=1 ;;
        -h|--help)
            sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "ERROR: unknown argument '$arg' (try --help)" >&2
            exit 2
            ;;
    esac
done

log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }

# ---------------------------------------------------------------- gomobile

find_gomobile() {
    if command -v gomobile >/dev/null 2>&1; then
        command -v gomobile
        return 0
    fi
    local gopath_bin
    gopath_bin="$(go env GOPATH 2>/dev/null)/bin/gomobile"
    if [ -x "$gopath_bin" ]; then
        echo "$gopath_bin"
        return 0
    fi
    return 1
}

# ---------------------------------------------------------------- NDK

# Newest NDK under an SDK root, or nothing.
newest_ndk_under() {
    local sdk="$1"
    [ -n "$sdk" ] && [ -d "$sdk/ndk" ] || return 1
    # Version directories sort correctly as dotted numbers once the leading digit
    # count is padded, which version sort handles directly.
    ls -1 "$sdk/ndk" 2>/dev/null | sort -V | tail -1
}

sdk_dir_from_local_properties() {
    local props="$REPO_ROOT/android/local.properties"
    [ -f "$props" ] || return 1
    # Take the last sdk.dir declaration and strip "sdk.dir=" plus any CR.
    sed -n 's/^sdk\.dir=//p' "$props" | tail -1 | tr -d '\r'
}

find_ndk() {
    if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then
        echo "$ANDROID_NDK_HOME"
        return 0
    fi

    local sdk candidate
    for sdk in \
        "$(sdk_dir_from_local_properties || true)" \
        "${ANDROID_HOME:-}" \
        "${ANDROID_SDK_ROOT:-}" \
        "$HOME/Library/Android/sdk" \
        "$HOME/Android/Sdk"; do
        candidate="$(newest_ndk_under "$sdk" || true)"
        if [ -n "$candidate" ]; then
            echo "$sdk/ndk/$candidate"
            return 0
        fi
    done
    return 1
}

find_sdk_dir() {
    local sdk
    sdk="$(sdk_dir_from_local_properties || true)"
    if [ -n "$sdk" ] && [ -d "$sdk" ]; then
        echo "$sdk"
        return 0
    fi
    for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
               "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
        if [ -n "$sdk" ] && [ -d "$sdk" ]; then
            echo "$sdk"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------- staleness

# True when the AAR is missing or older than any Go source that feeds it.
aar_is_stale() {
    [ -f "$AAR_PATH" ] || return 0
    local newer
    newer="$(find "$REPO_ROOT/mobile/tailcatbridge" -name '*.go' -newer "$AAR_PATH" -print -quit 2>/dev/null || true)"
    [ -n "$newer" ] && return 0
    # The binding links the whole module, so dependency bumps invalidate it too.
    for f in "$REPO_ROOT/go.mod" "$REPO_ROOT/go.sum"; do
        [ -f "$f" ] && [ "$f" -nt "$AAR_PATH" ] && return 0
    done
    return 1
}

# ---------------------------------------------------------------- main

if [ ! -d "$REPO_ROOT/mobile/tailcatbridge" ]; then
    echo "ERROR: $REPO_ROOT/mobile/tailcatbridge not found" >&2
    exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ -f "$AAR_PATH" ]; then
        if aar_is_stale; then
            echo "stale: $AAR_REL"
            exit 1
        fi
        echo "up-to-date: $AAR_REL"
        exit 0
    fi
    echo "missing: $AAR_REL"
    exit 1
fi

if [ "$FORCE" -eq 0 ] && ! aar_is_stale; then
    log "tailcatbridge.aar is up to date, skipping ($AAR_REL)"
    exit 0
fi

GOMOBILE_BIN="$(find_gomobile || true)"
if [ -z "$GOMOBILE_BIN" ]; then
    cat >&2 <<'EOF'
ERROR: gomobile not found.

Install it with:
  go install golang.org/x/mobile/cmd/gomobile@latest

then make sure "$(go env GOPATH)/bin" is on PATH.
EOF
    exit 1
fi

NDK_DIR="$(find_ndk || true)"
if [ -z "$NDK_DIR" ]; then
    cat >&2 <<'EOF'
ERROR: no Android NDK found.

gomobile needs one to build the arm64 binding. Either install it through the SDK
manager (sdkmanager "ndk;<version>") or point ANDROID_NDK_HOME at an existing NDK.
EOF
    exit 1
fi

# gomobile resolves the NDK through the environment, so export what we found rather
# than relying on the caller's shell having it set.
export ANDROID_NDK_HOME="$NDK_DIR"
SDK_DIR="$(find_sdk_dir || true)"
if [ -n "$SDK_DIR" ]; then
    export ANDROID_HOME="${ANDROID_HOME:-$SDK_DIR}"
fi

mkdir -p "$(dirname "$AAR_PATH")"

log "gomobile:  $GOMOBILE_BIN"
log "NDK:       $NDK_DIR"
log "SDK:       ${ANDROID_HOME:-<unset>}"
log "binding $GO_PACKAGE -> $AAR_REL ($GOMOBILE_TARGET, androidapi $ANDROID_API)"

# Build into a temp file first so a failed bind cannot leave a half-written AAR
# behind — a truncated AAR fails much later, and much more confusingly, at dex time.
TMP_AAR="$AAR_PATH.tmp.$$"
trap 'rm -f "$TMP_AAR"' EXIT

cd "$REPO_ROOT"
"$GOMOBILE_BIN" bind \
    -target="$GOMOBILE_TARGET" \
    -androidapi "$ANDROID_API" \
    -o "$TMP_AAR" \
    "$GO_PACKAGE"

mv "$TMP_AAR" "$AAR_PATH"
trap - EXIT

log "wrote $AAR_REL ($(du -h "$AAR_PATH" | cut -f1))"
