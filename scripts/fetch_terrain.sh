#!/usr/bin/env bash
# Download the NASA LRO LOLA south-polar digital elevation model used for terrain horizons.
# Source: NASA PDS Geosciences Node, LRO LOLA gridded data records (LRO-L-LOLA-4-GDR-V1.0), product
# LDEM_60S_240M (polar stereographic, 240 m/pixel, 60°S to the south pole, ~120 MB). Kept out of Git.
#
# Usage: scripts/fetch_terrain.sh [destination_dir]   (default: backend/terrain)
set -euo pipefail

BASE="https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/backend/terrain}"
mkdir -p "$DEST"

for name in ldem_60s_240m.lbl ldem_60s_240m.img; do
  if [[ -s "$DEST/$name" ]]; then
    echo "ok       $name"
    continue
  fi
  echo "fetching $name"
  if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$DEST/$name.part" "$BASE/$name"; then
    rm -f "$DEST/$name.part"
    echo "ERROR: could not download $BASE/$name" >&2
    exit 1
  fi
  mv "$DEST/$name.part" "$DEST/$name"
done

expected=120435200
actual=$(wc -c < "$DEST/ldem_60s_240m.img" | tr -d ' ')
if [[ "$actual" != "$expected" ]]; then
  echo "ERROR: ldem_60s_240m.img is $actual bytes, expected $expected" >&2
  exit 1
fi
( cd "$DEST" && shasum -a 256 ldem_60s_240m.img ldem_60s_240m.lbl > SHA256SUMS.local )
echo "Terrain DEM ready in $DEST"
