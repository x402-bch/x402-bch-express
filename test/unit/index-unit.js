/*
  Unit tests for the index.js middleware module.
*/

// npm libraries
import { assert } from 'chai'
import sinon from 'sinon'
import cloneDeep from 'lodash.clonedeep'

// Unit under test
import {
  computeRoutePatterns,
  findMatchingRoute,
  paymentMiddleware
} from '../../index.js'

describe('#index.js', () => {
  let sandbox
  let baseRoutes

  const payToAddress = 'bitcoincash:qq123exampleaddress0000000000000000'

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    baseRoutes = cloneDeep({
      network: 'bch',
      'GET /protected': { price: 1500 },
      '/open': 1200
    })
  })

  afterEach(() => sandbox.restore())

  describe('#computeRoutePatterns', () => {
    it('should normalize shorthand route definitions', () => {
      const patterns = computeRoutePatterns(baseRoutes)

      assert.equal(patterns.length, 2)

      const protectedRoute = patterns.find(route => route.verb === 'GET')
      assert.isOk(protectedRoute)
      assert.instanceOf(protectedRoute.pattern, RegExp)
      assert.deepEqual(protectedRoute.config, { network: 'bch', price: 1500 })

      const wildcardRoute = patterns.find(route => route.verb === '*')
      assert.isOk(wildcardRoute)
      assert.deepEqual(wildcardRoute.config, { network: 'bch', price: 1200 })
    })

    it('should throw an error for invalid route pattern', () => {
      const invalidRoutes = {
        ' ': { price: 1000 }
      }

      assert.throws(
        () => computeRoutePatterns(invalidRoutes),
        /Invalid route pattern/
      )
    })
  })

  describe('#findMatchingRoute', () => {
    it('should match route regardless of method case', () => {
      const patterns = computeRoutePatterns(baseRoutes)
      const match = findMatchingRoute(patterns, '/protected', 'get')

      assert.isOk(match)
      assert.equal(match.config.price, 1500)
    })

    it('should return undefined for unmatched routes', () => {
      const patterns = computeRoutePatterns(baseRoutes)
      const match = findMatchingRoute(patterns, '/unknown', 'GET')

      assert.isUndefined(match)
    })

    it('should return the most specific matching route', () => {
      const specificRoutes = {
        network: 'bch',
        'GET /a/*': { price: 900 },
        'GET /a/reports': { price: 1400 }
      }

      const patterns = computeRoutePatterns(specificRoutes)
      const match = findMatchingRoute(patterns, '/a/reports', 'GET')

      assert.isOk(match)
      assert.equal(match.config.price, 1400)
    })

    it('should gracefully handle malformed encoded paths', () => {
      const patterns = computeRoutePatterns(baseRoutes)
      const match = findMatchingRoute(patterns, '/%E0%A4%A', 'GET')

      assert.isUndefined(match)
    })
  })

  describe('#paymentMiddleware', () => {
    function createRequest ({
      path = '/protected',
      method = 'GET',
      protocol = 'http',
      host = 'example.com',
      headers = {}
    } = {}) {
      const lowerCaseHeaders = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
      )

      const headerStub = sandbox.stub()
      headerStub.callsFake(name => lowerCaseHeaders[name.toLowerCase()])

      const reqHeaders = { host }

      return {
        path,
        method,
        protocol,
        headers: reqHeaders,
        header: headerStub
      }
    }

    function createResponse () {
      const res = {
        status: sandbox.stub(),
        json: sandbox.stub()
      }
      res.status.returns(res)
      return res
    }

    const validPaymentPayload = JSON.stringify({
      x402Version: 1,
      scheme: 'utxo',
      network: 'bch',
      payload: { some: 'data' }
    })

    it('should call next when no matching route is found', async () => {
      const middleware = paymentMiddleware(payToAddress, baseRoutes)
      const req = createRequest({ path: '/unmatched' })
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(next.calledOnce)
      assert.isTrue(res.status.notCalled)
      assert.isTrue(res.json.notCalled)
    })

    it('should respond with 402 when X-PAYMENT header is missing', async () => {
      const middleware = paymentMiddleware(payToAddress, baseRoutes)
      const req = createRequest()
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(res.status.calledOnceWithExactly(402))
      const responseBody = res.json.firstCall.args[0]
      assert.equal(responseBody.error, 'X-PAYMENT header is required')
      assert.equal(responseBody.accepts[0].payTo, payToAddress)
      assert.equal(responseBody.accepts[0].minAmountRequired, '1500')
      assert.isTrue(next.notCalled)
    })

    it('should respond with 402 when payment header is malformed JSON', async () => {
      const middleware = paymentMiddleware(payToAddress, baseRoutes)
      const req = createRequest({
        headers: { 'x-payment': '{invalid json' }
      })
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(res.status.calledOnceWithExactly(402))
      const responseBody = res.json.firstCall.args[0]
      assert.match(responseBody.error, /JSON/)
      assert.isTrue(next.notCalled)
    })

    it('should respond with 402 when payment requirements mismatch', async () => {
      const middleware = paymentMiddleware(payToAddress, baseRoutes)
      const req = createRequest({
        headers: {
          'x-payment': JSON.stringify({
            x402Version: 0,
            scheme: 'account',
            network: 'bch',
            payload: {}
          })
        }
      })
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(res.status.calledOnceWithExactly(402))
      const responseBody = res.json.firstCall.args[0]
      assert.equal(responseBody.error, 'Unable to find matching payment requirements')
      assert.isTrue(next.notCalled)
    })

    it('should respond with 402 when facilitator verification rejects', async () => {
      const fetchStub = sandbox.stub().rejects(new Error('network error'))
      const middleware = paymentMiddleware(payToAddress, baseRoutes, {
        url: 'http://facilitator.test',
        fetch: fetchStub
      })
      const req = createRequest({
        headers: { 'x-payment': validPaymentPayload }
      })
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(fetchStub.calledOnce)
      assert.isTrue(res.status.calledOnceWithExactly(402))
      const responseBody = res.json.firstCall.args[0]
      assert.include(responseBody.error, 'network error')
      assert.isTrue(next.notCalled)
    })

    it('should respond with 402 when facilitator returns non-ok response', async () => {
      const fetchStub = sandbox.stub().resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      })
      const middleware = paymentMiddleware(payToAddress, baseRoutes, {
        url: 'http://facilitator.test',
        fetch: fetchStub
      })
      const req = createRequest({
        headers: { 'x-payment': validPaymentPayload }
      })
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(fetchStub.calledOnceWith(
        'http://facilitator.test/verify',
        sinon.match.object
      ))
      assert.isTrue(res.status.calledOnceWithExactly(402))
      const responseBody = res.json.firstCall.args[0]
      assert.include(responseBody.error, 'Facilitator verification failed')
      assert.isTrue(next.notCalled)
    })

    it('should respond with 402 when verification result is invalid', async () => {
      const fetchStub = sandbox.stub().resolves({
        ok: true,
        json: async () => ({
          isValid: false,
          invalidReason: 'insufficient amount',
          payer: 'payer-id'
        })
      })
      const middleware = paymentMiddleware(payToAddress, baseRoutes, {
        url: 'http://facilitator.test',
        fetch: fetchStub
      })
      const req = createRequest({
        headers: { 'x-payment': validPaymentPayload }
      })
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(res.status.calledOnceWithExactly(402))
      const responseBody = res.json.firstCall.args[0]
      assert.equal(responseBody.error, 'insufficient amount')
      assert.equal(responseBody.payer, 'payer-id')
      assert.isTrue(next.notCalled)
    })

    it('should call next when payment verification succeeds', async () => {
      const fetchStub = sandbox.stub().resolves({
        ok: true,
        json: async () => ({ isValid: true })
      })

      const createAuthHeaders = sandbox.stub().resolves({
        verify: { Authorization: 'Bearer token' }
      })

      const middleware = paymentMiddleware(payToAddress, baseRoutes, {
        url: 'http://facilitator.test',
        fetch: fetchStub,
        verifyHeaders: { 'x-custom': 'value' },
        createAuthHeaders
      })

      const req = createRequest({
        protocol: 'https',
        host: 'app.example',
        headers: { 'x-payment': validPaymentPayload }
      })
      const res = createResponse()
      const next = sandbox.stub()

      await middleware(req, res, next)

      assert.isTrue(createAuthHeaders.calledOnce)
      assert.isTrue(fetchStub.calledOnce)
      const [, fetchOptions] = fetchStub.firstCall.args
      assert.equal(fetchOptions.method, 'POST')
      assert.deepInclude(fetchOptions.headers, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'x-custom': 'value'
      })

      const parsedBody = JSON.parse(fetchOptions.body)
      assert.deepEqual(parsedBody.paymentPayload, {
        x402Version: 1,
        scheme: 'utxo',
        network: 'bch',
        payload: { some: 'data' }
      })
      assert.equal(parsedBody.paymentRequirements.payTo, payToAddress)
      assert.equal(parsedBody.paymentRequirements.resource, 'https://app.example/protected')

      assert.isTrue(next.calledOnce)
      assert.isTrue(res.status.notCalled)
      assert.isTrue(res.json.notCalled)
    })
  })
})
