/*
  Express middleware implementing the x402-bch payment flow.
  Provides helpers to compute route patterns and validate payment payloads.
*/

const DEFAULT_NETWORK = 'bip122:000000000000000000651ef99cb9fcbe' // BCH mainnet CAIP-2 format
const DEFAULT_ASSET = '0x0000000000000000000000000000000000000001'
const DEFAULT_MIN_AMOUNT = 1000
const X402_VERSION = 2

/**
 * Normalizes network identifiers to CAIP-2 format.
 * Supports backward compatibility with 'bch' format.
 *
 * @param {string} network - Network identifier (can be 'bch' or CAIP-2 format)
 * @returns {string} CAIP-2 formatted network identifier
 */
function normalizeNetwork (network) {
  if (!network || network === 'bch') {
    return 'bip122:000000000000000000651ef99cb9fcbe' // BCH mainnet
  }
  // Already in CAIP-2 format or custom format
  return network
}

/**
 * Normalizes the routes configuration into regex matchers.
 * Supports both shorthand (price-only) and verbose route definitions.
 *
 * @param {Record<string, any>} routes
 * @returns {Array<{ verb: string, pattern: RegExp, config: any }>}
 */
export function computeRoutePatterns (routes = {}) {
  const defaultNetwork = normalizeNetwork(routes.network || DEFAULT_NETWORK)

  const normalizedRoutes = Object.fromEntries(
    Object.entries(routes)
      .map(([pattern, value]) => {
        if (pattern === 'network') return null

        const normalizedValue = (typeof value === 'string' || typeof value === 'number')
          ? { price: value, network: defaultNetwork }
          : { network: defaultNetwork, ...value }

        // Normalize network in route config if it was overridden
        if (normalizedValue.network) {
          normalizedValue.network = normalizeNetwork(normalizedValue.network)
        }

        return [pattern, normalizedValue]
      })
      .filter(Boolean)
  )

  return Object.entries(normalizedRoutes).map(([pattern, routeConfig]) => {
    const parts = pattern.includes(' ') ? pattern.split(/\s+/) : ['*', pattern]
    const verb = (parts[0] || '*').toUpperCase()
    const path = parts[1] || parts[0]

    if (!path) throw new Error(`Invalid route pattern: ${pattern}`)

    const regexPattern = `^${
      path
        .replace(/[$()+.?^{|}]/g, '\\$&')
        .replace(/\*/g, '.*?')
        .replace(/\[([^\]]+)\]/g, '[^/]+')
        .replace(/\//g, '\\/')
    }$`

    return {
      verb,
      pattern: new RegExp(regexPattern, 'i'),
      config: routeConfig
    }
  })
}

/**
 * Attempts to match the incoming request to a configured route definition.
 *
 * @param {ReturnType<typeof computeRoutePatterns>} routePatterns
 * @param {string} path
 * @param {string} method
 * @returns {{ verb: string, pattern: RegExp, config: any } | undefined}
 */
export function findMatchingRoute (routePatterns, path, method) {
  let normalizedPath

  try {
    const pathWithoutQuery = path.split(/[?#]/)[0]
    const decodedPath = decodeURIComponent(pathWithoutQuery)
    normalizedPath = decodedPath
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/(.+?)\/+$/, '$1')
  } catch {
    return undefined
  }

  const candidates = routePatterns.filter(({ pattern, verb }) => {
    const matchesPath = pattern.test(normalizedPath)
    const matchesVerb = verb === '*' || method.toUpperCase() === verb
    return matchesPath && matchesVerb
  })

  if (candidates.length === 0) return undefined

  return candidates.reduce((a, b) =>
    b.pattern.source.length > a.pattern.source.length ? b : a
  )
}

/**
 * Derives the minimum satoshis required for a route.
 *
 * @param {any} routeConfig
 * @returns {number}
 */
function resolveMinAmountRequired (routeConfig = {}) {
  if (routeConfig.minAmountRequired != null) {
    const minAmount = Number(routeConfig.minAmountRequired)
    if (!Number.isFinite(minAmount) || minAmount <= 0) {
      throw new Error('minAmountRequired must be a positive number')
    }
    return Math.floor(minAmount)
  }

  const { price } = routeConfig

  if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
    return Math.floor(price)
  }

  if (typeof price === 'string') {
    const trimmed = price.trim()

    const numeric = Number(trimmed.replace(/[^0-9.]/g, ''))
    if (Number.isFinite(numeric) && numeric > 0) {
      if (/sat(s|oshis)?$/i.test(trimmed) || /^[0-9]+$/u.test(trimmed)) {
        return Math.floor(numeric)
      }
    }
  }

  return DEFAULT_MIN_AMOUNT
}

/**
 * Ensures we have a fetch implementation.
 *
 * @param {any} facilitator
 * @returns {typeof fetch}
 */
function resolveFetch (facilitator = {}) {
  const fetchImpl = facilitator.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required for facilitator verification')
  }
  return fetchImpl
}

/**
 * Resolves facilitator headers for the verify request.
 *
 * @param {any} facilitator
 * @returns {Promise<Record<string, string>>}
 */
async function resolveFacilitatorHeaders (facilitator = {}) {
  let headers = { ...(facilitator.verifyHeaders || {}) }

  if (typeof facilitator.createAuthHeaders === 'function') {
    const generated = await facilitator.createAuthHeaders()
    if (generated?.verify) {
      headers = { ...headers, ...generated.verify }
    }
  }

  return headers
}

/**
 * Builds the payment requirements and resource info for the current request (v2 format).
 *
 * @param {string} payTo
 * @param {any} routeConfig
 * @param {import('express').Request} req
 * @returns {{ resourceInfo: Record<string, any>, paymentRequirements: Array<Record<string, any>> }}
 */
function buildPaymentRequirements (payTo, routeConfig, req) {
  const amount = resolveMinAmountRequired(routeConfig)
  const networkInput = routeConfig.network || DEFAULT_NETWORK
  const network = normalizeNetwork(networkInput)
  const {
    description = '',
    mimeType = '',
    maxTimeoutSeconds = 60,
    asset = DEFAULT_ASSET,
    extra = {}
  } = routeConfig.config || {}

  const resourceUrl = typeof routeConfig?.config?.resource === 'string'
    ? routeConfig.config.resource
    : `${req.protocol}://${req.headers.host}${req.path}`

  // ResourceInfo object (separated from PaymentRequirements in v2)
  const resourceInfo = {
    url: resourceUrl,
    description,
    mimeType
  }

  // PaymentRequirements (v2 format - no resource, description, mimeType)
  const requirements = {
    scheme: 'utxo',
    network,
    amount: String(amount),
    payTo,
    maxTimeoutSeconds,
    asset,
    extra
  }

  return {
    resourceInfo,
    paymentRequirements: [requirements]
  }
}

/**
 * Parses and validates the BCH payment header (JSON string) for v2 format.
 *
 * @param {string} headerValue
 * @param {number} x402Version
 * @returns {Record<string, any>}
 */
function decodePaymentHeader (headerValue, x402Version) {
  const decodedPayment = JSON.parse(headerValue)

  // V2 structure: x402Version, accepted (required), payload (required)
  const requiredFields = ['x402Version', 'accepted', 'payload']

  for (const field of requiredFields) {
    if (decodedPayment[field] == null) {
      throw new Error(`Missing required field in payment payload: ${field}`)
    }
  }

  // Validate accepted object has required fields
  if (!decodedPayment.accepted.scheme || !decodedPayment.accepted.network) {
    throw new Error('Missing required field in payment payload accepted object: scheme or network')
  }

  decodedPayment.x402Version = x402Version
  return decodedPayment
}

/**
 * Middleware factory for BCH x402 payments.
 *
 * @param {string} payTo
 * @param {Record<string, any>} routes
 * @param {Record<string, any>} facilitator
 * @returns {import('express').RequestHandler}
 */
export function paymentMiddleware (payTo, routes = {}, facilitator = {}) {
  if (!payTo) throw new Error('payTo is required')

  const x402Version = X402_VERSION
  const routePatterns = computeRoutePatterns(routes)

  return async function paymentMiddlewareHandler (req, res, next) {
    const matchingRoute = findMatchingRoute(routePatterns, req.path, req.method)
    if (!matchingRoute) return next()

    // Log the intercepted request
    const clientIp = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown'
    const endpoint = `${req.method} ${req.path}`
    console.log(`[x402-bch-express] Intercepted request from ${clientIp} to ${endpoint}`)

    const { resourceInfo, paymentRequirements } = buildPaymentRequirements(payTo, matchingRoute.config, req)
    const paymentHeader = req.header('PAYMENT-SIGNATURE')

    if (!paymentHeader) {
      res.status(402).json({
        x402Version,
        error: 'PAYMENT-SIGNATURE header is required',
        resource: resourceInfo,
        accepts: paymentRequirements,
        extensions: {}
      })
      return
    }

    let decodedPayment
    try {
      decodedPayment = decodePaymentHeader(paymentHeader, x402Version)
    } catch (error) {
      res.status(402).json({
        x402Version,
        error: error.message || 'Invalid or malformed payment header',
        resource: resourceInfo,
        accepts: paymentRequirements,
        extensions: {}
      })
      return
    }

    const selectedPaymentRequirements = paymentRequirements.find(requirement =>
      requirement.scheme === decodedPayment.accepted?.scheme &&
      requirement.network === decodedPayment.accepted?.network
    )

    if (!selectedPaymentRequirements) {
      res.status(402).json({
        x402Version,
        error: 'Unable to find matching payment requirements',
        resource: resourceInfo,
        accepts: paymentRequirements,
        extensions: {}
      })
      return
    }

    try {
      const fetchImpl = resolveFetch(facilitator)
      const verifyUrl = `${facilitator.url}/verify`
      const headers = await resolveFacilitatorHeaders(facilitator)

      // Construct paymentRequirements for verify request (includes resource fields per spec §7.2)
      const verifyPaymentRequirements = {
        ...selectedPaymentRequirements,
        resource: resourceInfo.url,
        description: resourceInfo.description,
        mimeType: resourceInfo.mimeType
      }

      const response = await fetchImpl(verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify({
          x402Version,
          paymentPayload: decodedPayment,
          paymentRequirements: verifyPaymentRequirements
        })
      })

      if (!response.ok) {
        throw new Error(`Facilitator verification failed: ${response.status} ${response.statusText}`)
      }

      const verificationResult = await response.json()
      if (!verificationResult.isValid) {
        res.status(402).json({
          x402Version,
          error: verificationResult.invalidReason || 'Payment verification failed',
          resource: resourceInfo,
          accepts: paymentRequirements,
          extensions: {},
          payer: verificationResult.payer || ''
        })
        return
      }
    } catch (error) {
      res.status(402).json({
        x402Version,
        error: error.message || 'Payment verification failed',
        resource: resourceInfo,
        accepts: paymentRequirements,
        extensions: {}
      })
      return
    }

    next()
  }
}

export default paymentMiddleware
