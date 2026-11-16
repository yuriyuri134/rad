import test from 'node:test';
import assert from 'node:assert/strict';
import { computeParaxialProperties, refractiveIndex, traceOpticalSystem } from './optics.ts';
import type { OpticalSystemSpec } from './types.ts';

test('Sellmeier refractive index matches Schott N-BK7 catalog values', () => {
  const nd = refractiveIndex('N-BK7', 587.56);
  const nf = refractiveIndex('N-BK7', 486.13);
  const nc = refractiveIndex('N-BK7', 656.27);
  assert.ok(Math.abs(nd - 1.5168) < 0.0002, `Expected n_d ~ 1.5168, got ${nd}`);
  assert.ok(nf > nd && nd > nc, 'Normal dispersion must satisfy nF > nd > nC');
});

test('Paraxial EFL matches analytical thin-lens lensmaker equation', () => {
  const thinSinglet: OpticalSystemSpec = {
    name: 'Thin Biconvex Test',
    description: 'Verification thin lens',
    entrancePupilDiameterMm: 10,
    fieldAnglesDeg: [0],
    wavelengthsNm: [587.56],
    targetEflMm: 96.75,
    focusMode: 'paraxial_d',
    surfaces: [
      { id: 's1', label: 'Front', radiusMm: 100, thicknessMm: 0.01, semiApertureMm: 10, glassAfter: 'N-BK7' },
      { id: 's2', label: 'Back', radiusMm: -100, thicknessMm: 0, semiApertureMm: 10, glassAfter: 'AIR' },
    ],
  };
  const props = computeParaxialProperties(thinSinglet.surfaces, 587.56, 10);
  const nd = refractiveIndex('N-BK7', 587.56);
  const nAir = refractiveIndex('AIR', 587.56);
  const expectedEfl = (100 * nAir) / (2 * (nd - nAir));
  assert.ok(Math.abs(props.eflMm - expectedEfl) < 0.05, `Expected EFL ~ ${expectedEfl}, got ${props.eflMm}`);
});

test('Achromatic doublet significantly reduces axial chromatic shift vs singlet', () => {
  const singlet: OpticalSystemSpec = {
    name: 'N-BK7 Singlet',
    description: 'Uncorrected singlet',
    entrancePupilDiameterMm: 25,
    fieldAnglesDeg: [0],
    wavelengthsNm: [486.13, 587.56, 656.27],
    targetEflMm: 100,
    focusMode: 'paraxial_d',
    surfaces: [
      { id: 's1', label: 'Front', radiusMm: 65, thicknessMm: 5, semiApertureMm: 15, glassAfter: 'N-BK7' },
      { id: 's2', label: 'Back', radiusMm: -220, thicknessMm: 0, semiApertureMm: 15, glassAfter: 'AIR' },
    ],
  };

  const doublet: OpticalSystemSpec = {
    name: 'N-BK7/N-SF11 Doublet',
    description: 'Cemented achromat',
    entrancePupilDiameterMm: 25,
    fieldAnglesDeg: [0],
    wavelengthsNm: [486.13, 587.56, 656.27],
    targetEflMm: 100,
    focusMode: 'paraxial_d',
    surfaces: [
      { id: 's1', label: 'Crown Front', radiusMm: 61.5, thicknessMm: 6.0, semiApertureMm: 15, glassAfter: 'N-BK7' },
      { id: 's2', label: 'Cemented', radiusMm: -62.2, thicknessMm: 3.0, semiApertureMm: 15, glassAfter: 'N-SF11' },
      { id: 's3', label: 'Flint Back', radiusMm: -133.0, thicknessMm: 0, semiApertureMm: 15, glassAfter: 'AIR' },
    ],
  };

  const traceSinglet = traceOpticalSystem(singlet);
  const traceDoublet = traceOpticalSystem(doublet);

  assert.equal(traceSinglet.clippedRayCount, 0);
  assert.equal(traceDoublet.clippedRayCount, 0);
  assert.ok(
    traceDoublet.axialChromaticShiftMm < traceSinglet.axialChromaticShiftMm * 0.25,
    `Doublet chromatic shift (${traceDoublet.axialChromaticShiftMm}mm) should be much smaller than singlet (${traceSinglet.axialChromaticShiftMm}mm)`,
  );
});
