# Token estimator

SLICE shows a "context saved" percentage while the user selects endpoints (selection preview, configuration screen
and success screen). It tells the user how much agent context they spare by exposing a subset of endpoints instead
of the whole API. This document explains how the number is computed, how the formula was calibrated, and its limits.

## Formula

For each endpoint, SLICE estimates the tokens it contributes to the MCP tool declaration
(name, description and Zod input schema). The estimate is a closed-form heuristic with no model call and no
asynchronous work, so the percentage updates on every checkbox toggle.

```
endpointTokens(ep) = 25 + 20 × params + ⌈text.length / 5⌉
```

- `25`: base cost of the tool boilerplate (`server.tool(...)` and the handler skeleton).
- `20 × params`: each parameter entry (`z.string().optional().describe(...)`) costs about 20 tokens.
  `params` counts every parameter, including flattened request-body fields.
- `⌈text.length / 5⌉`: `text` is the endpoint description, or its label when there is no description;
  about 5 characters per token for English and code under `cl100k_base`.

```
saved % = round((1 − selectedTokens / totalTokens) × 100)
```

`totalTokens` sums every endpoint of the spec, `selectedTokens` only the selected ones. An empty spec reports 100%.

The implementation is `src/shared/token-estimator.ts` (`estimateEndpointTokens`, `estimateSpecTokens`,
`computeEconomy`). It is shared code and runs in the browser.

## Calibration

The reference is the `cl100k_base` token count (via `js-tiktoken`) of a rendered tool declaration for each endpoint:
`server.tool(<id>, <description, at most 500 characters>, { <one Zod line per parameter> }, handler)`.
SLICE calibrates against this rendered declaration, not against the raw spec text, which would measure the wrong thing.

The three coefficients were chosen by grid search over the four fixtures in `fixtures/calibration/`
(`base` from 20 to 80 in steps of 5, `perParam` from 0 to 20 in steps of 1, `charsPerToken` from 2 to 6 in steps of 0.25),
keeping the set with the smallest worst-case deviation.

| Fixture | Endpoints | Reference tokens | Estimate | Deviation |
|---|---:|---:|---:|---:|
| `custom-10.yaml` | 10 | 885 | 877 | −0.9% |
| `shopify-50.yaml` | 50 | 2 270 | 2 226 | −1.9% |
| `github-100.yaml` | 100 | 11 243 | 11 087 | −1.4% |
| `stripe-200.yaml` | 200 | 22 063 | 22 631 | +2.6% |

Worst-case deviation: 2.6%, against a tolerance of ±15%.

### Re-running the calibration

```bash
pnpm tsx scripts/calibrate-tokens.ts
```

The script parses every fixture in `fixtures/calibration/`, runs the grid search, prints the best coefficients and the
per-fixture deviation, and exits with a non-zero code if the best set misses ±15%. It does not modify the source:
new coefficients have to be copied into `src/shared/token-estimator.ts` by hand.

### Test guard

`src/server/services/token-estimator.calibration.test.ts` runs in the normal test suite (`pnpm test`).
It checks that the frozen coefficients stay within ±15% of the reference on each calibration fixture.
A change to the parser, the normaliser or the coefficients that pushes any fixture past the tolerance fails the build;
the script above is then the place to re-tune.

## Limits

- **English bias.** `cl100k_base` is less efficient on non-Latin scripts and accented text. Specs with descriptions
  mostly in other languages may come out a few percent higher.
- **Reference tool name.** The reference declaration uses the endpoint id (`"GET /products"`) as the tool name,
  whereas the generated server uses the snake_case label (`list_products`). Both are short strings; very long paths or
  labels can make the two diverge.
- **Nested schemas are not weighted.** Every parameter costs the same, whether it is a scalar or a deeply nested object
  body field. Endpoints with large structured request bodies can be under-estimated.
- **Heuristic, not a promise.** 2.6% on four fixtures does not guarantee 2.6% on every real-world spec.
  The ±15% bound is what the test suite enforces, and only on the calibration fixtures.

## If the tolerance is exceeded

If a new fixture pushes the deviation past 15%, change the approach rather than over-fitting the coefficients to the
calibration set: for example, count tokens on the server with a real tokenizer.
