import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSampleFitsBuffer, parseFitsBuffer } from './fits.ts';

test('FITS writer produces 2880-byte aligned binary and parser recovers headers + star centroids', () => {
  const buf = buildSampleFitsBuffer({ width: 96, height: 96, objectName: 'M42_CALIB_TEST' });
  assert.equal(buf.byteLength % 2880, 0, 'FITS file must be padded to 2880-byte blocks');

  const parsed = parseFitsBuffer(buf, 'M42_CALIB_TEST.fits');
  assert.equal(parsed.bitpix, -32);
  assert.equal(parsed.width, 96);
  assert.equal(parsed.height, 96);
  assert.equal(parsed.objectName, 'M42_CALIB_TEST');
  assert.ok(Math.abs(parsed.medianSky - 119) < 8, `Expected sky median ~119, got ${parsed.medianSky}`);
  assert.ok(parsed.detectedSources.length >= 4, `Expected >=4 detected stars, got ${parsed.detectedSources.length}`);

  const brightest = parsed.detectedSources[0];
  assert.ok(Math.abs(brightest.xCentroid - 48.3) < 0.2, `Expected brightest X ~ 48.3, got ${brightest.xCentroid}`);
  assert.ok(Math.abs(brightest.yCentroid - 47.7) < 0.2, `Expected brightest Y ~ 47.7, got ${brightest.yCentroid}`);
});

test('FITS parser rejects truncated invalid buffers cleanly', () => {
  assert.throws(() => parseFitsBuffer(new Uint8Array(100), 'bad.fits'), /2880/);
});
