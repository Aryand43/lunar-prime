# Lunar Prime web app. BACKEND_URL is baked into the /api/* proxy at build time.
#   docker build -f frontend/Dockerfile --build-arg BACKEND_URL=http://api:8000 -t lunar-prime-web frontend
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG BACKEND_URL=http://api:8000
ENV BACKEND_URL=$BACKEND_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "run", "start", "--", "--port", "3000", "--hostname", "0.0.0.0"]
