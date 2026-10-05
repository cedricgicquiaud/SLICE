# SLICE

**Turn any API description into an MCP server that exposes only the endpoints your AI agent is allowed to call.**

[![Project Status: WIP](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![CI](https://github.com/cedricgicquiaud/slice/actions/workflows/ci.yml/badge.svg)](https://github.com/cedricgicquiaud/slice/actions/workflows/ci.yml)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](LICENSE.md)
[Case study](https://cedricgicquiaud.github.io/projets/slice/)

![Endpoint selection: tick what the agent may call](docs/screenshots/2-select.png)

## Overview

AI agents (Claude, Cursor, n8n…) reach external APIs through MCP connectors. Exposing a whole API to an agent
grants it too much power and floods its context: an agent that only reads orders has no reason to be able to
delete them. Existing generators target developers (CLI, config files).

SLICE is a web service: upload an API description, tick the endpoints the agent may call, and get a connector.
Anything left unticked does not exist for the agent.

| Upload | Configure |
|---|---|
| ![Upload an API description](docs/screenshots/1-upload.png) | ![Name, upstream auth and hosting, with the context saved](docs/screenshots/3-configure.png) |

## Features

- **Least privilege by construction** — the generated server exposes the selected endpoints only.
- **Three input formats** — OpenAPI 3.0/3.1 as is; Swagger 2.0 and Postman v2.x converted automatically.
- **Two delivery modes** — download the generated TypeScript server, or use a hosted URL to paste into the agent.
- **Upstream authentication** — OAuth2 client credentials, bearer token, API key. In hosted mode the user's token
  is relayed, never stored.
- **Works with any MCP client** — stdio and Streamable HTTP transports.

## Getting started

Requires Node.js 22+ and pnpm 9+. No API key needed.

```bash
git clone https://github.com/cedricgicquiaud/slice.git
cd slice && pnpm install
pnpm dev        # http://localhost:5173
```

`pnpm test` runs the test suite; `pnpm build && pnpm start` runs the production build.

## Architecture

TypeScript monolith: React 19 + Vite front end, Express back end serving both the UI and the API, generated code
built on `@modelcontextprotocol/sdk`.

Key decisions:
- **Isolated parsing.** Some specs exhaust memory. Parsing runs in a child process with a timeout, a memory cap and
  a concurrency limit: a malicious spec returns a clean error and the server stays up.
- **Hosted mode over a desktop binary.** The first plan shipped an executable; unsigned binaries are blocked by
  macOS Gatekeeper. The hosted mode serves several agent sessions in parallel instead.
- **External data is JSON-encoded in generated code.** Rule adopted after a review found two code-injection paths
  (token URL, OAuth scopes), both fixed.

## Status

Functional, not yet deployed.

- 556 automated tests, strict typing, CI on every pull request.
- 500 real public API descriptions run through the pipeline: 412 converted, 83 rejected cleanly, 5 too large,
  0 crashes (`corpus` workflow, on demand).
- Verified end to end in Claude Desktop against the Notion API.

Next: public hosted instance.

Product specification: [docs/spec.md](docs/spec.md).

## License

[Functional Source License 1.1, MIT Future License](LICENSE.md): free to read, use internally, modify and
redistribute for any purpose other than a competing commercial product or service. Each version becomes MIT two
years after its release.
