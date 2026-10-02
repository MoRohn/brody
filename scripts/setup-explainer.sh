#!/usr/bin/env bash
# Set up the optional local tools for Brody explainer videos.
#   npm run explainer:setup
#
# Required: FFmpeg (ffmpeg and ffprobe on PATH). Brody never installs system packages itself; when something is
# missing it prints the command and stops.
# Optional: Manim in a private virtualenv (~/.local/share/brody/explainer-venv), used for diagram and
# transformation scenes. Without it, every scene uses the built-in HTML/SVG renderer.
# Voices: macOS has an on-device voice built in. On Linux, install Piper and set PIPER_MODEL for a local voice.
set -euo pipefail

VENV="${BRODY_EXPLAINER_VENV:-$HOME/.local/share/brody/explainer-venv}"
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
miss() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "Brody explainer setup"
if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then ok "FFmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3)"; else
  miss "FFmpeg is required. Install it, then run this again:"
  echo "      macOS:  brew install ffmpeg        Debian/Ubuntu:  sudo apt install ffmpeg"
  exit 1
fi

if [ "$(uname)" = "Darwin" ]; then
  if command -v swiftc >/dev/null; then ok "macOS on-device voice (word timings measured by the speech engine)"; else miss "swiftc not found: install the Xcode command line tools (xcode-select --install) for the on-device voice"; fi
fi

# Manim needs cairo and pango from the system.
need=""
if [ "$(uname)" = "Darwin" ]; then
  for p in cairo pango pkg-config; do brew list --formula "$p" >/dev/null 2>&1 || need="$need $p"; done
  [ -n "$need" ] && { miss "Manim needs:$need"; echo "      brew install$need"; echo "  (Skipping Manim; the HTML renderer works without it.)"; exit 0; }
else
  pkg-config --exists cairo pangocairo 2>/dev/null || { miss "Manim needs cairo and pango development files"; echo "      sudo apt install libcairo2-dev libpango1.0-dev pkg-config python3-dev"; echo "  (Skipping Manim; the HTML renderer works without it.)"; exit 0; }
fi

if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import manim" 2>/dev/null; then ok "Manim $("$VENV/bin/python" -c 'import manim; print(manim.__version__)') in $VENV"; exit 0; fi
echo "  Installing Manim into $VENV …"
mkdir -p "$(dirname "$VENV")"
if command -v uv >/dev/null; then
  uv venv --python 3.12 "$VENV" >/dev/null
  uv pip install --python "$VENV/bin/python" "manim==0.19.0"
else
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet "manim==0.19.0"
fi
ok "Manim $("$VENV/bin/python" -c 'import manim; print(manim.__version__)') installed. Brody finds it automatically (or set MANIM_PYTHON=$VENV/bin/python)."
