# Deploying Lunar Prime

The app is two services: a FastAPI backend (SPICE geometry, LOLA terrain, route planner, optional analyst)
and a Next.js frontend that proxies `/api/*` to it. Judges and the public only need the frontend URL.

## Option A: one machine with Docker (simplest)

```bash
docker compose up --build
```

Open http://localhost:3000. The backend image downloads the NASA/JPL SPICE kernels (~45 MB) and the
LOLA south-polar DEM (~120 MB) during the build, so the first build takes a few minutes.

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
(`LUNAR_PRIME_CHAT_DISABLED=1`). Enable it publicly only with authentication, per-user rate and spending
limits, and the other items in the README section "Public deployment security". The Site Navigator, best-date
finder and route simulator need no API key.

## Shareable links

Every Site Navigator comparison updates the page URL (`#v=1&d=…&t=…&s=lat,lon,start,name|…`). Copy it with
**Copy shareable link**; opening it reproduces the same sites, dates, window length and terrain setting.
