# Lunar Prime API. Build from the repository root:
#   docker build -f backend/Dockerfile -t lunar-prime-api .
# SPICE kernels (~45 MB) and the LOLA south-polar DEM (~120 MB) are downloaded at build time from
# NASA/JPL NAIF and the NASA PDS Geosciences Node.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /usr/local/bin/uv

WORKDIR /app
COPY scripts/ scripts/
RUN scripts/fetch_kernels.sh /app/backend/kernels && scripts/fetch_terrain.sh /app/backend/terrain

COPY backend/pyproject.toml backend/uv.lock backend/
RUN cd backend && uv sync --frozen --no-dev
COPY backend/ backend/

ENV LUNAR_PRIME_DB_PATH=/data/lunar_prime.db \
    LUNAR_PRIME_QDRANT_PATH=/data/qdrant \
    LUNAR_PRIME_KERNEL_DIR=/app/backend/kernels \
    LUNAR_PRIME_TERRAIN_DIR=/app/backend/terrain
VOLUME ["/data"]
EXPOSE 8000
WORKDIR /app/backend
CMD ["uv", "run", "--no-dev", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
