/*
  Express middleware implementing the x402-bch payment flow.
  Provides helpers to compute route patterns and validate payment payloads.
*/

const DEFAULT_NETWORK = 'bch'
const DEFAULT_ASSET = '0x0000000000000000000000000000000000000001'
const DEFAULT_MIN_AMOUNT = 1000

/**
 * Normalizes the routes configuration into regex matchers.
 * Supports both shorthand (price-only) and verbose route definitions.
 *
 * @param {Record<string, any>} routes
 * @returns {Array<{ verb: string, pattern: RegExp, config: any }>}
 */
export function computeRoutePatterns (routes = {}) {
  const normalizedRoutes = Object.fromEntries(
    Object.entries(routes)
      .map(([pattern, value]) => {
        if (pattern === 'network') return null

        const normalizedValue = (typeof value === 'string' || typeof value === 'number')
          ? { price: value, network: routes.network || DEFAULT_NETWORK }
          : { network: routes.network || DEFAULT_NETWORK, ...value }

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
 * Builds the payment requirements object for the current request.
 *
 * @param {string} payTo
 * @param {any} routeConfig
 * @param {import('express').Request} req
 * @returns {Array<Record<string, any>>}
 */
function buildPaymentRequirements (payTo, routeConfig, req) {
  const minAmountRequired = resolveMinAmountRequired(routeConfig)
  const network = routeConfig.network || DEFAULT_NETWORK
  const {
    description = '',
    mimeType = '',
    maxTimeoutSeconds = 60,
    discoverable = true,
    asset = DEFAULT_ASSET,
    extra = {},
    outputSchema
  } = routeConfig.config || {}

  const resource = typeof routeConfig?.config?.resource === 'string'
    ? routeConfig.config.resource
    : `${req.protocol}://${req.headers.host}${req.path}`

  const requirements = {
    scheme: 'utxo',
    network,
    minAmountRequired: String(minAmountRequired),
    resource,
    description,
    mimeType,
    payTo,
    maxTimeoutSeconds,
    asset,
    outputSchema: outputSchema || {
      input: {
        type: 'http',
        method: req.method.toUpperCase(),
        discoverable
      }
    },
    extra
  }

  return [requirements]
}

/**
 * Parses and validates the BCH payment header (JSON string).
 *
 * @param {string} headerValue
 * @param {number} x402Version
 * @returns {Record<string, any>}
 */
function decodePaymentHeader (headerValue, x402Version) {
  const decodedPayment = JSON.parse(headerValue)
  const requiredFields = ['x402Version', 'scheme', 'network', 'payload']

  for (const field of requiredFields) {
    if (decodedPayment[field] == null) {
      throw new Error(`Missing required field in payment payload: ${field}`)
    }
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

  const x402Version = 1
  const routePatterns = computeRoutePatterns(routes)

  return async function paymentMiddlewareHandler (req, res, next) {
    const matchingRoute = findMatchingRoute(routePatterns, req.path, req.method)
    if (!matchingRoute) return next()

    const paymentRequirements = buildPaymentRequirements(payTo, matchingRoute.config, req)
    const paymentHeader = req.header('X-PAYMENT')

    if (!paymentHeader) {
      res.status(402).json({
        x402Version,
        error: 'X-PAYMENT header is required',
        accepts: paymentRequirements
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
        accepts: paymentRequirements
      })
      return
    }

    const selectedPaymentRequirements = paymentRequirements.find(requirement =>
      requirement.scheme === decodedPayment.scheme &&
      requirement.network === decodedPayment.network
    )

    if (!selectedPaymentRequirements) {
      res.status(402).json({
        x402Version,
        error: 'Unable to find matching payment requirements',
        accepts: paymentRequirements
      })
      return
    }

    try {
      const fetchImpl = resolveFetch(facilitator)
      const verifyUrl = `${facilitator.url}/verify`
      const headers = await resolveFacilitatorHeaders(facilitator)

      const response = await fetchImpl(verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify({
          x402Version,
          paymentPayload: decodedPayment,
          paymentRequirements: selectedPaymentRequirements
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
          accepts: paymentRequirements,
          payer: verificationResult.payer || ''
        })
        return
      }
    } catch (error) {
      res.status(402).json({
        x402Version,
        error: error.message || 'Payment verification failed',
        accepts: paymentRequirements
      })
      return
    }

    next()
  }
}

export default paymentMiddleware
