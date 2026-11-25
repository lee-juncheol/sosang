import test from 'node:test'
import assert from 'node:assert/strict'
import { cameraLutName, contactContext, isApp, osName, SERVER_ORIGIN, serverUrl, usageReport, usageSupport } from '../src/platform.ts'

test('the website build keeps same-origin paths and is not the app', () => {
  assert.equal(SERVER_ORIGIN, '')
  assert.equal(isApp(), false)
  assert.equal(serverUrl('/catalog.json'), '/catalog.json')
  assert.equal(serverUrl(undefined), undefined)
  assert.equal(serverUrl('blob:abc'), 'blob:abc')
})

test('camera Library names are printable ASCII up to 95 characters', () => {
  assert.equal(cameraLutName('Portra400_2383STD.cube'), 'Portra400_2383STD.cube')
  assert.equal(cameraLutName('필름 STD.cube'), '__ STD.cube')
  assert.equal(cameraLutName('x'.repeat(120)).length, 95)
})

test('the contact form names the OS from the user agent without guessing', () => {
  assert.equal(osName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), 'macOS')
  assert.equal(osName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0'), 'Windows')
  assert.equal(osName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iOS')
  assert.equal(osName('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'Android')
  assert.equal(osName('Mozilla/5.0 (X11; Linux x86_64)'), 'Linux')
  assert.equal(osName('curl/8.0'), undefined)
})

test('the website sends its context without a version or a camera', async () => {
  assert.deepEqual(await contactContext('ko'), { source: 'web', locale: 'ko', ...(osName(navigator.userAgent) ? { os: osName(navigator.userAgent) } : {}) })
})

test('usage reports carry only the body, the result and the app version', () => {
  const camera = { manufacturer: 'Panasonic', model: 'DC-S5M2', firmware: '3.0', writeSupported: false, writeExperimental: true }
  assert.deepEqual(usageReport('camera_list_luts', 'ok', 6412.4, camera, '0.1.9', 'Windows'),
    { event: 'list', model: 'DC-S5M2', firmware: '3.0', support: 'experimental', result: 'ok', ms: 6412, version: '0.1.9', os: 'Windows' })
  assert.deepEqual(usageReport('camera_status', 'no_camera', 900, null, '0.1.9', undefined),
    { event: 'status', model: '', firmware: '', support: '', result: 'no_camera', ms: 900, version: '0.1.9' })
  assert.equal(usageReport('courier_list', 'ok', 1, camera, '0.1.9', 'macOS'), null)
  assert.equal(usageSupport({ writeSupported: true, writeExperimental: false }), 'supported')
  assert.equal(usageSupport({ writeSupported: false, writeExperimental: false }), 'unsupported')
})
