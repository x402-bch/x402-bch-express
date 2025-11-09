# x402-bch-express

Reusable Express middleware that implements the BCH flavor of the x402 protocol. It inspects incoming requests, advertises BCH pricing metadata when the `X-PAYMENT` header is missing, and forwards payment payloads to a facilitator for verification before your route handlers execute.

## Installation

```bash
npm install x402-bch-express
# or
yarn add x402-bch-express
```

Node.js 18+ is recommended; Node 20+ ships `fetch` globally, but you can supply your own implementation through the facilitator config if needed.

## Quick Start

```js
import express from 'express'
import { paymentMiddleware } from 'x402-bch-express'

const app = express()

app.use(
  paymentMiddleware(
    'bitcoincash:qqlrzp23w08434twmvr4fxw672whkjy0py26r63g3d',
    {
      // Route-level configuration uses "<VERB> </path>" patterns
      'GET /weather': {
        minAmountRequired: 1000, // satoshis per request
        config: {
          description: 'Access to weather data'
        }
      },
      // Optional default network for all routes (defaults to "bch")
      network: 'bch'
    },
    {
      // Facilitator base URL (defaults to http://localhost:4040/facilitator)
      url: process.env.FACILITATOR_URL,
      // Optional: add headers to the verify request
      verifyHeaders: {
        Authorization: `Bearer ${process.env.FACILITATOR_TOKEN}`
      }
    }
  )
)

app.get('/weather', (req, res) => {
  res.json({ report: { weather: 'sunny', temperature: 70 } })
})

app.listen(4021, () => {
  console.log('Server listening on http://localhost:4021')
})
```

### Request Flow

1. **Missing header** → Middleware responds with HTTP `402` and a JSON body describing acceptable BCH payment requirements.
2. **Client retries** → Client attaches an `X-PAYMENT` header containing BCH authorization metadata (per the `x402-bch` spec).
3. **Verification** → Middleware calls `${facilitator.url}/verify`; only on `isValid: true` does the request continue to your handler.

## Configuration Reference

### `paymentMiddleware(payTo, routes, facilitator)`

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `payTo` | `string` | ✅ | BCH cash address that receives funding UTXOs. |
| `routes` | `Record<string, RouteConfig>` | ✅ | Route pricing map keyed by `"VERB /path"` (verb optional, defaults to `*`). A top-level `network` key sets the default network (default `"bch"`). |
| `facilitator` | `FacilitatorConfig` | Optional | Controls how the middleware talks to the facilitator service. |

#### Route Config

| Field | Type | Description |
| --- | --- | --- |
| `minAmountRequired` | `number \| string` | Minimum satoshis debited for the request. When omitted, the middleware falls back to heuristics from `price` or the global default (1000 sats). |
| `price` | `number \| string` | Alternate way to express pricing. Numeric values are treated as sats. Strings like `"1000 sats"` are also supported. |
| `config.description` | `string` | Human-readable description returned in the 402 payload. |
| `config.mimeType` | `string` | Optional MIME type of the protected resource. |
| `config.maxTimeoutSeconds` | `number` | Timeout window advertised to clients (default `60`). |
| `config.resource` | `string` | Overrides the auto-generated resource URL. |
| `config.extra` | `object` | Additional metadata passed through to clients. |

#### Facilitator Config

| Field | Type | Description |
| --- | --- | --- |
| `url` | `string` | Base URL for the facilitator (defaults to `http://localhost:4040/facilitator`). |
| `fetch` | `Function` | Custom `fetch` implementation. Useful on Node versions without a global `fetch`. |
| `verifyHeaders` | `Record<string, string>` | Static headers merged into the `/verify` request. |
| `createAuthHeaders` | `() => Promise<{ verify?: Record<string, string> }>` | Async hook to generate per-request headers (e.g., refreshing tokens). |

## Additional Helpers

The package also exports the internal utilities should you need them:

- `computeRoutePatterns(routes)` – Precomputes regex matchers for your route map.
- `findMatchingRoute(routePatterns, path, method)` – Finds the most specific route definition for a request.

## License

[MIT](LICENSE.md)
