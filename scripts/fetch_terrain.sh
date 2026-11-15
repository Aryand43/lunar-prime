#!/usr/bin/env bash
# Download the LOLA south-polar elevation maps Lunar Prime uses for real horizons, plus NASA's average
# illumination maps used only by scripts/validate_terrain.py. Large binaries, kept out of Git.
#
#   DEMs: NASA GSFC PGDA product 90, "A New View of the Lunar South Pole from LOLA" (Barker et al. 2023)
#         https://pgda.gsfc.nasa.gov/products/90   (cloud-optimised GeoTIFF, MOON_ME frame of DE421)
#   Validation: LOLA PDS "average illumination" maps (Mazarico et al. 2011), PGDA product 69
#         https://imbrium.mit.edu/BROWSE/EXTRAS/ILLUMINATION
#
# Usage: scripts/fetch_terrain.sh [--no-validation]     Re-running skips files already present.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/backend/terrain"
mkdir -p "$DEST/validation"

fetch() {  # url dest
  local url="$1" out="$2" name; name="$(basename "$out")"
  if [[ -s "$out" ]]; then echo "ok       $name"; return; fi
  echo "fetching $name"
  curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$out.part" "$url"
  mv "$out.part" "$out"
}

PGDA="https://pgda.gsfc.nasa.gov/data/LOLA_20mpp"
fetch "$PGDA/LDEM_80S_80MPP_ADJ.TIF"  "$DEST/LDEM_80S_80MPP_ADJ.TIF"    # 181 MB, 80 m/px, 80S to pole
fetch "$PGDA/LDEM_60S_240MPP_ADJ.TIF" "$DEST/LDEM_60S_240MPP_ADJ.TIF"   # 210 MB, 240 m/px, 60S to pole

if [[ "${1:-}" != "--no-validation" ]]; then
  ILL="https://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG"
  for base in AVGVISIB_85S_060M_201608 AVGVISIB_85S_060M_201608_EARTH AVGVISIB_65S_240M_201608 AVGVISIB_65S_240M_201608_EARTH; do
    fetch "$ILL/$base.LBL" "$DEST/validation/$base.LBL"
    fetch "$ILL/$base.IMG" "$DEST/validation/$base.IMG"
  done
fi

( cd "$DEST" && shasum -a 256 *.TIF validation/* > SHA256SUMS.local )
echo "Done. Checksums in backend/terrain/SHA256SUMS.local"
