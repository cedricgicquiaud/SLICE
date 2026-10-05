// Hostile-spec guarantee: nothing taken from an uploaded API description can
// escape its string literal, comment or JSON value in the downloaded kit.
// The spec author is untrusted; the kit runs on the user's machine.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { generateMcp } from './mcp-generator';
import { sliceConfigSchema } from '@shared/config-schema';
import type { GenerateRequest, GeneratedFile, ParsedSpec } from '@shared/types';

const MARK = 'INJECTED';
const DESCRIPTION = `List things\\'); ${MARK}(); //`;
const PATH = `/things/'+${MARK}()+'`;
const API_NAME = `Evil", "scripts": {"postinstall": "${MARK}"}, "x": "\nRUN ${MARK}`;
const HEADER = `X-Key'+${MARK}()+'`;

const SPEC: ParsedSpec = {
  apiName: API_NAME,
  apiVersion: '1',
  baseUrl: 'https://api.example.com',
  authType: 'apiKey',
  groups: [
    {
      tag: 'Things',
      endpoints: [
        { id: 'GET /things', method: 'GET', path: PATH, label: 'List things', description: DESCRIPTION, params: [] },
      ],
    },
  ],
};

function generate(): GeneratedFile[] {
  const req: GenerateRequest = {
    parsedSpec: SPEC,
    rawSpec: 'unused',
    selectedIds: ['GET /things'],
    config: {
      mcpName: 'evil-api',
      baseUrl: 'https://api.example.com',
      upstreamAuth: { type: 'apiKey', headerName: HEADER },
      hosting: 'self',
      mode: 'both',
      mcpServerToken: 'a'.repeat(32),
      includeParamDescriptions: true,
      retryOnServerError: false,
    },
  } as GenerateRequest;
  return generateMcp(req);
}

const file = (files: GeneratedFile[], path: string): string => files.find((f) => f.path === path)!.content;

/** Every token of a TypeScript source: identifiers outside literals are code. */
function tokens(source: string): { kind: ts.SyntaxKind; text: string }[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const out: { kind: ts.SyntaxKind; text: string }[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    out.push({ kind, text: scanner.getTokenValue() ?? scanner.getTokenText() });
  }
  return out;
}

describe('generated kit — hostile spec values stay inert', () => {
  const files = generate();

  it('no spec value becomes code in any generated TypeScript file', () => {
    for (const f of files.filter((x) => x.path.endsWith('.ts'))) {
      const code = tokens(f.content).filter((t) => t.kind === ts.SyntaxKind.Identifier && t.text === MARK);
      expect(code, f.path).toEqual([]);
    }
  });

  it('the tool description and path are restored exactly as string values', () => {
    const strings = tokens(file(files, 'src/tools.ts'))
      .filter((t) => t.kind === ts.SyntaxKind.StringLiteral)
      .map((t) => t.text);
    expect(strings).toContain(DESCRIPTION);
    expect(strings).toContain(PATH);
  });

  it('the API key header name is restored exactly as a string value', () => {
    const strings = tokens(file(files, 'src/http-client.ts'))
      .filter((t) => t.kind === ts.SyntaxKind.StringLiteral)
      .map((t) => t.text);
    expect(strings).toContain(HEADER);
  });

  it('package.json stays valid JSON and gains no install script', () => {
    const pkg = JSON.parse(file(files, 'package.json'));
    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.x).toBeUndefined();
  });

  it('a spec value cannot add a line to Dockerfile, docker-compose.yml or .env.example', () => {
    for (const path of ['Dockerfile', 'docker-compose.yml', '.env.example']) {
      const injected = file(files, path)
        .split('\n')
        .filter((line) => line.includes(MARK) && !line.trimStart().startsWith('#'));
      expect(injected, path).toEqual([]);
    }
  });
});

describe('config schema — API key header name', () => {
  const base = {
    mcpName: 'evil-api',
    baseUrl: 'https://api.example.com',
    hosting: 'self',
    mode: 'both',
    includeParamDescriptions: true,
    retryOnServerError: false,
  };

  it('accepts a regular HTTP header name', () => {
    const ok = sliceConfigSchema.safeParse({ ...base, upstreamAuth: { type: 'apiKey', headerName: 'X-Shopify-Access-Token' } });
    expect(ok.success).toBe(true);
  });

  it('rejects quotes, backslashes, spaces and line breaks', () => {
    for (const headerName of [HEADER, 'X\\Key', 'X Key', 'X-Key\nRUN x', '"X"']) {
      const res = sliceConfigSchema.safeParse({ ...base, upstreamAuth: { type: 'apiKey', headerName } });
      expect(res.success, headerName).toBe(false);
    }
  });
});

describe('hosted runtime dependency', () => {
  it('the MCP SDK is a production dependency (the hosted /m/:id runtime imports it)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
    expect(pkg.devDependencies?.['@modelcontextprotocol/sdk']).toBeUndefined();
  });
});
