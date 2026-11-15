# Deploying Lunar Prime

The app is two services: a FastAPI backend (SPICE geometry, precomputed LOLA terrain skylines, plus the
backend-only route planner, best-date and analyst APIs) and a Next.js frontend that proxies `/api/*` to it.
Judges and the public only need the frontend URL. On a Mac, `run-lunar-prime.command` runs both locally.

## Option A: one machine with Docker (simplest)

```bash
docker compose up --build
```

Open http://localhost:3000. The backend image downloads the NASA/JPL SPICE kernels (~45 MB) during the
build; terrain skylines are already in the repository.

On a cloud VM (any provider), open port 3000 (or put a TLS reverse proxy such as Caddy in front of it) and
set `LUNAR_PRIME_CORS` to the public URL.

## Option B: two managed services (e.g. Render, Railway, Fly.io)

1. **Backend**: a Docker web service built from `backend/Dockerfile` with the repository root as the build
   context. Add a persistent disk mounted at `/data` if you want saved runs and conversations to survive
   redeploys. Health check path: `/api/health`.
2. **Frontend**: a Docker web service built from `frontend/Dockerfile` with `frontend/` as the context and the
   build argument `BACKEND_URL=https://<your-backend-host>` (it is compiled into the proxy, so rebuild after
   changing it).

## The mission analyst on a public deployment

The analyst calls a paid language model. `docker-compose.yml` disables it by default
(`LUNAR_PRIME_CHAT_DISABLED=1`). Enable it publicly only with authentication and per-user rate and spending
limits. The comparison app itself never calls it.
