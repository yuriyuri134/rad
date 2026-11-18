import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchitectureMap } from './architectureMap.ts';
import { buildSampleFitsBuffer, extractTanWcs, parseFitsBuffer, pixelToWorldTan } from './fits.ts';
import type { FitsHeaderCard, ResearchStudy, StudyBranch } from './types.ts';

test('extractTanWcs & pixelToWorldTan accurately project IAU RA---TAN / DEC--TAN coordinates', () => {
  const headers: FitsHeaderCard[] = [
    { keyword: 'CRVAL1', value: '180.0', comment: '' },
    { keyword: 'CRVAL2', value: '0.0', comment: '' },
    { keyword: 'CRPIX1', value: '128.5', comment: '' },
    { keyword: 'CRPIX2', value: '128.5', comment: '' },
    { keyword: 'CDELT1', value: String(-0.5155 / 3600), comment: '' },
    { keyword: 'CDELT2', value: String(0.5155 / 3600), comment: '' },
    { keyword: 'CTYPE1', value: 'RA---TAN', comment: '' },
    { keyword: 'CTYPE2', value: 'DEC--TAN', comment: '' },
  ];
  const wcs = extractTanWcs(headers, 256, 256);
  assert.ok(wcs, 'Expected TAN WCS to be extracted');
  assert.ok(Math.abs(wcs.pixelScaleArcsec - 0.5155) < 1e-4);

  // At CRPIX (0-based = 127.5, 127.5), RA/Dec must equal CRVAL (180, 0)
  const center = pixelToWorldTan(127.5, 127.5, wcs);
  assert.ok(Math.abs(center.raDeg - 180.0) < 1e-6);
  assert.ok(Math.abs(center.decDeg - 0.0) < 1e-6);

  // Moving +100 px in X moves -100 * 0.5155 arcsec in RA
  const offset = pixelToWorldTan(227.5, 127.5, wcs);
  const expectedDeltaRa = (-100 * 0.5155) / 3600;
  assert.ok(Math.abs(offset.raDeg - (180.0 + expectedDeltaRa)) < 1e-5);
});

test('parseFitsBuffer supports configurable maxSources=64 for dense fields', () => {
  const buf = buildSampleFitsBuffer({ width: 96, height: 96, objectName: 'TEST_FIELD' });
  const parsed = parseFitsBuffer(buf, 'TEST_FIELD.fits', { maxSources: 64 });
  assert.ok(parsed.detectedSources.length >= 4);
  assert.equal(parsed.detectedSources[0].extractor, 'ts_aperture');
});

test('buildArchitectureMap dynamically discovers repo files and maps v2 studies/branches/runtime', () => {
  const mockStudy: ResearchStudy = {
    id: 'study-wf-rc-1000',
    slug: 'wf-rc-1000',
    title: 'WF-RC-1000',
    domain: 'astronomy',
    status: 'active',
    provenanceTier: 'external_verified_import',
    problemStatement: 'test',
    backgroundContext: 'test',
    objectives: [],
    criteria: [],
    openQuestions: [],
    stages: [],
    adoptedBranchId: 'branch-p2-s3',
    adoptedReason: 'ok',
    createdAt: '2026-04-02T00:00:00Z',
    updatedAt: '2026-04-02T00:00:00Z',
  };
  const mockBranch: StudyBranch = {
    id: 'branch-p2-s3',
    studyId: 'study-wf-rc-1000',
    parentBranchId: null,
    name: 'S3',
    shortCode: 'S3',
    hypothesis: 'test',
    status: 'adopted',
    provenanceTier: 'external_verified_import',
    summary: 'test',
    metrics: {},
    artifactIds: [],
    executionIds: [],
    createdAt: '2026-04-02T00:00:00Z',
    updatedAt: '2026-04-02T00:00:00Z',
    createdBy: 'test',
  };

  const map = buildArchitectureMap({
    rootDir: process.cwd(),
    components: [],
    runs: [],
    runtimeEnv: {
      hostMode: 'local_python_ready',
      nodeVersion: process.version,
      pythonVersion: '3.12.0',
      pythonOkForOptiland: true,
      optilandVersion: '0.6.3',
      numpyVersion: '2.5.5',
      scipyVersion: '1.18.1',
      platform: process.platform,
    },
    studies: [mockStudy],
    branches: [mockBranch],
    pythonEnvDetails: {
      executable: '/tmp/p2_venv/bin/python',
      packages: { optiland: '0.6.3', astropy: '8.0.2' },
    },
  });

  const ids = new Set(map.nodes.map((n) => n.id));
  assert.ok(ids.has('scope:studies'), 'Expected scope:studies node');
  assert.ok(ids.has('study:study-wf-rc-1000'), 'Expected WF-RC-1000 study node');
  assert.ok(ids.has('branch:branch-p2-s3'), 'Expected S3 branch node');
  assert.ok(ids.has('runtime:python-scientific-env'), 'Expected discovered Python host node');
  assert.ok(ids.has('mod:python/workbench_p2_runner.py'), 'Expected dynamic recursive file discovery of python runner');
});
