# Generated MCP server (kit)

This document describes the MCP server that SLICE generates for self-hosting, returned as a ZIP by
`POST /api/generate` (see [API.md](API.md#post-apigenerate)). Every file in the bundle comes from one
Handlebars template in `src/server/templates/`, rendered against a single context object built by
`buildContext()` in `src/server/services/mcp-generator.ts`.

The hosted runtime (`/m/:id`) does not use these templates. It builds an equivalent MCP server in memory
from the stored configuration (`src/server/services/hosted-mcp-factory.ts`) and exposes the same tool names.

## Pipeline

```
GenerateRequest (re-parsed spec, selected ids, config)
  ↓ buildContext()
TemplateContext  ──┐
                   ├──▶ Handlebars.compile(<template>) ──▶ GeneratedFile { path, content }
STATIC_TEMPLATES ──┘
                                         ↓ buildZipStream()
                                    ZIP streamed to the client
```

- The context is plain data: no functions, no reference to the request object.
- Each template is compiled once and cached (`templateCache`). Compilation uses `noEscape: true`:
  values are inserted verbatim, so anything placed inside a generated string literal must be escaped by the generator.
- The output is an array of `{ path, content }` records; `path` is the location inside the ZIP.
- `generateMcp()` is pure: no disk writes, no network. `buildZipStream()` archives the files in memory.

## Bundle contents

Every bundle contains 12 files. An OAuth2 upstream adds a 13th, `src/oauth-token.ts`.

| Template | Emits | Notes |
|---|---|---|
| `package.json.hbs` | `package.json` | Name from `mcpName`, description from `apiName`. ES module. Scripts `build` (`tsc`), `start` (`node dist/index.js`), `dev` (`tsc --watch`). Dependencies `@modelcontextprotocol/sdk`, `zod`, `dotenv` (caret ranges). |
| `tsconfig.json.hbs` | `tsconfig.json` | Strict, target ES2022, `NodeNext` module resolution, `src` to `dist`, `types: ["node"]`. |
| `env.example.hbs` | `.env.example` | `UPSTREAM_BASE_URL`, the credential variables for `upstreamAuth.type`, `MCP_SERVER_TOKEN` when a token is set, `MCP_HTTP_PORT` unless the mode is `local`. |
| `gitignore.hbs` | `.gitignore` | Static: `node_modules`, `dist`, `.env`, logs. |
| `auth-context.ts.hbs` | `src/auth-context.ts` | Per-request `AsyncLocalStorage` holding the caller's `Authorization` header (relay mode) and `relayedToken()`. |
| `http-client.ts.hbs` | `src/http-client.ts` | Single `fetch` wrapper. Builds the URL, adds the upstream credential for `upstreamAuth.type`, surfaces non-2xx responses as errors. |
| `tools.ts.hbs` | `src/tools.ts` | One `server.tool(name, description, rawShape, handler)` call per selected endpoint. The input schema is a Zod raw shape (not `z.object(...)`), as the MCP SDK expects. |
| `index.ts.hbs` | `src/index.ts` | Loads `.env` (`dotenv/config`), creates the `McpServer`, wires the transports for `mode`. |
| `readme.md.hbs` | `README.md` | Install, run, Docker deployment, and agent connection instructions (Claude Desktop over stdio unless the mode is `remote`; n8n / Airia over HTTP unless the mode is `local`). |
| `Dockerfile.hbs` | `Dockerfile` | Two-stage `node:20-alpine` build: compile with `tsc`, then a runtime image with production dependencies only. `EXPOSE 8787`, `CMD ["node", "dist/index.js"]`. |
| `docker-compose.yml.hbs` | `docker-compose.yml` | One service, built from the `Dockerfile`, port `8787:8787`, `env_file: .env`, `restart: unless-stopped`. |
| `dockerignore.hbs` | `.dockerignore` | `node_modules`, `dist`, `.env`, `.git`, `npm-debug.log`. |
| `oauth-token.ts.hbs` | `src/oauth-token.ts` | OAuth2 only. client_credentials token manager: caches the token until 30 seconds before `expires_in` (300 seconds when absent), deduplicates concurrent fetches, never logs the secret. |

## TemplateContext

| Field | Source | Purpose |
|---|---|---|
| `mcpName` | `config.mcpName` | Package and server name |
| `apiName` / `apiVersion` | Re-parsed spec | README and package description |
| `baseUrl` | `config.baseUrl` | Default `UPSTREAM_BASE_URL` in `.env.example` |
| `upstreamAuth` | `config.upstreamAuth` | Selects the credential code path (`none`, `apiKey`, `bearer`, `oauth2`) |
| `scopesJoined` | `upstreamAuth.scopes` | Space-separated scopes, for the comment in `.env.example` |
| `tokenUrlJson` / `scopesJson` | `upstreamAuth.tokenUrl`, `upstreamAuth.scopes` | JSON-encoded string literals injected into `oauth-token.ts`, so a hostile value cannot break out of the literal |
| `mode` | `config.mode` | `local`, `remote` or `both`: drives the transports |
| `modeLocalOnly` / `modeHttpOnly` | Derived from `mode` | Flags for `{{#unless}}` blocks |
| `mcpServerToken` | `config.mcpServerToken` | Pre-fills `MCP_SERVER_TOKEN` in `.env.example`; omitted when `mode` is `local` |
| `tools[]` | Selected endpoints | One entry per tool: name, description, method, path, input schema, and the expressions that map arguments to path, query and body |

`config.hosting` and `config.retryOnServerError` are validated by the request schema but do not reach the templates.

## Transports and authentication

| `mode` | Transport |
|---|---|
| `local` | stdio only |
| `remote` | MCP Streamable HTTP only, on `MCP_HTTP_PORT` (default 8787) |
| `both` | stdio by default; HTTP when `MCP_TRANSPORT=http` |

The HTTP transport has two authentication modes, chosen with `MCP_AUTH_MODE`:

- `env` (default): agents must send `Authorization: Bearer <MCP_SERVER_TOKEN>`, otherwise `401`.
  The server refuses to start without `MCP_SERVER_TOKEN`. The upstream credential comes from the environment
  (`UPSTREAM_API_KEY`, `UPSTREAM_BEARER_TOKEN`, or `UPSTREAM_OAUTH_CLIENT_ID` + `UPSTREAM_OAUTH_CLIENT_SECRET`).
- `relay`: no SLICE token is checked. The caller's `Authorization: Bearer <token>` is forwarded to the upstream API
  for that request only and never stored, as in the hosted runtime.

For an OAuth2 upstream in `env` mode, the server fetches its own access token with the client_credentials grant
(HTTP Basic client authentication) and, on a `401` from the upstream, discards the cached token and retries the call once.

See [configuration.md](configuration.md#generated-kit) for the full list of the kit's environment variables.

## Tool name convention

Generated by `toolNameFor(endpoint)` in `mcp-generator.ts`: the endpoint label, lowercased, with every run of
non-alphanumeric characters replaced by `_` and leading or trailing underscores removed. It falls back to `tool`
if nothing is left. The label is the operation `summary`, else the first line of its `description`,
else a generated label such as `List products` (see [API.md](API.md#normalisation-rules)).

Examples: `"List products"` becomes `list_products`; `"Create order"` becomes `create_order`.

The tool description is the first line of the endpoint description, or the label when there is none.

## Input schema generation

`buildTool()` emits one entry per parameter (path, query, header, cookie and body):

```ts
{ id: z.string(), limit: z.number().int().optional() }
```

The Zod expressions come from `buildZodExpression()` in `zod-schema-builder.ts`. Optional parameters get
`.optional()`; descriptions are appended with `.describe(...)` only when `config.includeParamDescriptions` is true.
Keys that are not valid identifiers (such as `Notion-Version`) are quoted. Object schemas use `.passthrough()`
so undeclared fields in free-form bodies are kept.

At call time, path parameters are substituted into the path, query parameters are sent as the query string,
and body parameters are reassembled into the JSON body (`{ <wireName>: value }`, or the whole value for a single
whole-body parameter). No body is sent on `GET`. Header and cookie parameters appear in the input schema but the kit
does not forward them; the hosted runtime does forward header parameters.

## `{{#ifEquals}}` helper

Handlebars has no built-in strict-equality block helper. One is registered once at module load (`registerHelpers()`):

```hbs
{{#ifEquals mode "remote"}}…{{/ifEquals}}
```

is equivalent to `mode === 'remote'`. It is used for discriminated fields such as `mode` and `upstreamAuth.type`.

## Compile check in the test suite

`src/server/services/mcp-generator.snapshot.test.ts` parses `fixtures/shopify-50.yaml`, generates a bundle,
writes it to a temporary directory, symlinks `@modelcontextprotocol`, `zod`, `dotenv` and `@types/node` from the
SLICE workspace, then runs the workspace `tsc --noEmit -p tsconfig.json` on it. This catches template changes that
produce TypeScript that does not compile.

## Changing the templates

Edit the files in `src/server/templates/`; the test suite re-validates the pipeline. Do not edit
`dist/server/server/templates/`: the `copy:templates` script (run by `pnpm build:server`) copies the templates there.
