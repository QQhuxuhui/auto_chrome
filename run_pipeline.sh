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
echo "   3-Stage Automation (Invite + Accept + Local OAuth & Verify)"
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

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
    echo " ERROR: Node.js >= 18 required (found v$(node -v)). Stage 3 uses global fetch."
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

# ==== Build stages argument for orchestrator ====
STAGES_ARG="1,2,3"
if [[ "$RUN_ALL" != "1" ]]; then
    # join requested stages with commas; trim whitespace
    STAGES_ARG="$(echo "$STAGE" | tr ' ' ',' | sed 's/,,*/,/g; s/^,//; s/,$//')"
fi

# ==== Read DB creds from .env ====
if [[ ! -f "$ROOT/.env" ]]; then
    echo " ERROR: $ROOT/.env not found (need PG_* keys)"
    exit 1
fi

# shellcheck disable=SC2046
export $(grep -E '^PG_(HOST|PORT|USER|PASSWORD|DATABASE)=' "$ROOT/.env" | xargs)

if [[ -z "${PG_HOST:-}" || -z "${PG_USER:-}" || -z "${PG_DATABASE:-}" || -z "${PG_PASSWORD:-}" ]]; then
    echo " ERROR: .env missing one of PG_HOST/PG_USER/PG_DATABASE/PG_PASSWORD"
    exit 1
fi

# ==== Insert pipeline_runs row; capture id ====
RUN_ID="$(
    PGPASSWORD="$PG_PASSWORD" psql \
        -h "$PG_HOST" -p "${PG_PORT:-5432}" -U "$PG_USER" -d "$PG_DATABASE" \
        -t -A -v ON_ERROR_STOP=1 \
        -c "INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency) VALUES ('cli', '$STAGES_ARG', '[]'::jsonb, 1) RETURNING id;" 2>/dev/null \
    | grep -E '^[0-9]+$' | head -1
)"
RC=$?
if [[ $RC -ne 0 || -z "$RUN_ID" || ! "$RUN_ID" =~ ^[0-9]+$ ]]; then
    echo " ERROR: could not create pipeline_runs row (rc=$RC id='$RUN_ID')"
    exit 1
fi

echo " Created pipeline_runs id=$RUN_ID"
echo " ---- Running Orchestrator: stages=$STAGES_ARG ----"
node src/orchestrator.js --run-id "$RUN_ID" --stages "$STAGES_ARG" --concurrency 1 "${EXTRA_ARGS[@]}"
RC=$?

cd "$ROOT"
echo
echo " ==========================================================="
echo "   Pipeline finished (exit $RC)."
echo " ==========================================================="
echo
exit $RC
