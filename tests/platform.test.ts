import test from 'node:test'
import assert from 'node:assert/strict'
import { cameraLutName, isApp, SERVER_ORIGIN, serverUrl } from '../src/platform.ts'

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
