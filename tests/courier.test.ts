import test from 'node:test'
import assert from 'node:assert/strict'
import { folderName, formatExposure, formatLevel, roundLevel, sortPhotos } from '../src/courierUtils.ts'
import { levelZoom, type CourierPhoto } from '../src/platform.ts'

const photo = (name: string, subfolder: string, modified: number | null): CourierPhoto => ({ path: `/sd/${subfolder}/${name}`, name, subfolder, modified })

test('name order puts top-level files first and compares numbers naturally', () => {
  const list = [photo('P10.JPG', 'DCIM/101_PANA', 1), photo('P9.JPG', 'DCIM/101_PANA', 2), photo('Z.JPG', '', 3), photo('A.JPG', 'DCIM/100_PANA', 4)]
  assert.deepEqual(sortPhotos(list, 'name').map(p => p.name), ['Z.JPG', 'A.JPG', 'P9.JPG', 'P10.JPG'])
})

test('date order is newest first with unknown dates last', () => {
  const list = [photo('a.jpg', '', 10), photo('b.jpg', '', null), photo('c.jpg', '', 30), photo('d.jpg', '', 30)]
  assert.deepEqual(sortPhotos(list, 'date').map(p => p.name), ['c.jpg', 'd.jpg', 'a.jpg', 'b.jpg'])
})

test('level values and exposure read like the camera', () => {
  assert.equal(formatLevel(1.24), '+1.2°')
  assert.equal(formatLevel(-0.04), '0.0°')
  assert.equal(formatLevel(-3), '−3.0°')
  assert.equal(roundLevel(20), 15)
  assert.equal(roundLevel(0.1 + 0.2), 0.3)
  assert.equal(formatExposure([1, 250]), '1/250 s')
  assert.equal(formatExposure([10, 2500]), '1/250 s')
  assert.equal(formatExposure([1, 2]), '1/2 s')
  assert.equal(formatExposure([3, 10]), '0.3 s')
  assert.equal(formatExposure([2, 1]), '2 s')
  assert.equal(folderName('C:\\Photos\\DCIM\\'), 'DCIM')
  assert.equal(folderName('/Volumes/LUMIX/DCIM'), 'DCIM')
})

test('preview zoom matches the saved crop', () => {
  assert.equal(levelZoom(6000, 4000, 0), 1)
  // Same formula as crates/photo-courier level_zoom: |cos| + |sin| * longer/shorter.
  const angle = 5 * Math.PI / 180
  assert.ok(Math.abs(levelZoom(6000, 4000, 5) - (Math.cos(angle) + Math.sin(angle) * 1.5)) < 1e-12)
  assert.equal(levelZoom(4000, 6000, -5), levelZoom(6000, 4000, 5))
})
