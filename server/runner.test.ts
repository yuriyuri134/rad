import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approveComponentVersion,
  computeRunHashes,
  detectRuntimeEnvironment,
  ensureWorkspaceInitialized,
  forkComponentVersion,
  INITIAL_SINGLET_SPEC,
  verifyRunIntegrity,
} from './storage.ts';
import {
  runComponentSelfCheck,
  runEvaluatorComponent,
  runOptimizerComponent,
  runSolverComponent,
} from './runner.ts';
import { traceOpticalSystem } from '../src/core/optics.ts';

test('Security hygiene: server/runner.ts must not import node:vm', () => {
  const runnerSrc = fs.readFileSync(path.resolve(process.cwd(), 'server', 'runner.ts'), 'utf8');
  assert.equal(runnerSrc.includes('node:vm'), false);
  assert.ok(runnerSrc.includes('execFile'));
});

test('Forked evaluator blocks until 64-char SHA-256 hash approved, passes selfCheck, refuses insufficient_artifacts, and catches disk tampering', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-runner-test-'));
  ensureWorkspaceInitialized(tmpWs);
  const testVer = `v0.99-test-${Date.now()}`;
  const modifiedEvalCode = `
export function evaluate(rawArtifacts, spec, params) {
  if (typeof rawArtifacts?.mtf30LpMm !== 'number') {
    return {
      passed: false,
      status: 'insufficient_artifacts',
      lossScore: null,
      summary: '缺少 mtf30LpMm，拒绝推测',
      checks: [],
      uncertainties: ['缺少字段'],
      missingArtifacts: ['mtf30LpMm']
    };
  }
  return {
    passed: false,
    status: 'fail',
    lossScore: 999,
    summary: 'Strict test evaluator rejects singlet chromatic shift ' + rawArtifacts.axialChromaticShiftMm,
    checks: [{ criterion: 'Test Check', measured: String(rawArtifacts.axialChromaticShiftMm), threshold: '<= 0.01', passed: false }],
    uncertainties: ['Test uncertainty']
  };
}
export function selfCheck(params) {
  const missing = evaluate({ paraxialEflMm: 100 }, { targetEflMm: 100 }, params);
  return { passed: missing.status === 'insufficient_artifacts', summary: 'selfCheck ok' };
}
`;

  try {
    const forkedDossier = forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: testVer,
        changeSummary: 'Unit test strict fork',
        codeContent: modifiedEvalCode,
        updatedParams: { maxRmsUm: 10 },
      },
      tmpWs,
    );

    assert.equal(forkedDossier.codeSecurityReview.status, 'unreviewed_modified');
    assert.equal(forkedDossier.selfCheck.status, 'unrun');
    const verRec = forkedDossier.versions.find((v) => v.version === testVer)!;
    assert.equal(verRec.codeHash.length, 64);
    assert.equal(verRec.lifecycle, 'draft');

    const trace = traceOpticalSystem(INITIAL_SINGLET_SPEC);

    // Must refuse unapproved modified code
    await assert.rejects(
      () =>
        runEvaluatorComponent({
          evaluatorId: 'eval-rms-spot',
          evaluatorVersion: testVer,
          rawArtifacts: trace,
          spec: INITIAL_SINGLET_SPEC,
          workspaceDir: tmpWs,
        }),
      /安全审查拦截/,
    );

    // Approve 64-char hash, run selfCheck, then execute evaluate
    const approved = approveComponentVersion('eval-rms-spot', testVer, 'test-reviewer', tmpWs);
    assert.equal(approved.codeSecurityReview.status, 'user_approved_hash');
    assert.equal(approved.codeSecurityReview.approvedHash?.length, 64);

    const checked = await runComponentSelfCheck('eval-rms-spot', testVer, tmpWs);
    assert.equal(checked.dossier.selfCheck.status, 'passed');
    assert.equal(checked.dossier.selfCheck.checkedCodeHash, approved.codeSecurityReview.approvedHash);

    const verdict = await runEvaluatorComponent({
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: testVer,
      rawArtifacts: trace,
      spec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.lossScore, 999);
    assert.equal(verdict.evaluatorVersion, testVer);
    assert.equal(verdict.evaluatorCodeHash.length, 64);

    // Missing artifact check: refuse to guess!
    const incompleteArtifacts = { ...trace } as Record<string, unknown>;
    delete incompleteArtifacts.mtf30LpMm;
    const refused = await runEvaluatorComponent({
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: testVer,
      rawArtifacts: incompleteArtifacts as unknown as typeof trace,
      spec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.equal(refused.status, 'insufficient_artifacts');
    assert.equal(refused.lossScore, null);
    assert.deepEqual(refused.missingArtifacts, ['mtf30LpMm']);

    // Simulate Rad directly editing the file on disk without updating dossier
    const codeFilePath = path.join(tmpWs, 'components', 'eval-rms-spot', testVer, 'impl.mjs');
    fs.appendFileSync(codeFilePath, '\n// external disk edit\n', 'utf8');
    await assert.rejects(
      () =>
        runEvaluatorComponent({
          evaluatorId: 'eval-rms-spot',
          evaluatorVersion: testVer,
          rawArtifacts: trace,
          spec: INITIAL_SINGLET_SPEC,
          workspaceDir: tmpWs,
        }),
      /安全审查拦截|哈希/,
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Optimizer runs via execFile harness, Optiland solver reports container reality honestly, and SHA-256 run tamper detection works', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-runner-opt-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const trace = traceOpticalSystem(INITIAL_SINGLET_SPEC);

    const optRes = await runOptimizerComponent({
      optimizerId: 'opt-nelder-mead',
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: 'v0.1',
      solverId: 'solver-ts-preview',
      initialSpec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.ok(optRes.history.length >= 2);
    assert.ok(
      Math.abs(optRes.bestTrace.paraxialEflMm - 100) <= Math.abs(trace.paraxialEflMm - 100) + 0.5,
    );

    // If optiland is absent in container, solver-optiland-python MUST fail honestly rather than faking TS output
    const checkOpt = await runComponentSelfCheck('solver-optiland-python', undefined, tmpWs);
    if (checkOpt.dossier.selfCheck.status === 'env_unavailable') {
      await assert.rejects(
        () => runSolverComponent('solver-optiland-python', INITIAL_SINGLET_SPEC, tmpWs),
        /optiland|Python/i,
      );
    }

  // Full 64-char SHA-256 run integrity verification & tamper detection
  const runtimeEnv = detectRuntimeEnvironment();
  const composition = {
    pattern: 'solve_and_evaluate',
    parts: [
      {
        slot: 'optical_solver',
        componentId: 'solver-ts-preview',
        componentName: 'preview',
        kind: 'optical_solver',
        version: 'v0.1',
        codeHash: 'e'.repeat(64),
        paramsSnapshot: {},
      },
    ],
  };
  const createdAt = '2026-01-01T00:00:00.000Z';
  const hashes = computeRunHashes({
    id: 'run-test',
    sequenceNumber: 1,
    createdAt,
    parentRunId: null,
    branchLabel: 'test',
    intent: 'test',
    mode: 'solve_only',
    seed: 42,
    runtimeEnv,
    composition,
    systemBefore: INITIAL_SINGLET_SPEC,
    systemAfter: INITIAL_SINGLET_SPEC,
    rawArtifactsBefore: trace,
    rawArtifactsAfter: trace,
  });
  assert.equal(hashes.inputHash.length, 64);
  assert.equal(hashes.rawArtifactsHash.length, 64);
  assert.equal(hashes.recordIntegrityHash.length, 64);

  const validRun = {
    id: 'run-test',
    sequenceNumber: 1,
    createdAt,
    parentRunId: null,
    branchLabel: 'test',
    intent: 'test',
    mode: 'solve_only' as const,
    seed: 42,
    runtimeEnv,
    composition,
    systemBefore: INITIAL_SINGLET_SPEC,
    systemAfter: INITIAL_SINGLET_SPEC,
    rawArtifactsBefore: trace,
    rawArtifactsAfter: trace,
    optimizationTrace: [],
    evaluations: [],
    ...hashes,
    executionMs: 1,
    status: 'completed' as const,
  };
  assert.equal(verifyRunIntegrity(validRun), 'verified');

  const tamperedRun = {
    ...validRun,
    rawArtifactsAfter: { ...trace, rmsSpotRadiusUm: trace.rmsSpotRadiusUm + 0.01 },
  };
  assert.equal(verifyRunIntegrity(tamperedRun), 'tampered');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
