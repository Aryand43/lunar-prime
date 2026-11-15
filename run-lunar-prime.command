#!/bin/bash
# Double-click to run Lunar Prime locally: fetches SPICE kernels (once), starts the API on :8000 and the app on :3000.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Node.js: use the system one if present, otherwise a private copy in .tools/ (official build, checksum-verified).
if ! command -v npm >/dev/null; then
  if [ ! -x .tools/node/bin/npm ]; then
    echo "== Node.js not found: downloading the official Node 22 build into .tools/ (no admin rights needed)"
    arch=$(uname -m); [ "$arch" = "x86_64" ] && arch=x64
    base="https://nodejs.org/dist/latest-v22.x"
    file=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="darwin-$arch.tar.gz" '$2 ~ a"$" {print $2}')
    sum=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$file" '$2 == f {print $1}')
    mkdir -p .tools && curl -fL --progress-bar -o ".tools/$file" "$base/$file" || { echo "Download failed."; read -r -p "Press Return to close."; exit 1; }
    echo "$sum  .tools/$file" | shasum -a 256 -c - || { echo "Checksum mismatch; not using the download."; read -r -p "Press Return to close."; exit 1; }
    tar -xzf ".tools/$file" -C .tools && mv ".tools/${file%.tar.gz}" .tools/node && rm ".tools/$file"
  fi
  export PATH="$PWD/.tools/node/bin:$PATH"
fi
echo "Using Node $(node -v)"

command -v uv >/dev/null || { echo "uv is not installed. Install it with:  curl -LsSf https://astral.sh/uv/install.sh | sh"; read -r -p "Press Return to close."; exit 1; }

echo "== 1/3 SPICE kernels (skipped if already downloaded)"
./scripts/fetch_kernels.sh || echo "!! Kernel download failed; the app will offer synthetic demo data instead."

echo "== 2/3 Backend on http://127.0.0.1:8000"
(cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000) &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT

echo "== 3/3 Frontend on http://localhost:3000  (Ctrl+C in this window stops everything)"
cd frontend
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run dev
