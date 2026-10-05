# Configuration and deployment

This page covers the environment variables SLICE reads, how to run it in production, and how to run the MCP server
kit it generates. Everything here reflects what the code supports today.

## SLICE server

### Environment variables

The server reads its configuration from the process environment only. It does not load a `.env` file.

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3001` | HTTP port the server listens on. |
| `NODE_ENV` | `development` | `production` serves the built front end from `dist/client` (with a single-page-app fallback) and turns on the SSRF guard for hosted MCPs (`config.baseUrl` in `POST /api/host`, and every hosted tool call). Any other value leaves that guard off so a local upstream can be reached. The value is also reported by `GET /api/health`. `pnpm start` sets it to `production`. |
| `SLICE_STORE_PATH` | `./data/hosted.json` | JSON file that stores hosted MCP configurations. Resolved from the working directory; the parent directory is created if missing. |
| `SLICE_HOSTED_TTL_HOURS` | `72` | Lifetime of a hosted MCP URL, in hours. `0` disables expiry (useful for a private self-hosted instance). A negative or non-numeric value falls back to `72`. |
| `PARSE_MAX_CONCURRENT` | `3` | Maximum number of spec parses running at the same time (minimum 1). Each parse is a child process with a 512 MB heap cap, so peak parse memory is about this value × 512 MB. |
| `PARSE_MAX_QUEUE` | `12` | Maximum number of parses waiting for a slot (minimum 0). Requests beyond it get `429 PARSE_BUSY`. |

The SSRF guard on `POST /api/upload-url` is always on, whatever `NODE_ENV` is.

The parse child process does not inherit the server environment. It receives only `PATH`, `HOME`, `NODE_ENV` and an
empty `NODE_OPTIONS`, so a `NODE_OPTIONS` set for the server (for example `--max-old-space-size`) does not affect parsing.

Fixed limits that are not configurable: 10 MB per API description, 15 MB request body for `/api/generate` and
`/api/host`, 200 000 nodes per spec, 8-second parse timeout, 30-second generation timeout,
30 requests per minute per IP on `/api/*`. See [API.md](API.md).

### Running in production

Requirements: Node.js 22 or later, pnpm 9.

```bash
pnpm install          # full install: the build tools and the MCP SDK used by the hosted runtime are devDependencies
pnpm build            # front end to dist/client, server to dist/server/server (templates copied alongside)
pnpm start            # NODE_ENV=production node dist/server/server/index.js
```

- Run `pnpm start` from the repository root: the default store path and the parse child process both resolve from the working directory.
- `pnpm prod:smoke` builds the project, boots the compiled server on port 3099 (or `PORT`), runs a set of checks against
  the real production paths, and stops it. `SKIP_BUILD=1 pnpm prod:smoke` reuses an existing `dist/`.
- The repository ships no Dockerfile for SLICE itself.

### Persistent data

Hosted MCP configurations live in memory and in the `SLICE_STORE_PATH` file, rewritten synchronously on every
creation and deletion. To keep hosted URLs across restarts and redeploys, put that file on a persistent volume.
The file holds no credentials (see [API.md](API.md#post-apihost) for what is stored).

Each server process keeps its own in-memory copy of the store, so run a single instance per store file.

Expired configurations are removed when they are next requested; there is no background cleanup.

### Running behind a reverse proxy

The app does not configure Express `trust proxy`. Behind a TLS-terminating reverse proxy this has two effects:

- The rate limit counts every client under the proxy's IP address, so all users share one 30 requests-per-minute budget.
- `POST /api/host` builds the returned URL from the request protocol and `Host` header, so it returns `http://` URLs
  even when the public site is served over HTTPS.

Account for both when exposing an instance publicly.

### Development scripts

These variables are read only by the helper scripts in `scripts/`, not by the server.

| Variable | Script | Default | Effect |
|---|---|---|---|
| `PORT` | `scripts/prod-smoke.ts` | `3099` | Port for the compiled server under test. |
| `SKIP_BUILD` | `scripts/prod-smoke.ts` | unset | `1` skips `pnpm build` and reuses `dist/`. |
| `CORPUS_MAX_BYTES` | `scripts/corpus-check.ts` | 10 MB | Skips corpus specs larger than this size. |
| `NOTION_TOKEN`, `API_TOKEN` | `scripts/try-hosted.ts` | unset | Upstream token sent as `Authorization: Bearer` to a hosted MCP (the first one set wins). |

## Generated kit

`POST /api/generate` returns a TypeScript MCP server for self-hosting. Its file list is in
[mcp-template.md](mcp-template.md#bundle-contents).

### Environment variables

The kit loads `.env` at startup (`dotenv`). `.env.example` contains only the variables relevant to the chosen
auth type and mode.

| Variable | Default | Effect |
|---|---|---|
| `UPSTREAM_BASE_URL` | (none) | Required. Base URL of the upstream API; pre-filled in `.env.example`. The server refuses to start without it. |
| `MCP_AUTH_MODE` | `env` | `env`: the upstream credential comes from the variables below, and HTTP clients must present `MCP_SERVER_TOKEN`. `relay`: the HTTP caller's own `Authorization: Bearer <token>` is forwarded to the upstream API for that request and never stored; no `MCP_SERVER_TOKEN` is checked. |
| `UPSTREAM_API_KEY` | (none) | API-key upstreams. Sent in the header chosen at generation time. Required in `env` mode. |
| `UPSTREAM_BEARER_TOKEN` | (none) | Bearer upstreams. Sent as `Authorization: Bearer <value>`. Required in `env` mode. |
| `UPSTREAM_OAUTH_CLIENT_ID`, `UPSTREAM_OAUTH_CLIENT_SECRET` | (none) | OAuth2 upstreams. Used for the client_credentials grant against the token URL chosen at generation time. Required in `env` mode. |
| `MCP_SERVER_TOKEN` | Pre-filled in `.env.example` | HTTP transport, `env` mode: agents must send `Authorization: Bearer <value>`, otherwise `401`. Required in that case. |
| `MCP_HTTP_PORT` | `8787` | Port of the HTTP transport. |
| `MCP_TRANSPORT` | `stdio` | Only for bundles generated with `mode: "both"`: `http` starts the HTTP transport instead of stdio. |

To create a new `MCP_SERVER_TOKEN`, any long random string works; for example `openssl rand -hex 16`.

In `relay` mode the kit's HTTP endpoint has no access control of its own. Only expose it where the URL itself is
kept private, or behind your own authentication.

### Running the kit

With Node.js (the kit's README uses pnpm; npm works the same way):

```bash
cp .env.example .env   # then fill in the credentials
npm install
npm run build
npm start              # node dist/index.js
```

With Docker:

```bash
cp .env.example .env   # then fill in the credentials
docker compose up -d   # builds the image and listens on port 8787
```

The image is a two-stage `node:20-alpine` build that runs `node dist/index.js` with production dependencies only.
To deploy on a platform that builds from a Dockerfile (Coolify, Railway, Render and similar), point it at the
bundle's `Dockerfile` and set the same variables in the platform instead of a `.env` file.

Notes:

- `docker-compose.yml` maps port `8787:8787`. If you change `MCP_HTTP_PORT`, change the port mapping too.
- A bundle generated with `mode: "both"` starts on stdio unless `MCP_TRANSPORT=http` is set, which a container
  usually needs. Bundles generated from the web UI use `mode: "remote"` (HTTP only).
- Agents connect over MCP Streamable HTTP to `http://<host>:8787` and, in `env` mode, send `Authorization: Bearer <MCP_SERVER_TOKEN>`.
