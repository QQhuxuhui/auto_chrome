#!/usr/bin/env bash
# Gemini Family Pipeline - Linux / WSL2 (WSLg) version
# Equivalent of run_pipeline.bat

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src"

echo
echo " ==========================================================="
echo
echo "   Gemini Family Group Pipeline"
echo "   2-Stage Automation (Invite + Accept)"
echo
echo " ==========================================================="
echo

# ==== Parse arguments ====
STAGE=""
EXTRA_ARGS=()
RUN_ALL=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --stage)
            STAGE="$2"
            RUN_ALL=0
            shift 2
            ;;
        *)
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

# ==== Check Node.js ====
if ! command -v node >/dev/null 2>&1; then
    echo " ERROR: Node.js not found. Install it first:"
    echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "   sudo apt install -y nodejs"
    exit 1
fi

# ==== Check Google Chrome (real browser required) ====
if ! command -v google-chrome >/dev/null 2>&1 \
    && ! command -v google-chrome-stable >/dev/null 2>&1 \
    && [[ ! -x /usr/bin/google-chrome ]] \
    && [[ ! -x /usr/bin/google-chrome-stable ]]; then
    echo " ERROR: Google Chrome not found."
    echo " Install it (WSL2 + WSLg supports GUI windows):"
    echo "   wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
    echo "   sudo apt install -y ./google-chrome-stable_current_amd64.deb"
    exit 1
fi

# ==== WSLg display hint ====
if grep -qi microsoft /proc/version 2>/dev/null; then
    if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
        echo " WARNING: Running under WSL but DISPLAY/WAYLAND_DISPLAY is not set."
        echo "          Make sure you are on Windows 11 with WSLg, or configure an X server."
        echo
    fi
fi

# ==== Check dependencies ====
if [[ ! -d "$SRC/node_modules/puppeteer-core" ]]; then
    echo " Installing dependencies..."
    (cd "$SRC" && npm install --no-fund --no-audit)
fi

# ==== Run stages ====
cd "$SRC"

run_stage() {
    case "$1" in
        1)
            echo " ---- Stage 1: Send Family Invitations ----"
            node 1_invite.js "${EXTRA_ARGS[@]}"
            ;;
        2)
            echo " ---- Stage 2: Accept Family Invitations ----"
            node 2_accept.js "${EXTRA_ARGS[@]}"
            ;;
        *)
            echo " WARNING: unknown stage '$1'"
            return 1
            ;;
    esac
}

if [[ "$RUN_ALL" == "1" ]]; then
    echo " Running all 2 stages..."
    echo
    run_stage 1 || echo " WARNING: Stage 1 had errors"
    echo
    run_stage 2 || echo " WARNING: Stage 2 had errors"
else
    for s in $STAGE; do
        echo " ---- Running Stage $s ----"
        run_stage "$s" || true
        echo
    done
fi

cd "$ROOT"
echo
echo " ==========================================================="
echo "   Pipeline finished."
echo " ==========================================================="
echo
