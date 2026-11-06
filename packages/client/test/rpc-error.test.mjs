import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorText, rpcOrigin } from '../rpc-error.mjs'

test('an unreachable RPC is named by origin only, never with its path or key', () => {
  const rpc = 'https://eth.example.com/v2/SECRET-KEY?token=also-secret'
  const msg = errorText(Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', shortMessage: 'HTTP request failed.' }), rpc)
  assert.match(msg, /^cannot reach the RPC at https:\/\/eth\.example\.com;/)
  assert.ok(!msg.includes('SECRET') && !msg.includes('secret'))
  assert.match(errorText(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }), 'http://127.0.0.1:9'), /cannot reach the RPC at http:\/\/127\.0\.0\.1:9/)
  assert.match(errorText(Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' }), rpc), /did not answer in time/)
  assert.equal(rpcOrigin('not a url'), 'the configured RPC')
})

test('other errors pass through unchanged', () => {
  assert.equal(errorText(Object.assign(new Error('long'), { shortMessage: 'deposit reverted' })), 'deposit reverted')
  assert.equal(errorText(new Error('only 5 TKA is withdrawable')), 'only 5 TKA is withdrawable')
})
