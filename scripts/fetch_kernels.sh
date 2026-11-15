#!/usr/bin/env bash
# Download the NASA/JPL NAIF SPICE kernels Lunar Prime needs, from the official
# NAIF generic_kernels archive. Kernels are large binary files and are kept out
# of Git (see .gitignore). Re-running the script skips files already present.
#
# Usage: scripts/fetch_kernels.sh [destination_dir]   (default: backend/kernels)
set -euo pipefail

BASE="https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/backend/kernels}"
mkdir -p "$DEST"

# path-under-generic_kernels | purpose
KERNELS=(
  "lsk/naif0012.tls|Leapseconds (UTC <-> TDB)"
  "pck/pck00011.tpc|IAU body constants (lunar radii)"
  "pck/moon_pa_de440_200625.bpc|High-accuracy lunar orientation (MOON_PA, DE440)"
  "fk/satellites/moon_de440_250416.tf|Lunar frame definitions (MOON_PA, MOON_ME for DE440)"
  "spk/planets/de440s.bsp|Planetary ephemeris DE440s (Sun, Earth, Moon; 1849-2150)"
)

for entry in "${KERNELS[@]}"; do
  path="${entry%%|*}"
  purpose="${entry#*|}"
  name="$(basename "$path")"
  if [[ -s "$DEST/$name" ]]; then
    echo "ok       $name  ($purpose)"
    continue
  fi
  echo "fetching $name  ($purpose)"
  if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$DEST/$name.part" "$BASE/$path"; then
    rm -f "$DEST/$name.part"
    echo "ERROR: could not download $BASE/$path" >&2
    echo "Check network access to naif.jpl.nasa.gov, or download the file manually into $DEST." >&2
    exit 1
  fi
  mv "$DEST/$name.part" "$DEST/$name"
done

# Record exactly what was downloaded (for provenance; NAIF publishes no checksums
# for these files, so we store our own).
( cd "$DEST" && shasum -a 256 naif0012.tls pck00011.tpc moon_pa_de440_200625.bpc moon_de440_250416.tf de440s.bsp > SHA256SUMS.local )
echo "All kernels present in $DEST (checksums in SHA256SUMS.local)."
