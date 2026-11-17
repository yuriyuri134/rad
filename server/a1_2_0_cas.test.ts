import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { traceOpticalSystem } from '../src/core/optics.ts';
import type { ExperimentRun } from '../src/core/types.ts';
import {
  appendRun,
  approveComponentVersion,
  computeRunHashes,
  detectRuntimeEnvironment,
  ensureWorkspaceInitialized,
  forkComponentVersion,
  freezeComponentVersion,
  getComponent,
  getWorkspacePaths,
  INITIAL_SINGLET_SPEC,
  inspectCasBlob,
  listRuns,
  readCasBlob,
  readFrozenComponentSource,
  restoreFrozenComponentWorkspaceFile,
  saveComponentDossier,
  saveComponentDraft,
  sha256,
  verifyRunIntegrity,
} from './storage.ts';
import {
  resolveAndAssertApproved,
  runComponentSelfCheck,
  runEvaluatorComponent,
  runOptimizerComponent,
  runSolverComponent,
} from './runner.ts';

function runHarnessDirect(payload: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number }> {
  const harnessPath = path.resolve(process.cwd(), 'server', 'mjs_harness.mjs');
  return new Promise((resolve) => {
    const proc = execFile('node', [harnessPath], { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: err ? 1 : 0 });
    });
    proc.stdin?.write(JSON.stringify(payload));
    proc.stdin?.end();
  });
}

test('A1.2.0: Frozen CAS protects against VS Code disk edits & deletions, restores workspace while preserving Draft, and keeps ExperimentRun intact', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-cas-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const trace = traceOpticalSystem(INITIAL_SINGLET_SPEC);

    const frozenOriginalCode = `// Frozen original v0.2-cas
export function evaluate(_rawArtifacts, _spec, params) {
  return {
    passed: false,
    status: 'fail',
    lossScore: 123.45,
    summary: 'FROZEN_CAS_ORIGINAL_VERDICT max=' + (params.maxRmsUm ?? 50),
    checks: [],
    uncertainties: [],
  };
}
export function selfCheck() {
  return { passed: true, summary: 'ok' };
}
`;
    const originalHash = sha256(frozenOriginalCode);

    // 1. Fork editable Draft -> edit via saveComponentDraft -> approve -> record Run -> freeze into CAS
    forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.2-cas',
        changeSummary: '创建可编辑 Draft',
        codeContent: '// placeholder',
        updatedParams: { maxRmsUm: 55 },
      },
      tmpWs,
    );

    saveComponentDraft(
      {
        componentId: 'eval-rms-spot',
        version: 'v0.2-cas',
        codeContent: frozenOriginalCode,
        updatedParams: { maxRmsUm: 52 },
        changeSummary: '在 Draft 阶段直接完善评价函数',
      },
      tmpWs,
    );

    approveComponentVersion('eval-rms-spot', 'v0.2-cas', 'rad', tmpWs);

    const runtimeEnv = detectRuntimeEnvironment();
    const composition = {
      pattern: 'solve_and_evaluate',
      parts: [
        {
          slot: 'evaluator',
          componentId: 'eval-rms-spot',
          componentName: '单色/均方根光斑评价器',
          kind: 'evaluator',
          version: 'v0.2-cas',
          codeHash: originalHash,
          paramsSnapshot: { maxRmsUm: 52 },
        },
      ],
    };
    const createdAt = '2026-11-16T21:30:00.000Z';
    const hashes = computeRunHashes({
      id: 'run-cas-ref',
      sequenceNumber: 2,
      createdAt,
      parentRunId: null,
      branchLabel: 'CAS test',
      intent: 'freeze v0.2-cas',
      mode: 'solve_only',
      seed: 42,
      runtimeEnv,
      composition,
      systemBefore: INITIAL_SINGLET_SPEC,
      systemAfter: INITIAL_SINGLET_SPEC,
      rawArtifactsBefore: trace,
      rawArtifactsAfter: trace,
    });
    const runRef: ExperimentRun = {
      id: 'run-cas-ref',
      sequenceNumber: 2,
      createdAt,
      parentRunId: null,
      branchLabel: 'CAS test',
      intent: 'freeze v0.2-cas',
      mode: 'solve_only',
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
      status: 'completed',
    };
    appendRun(runRef, tmpWs);

    const frozenDossier = freezeComponentVersion(
      'eval-rms-spot',
      'v0.2-cas',
      { runId: 'run-cas-ref' },
      tmpWs,
    );
    const frozenVer = frozenDossier.versions.find((v) => v.version === 'v0.2-cas')!;
    assert.equal(frozenVer.lifecycle, 'frozen');
    assert.equal(frozenVer.immutableBlobHash, originalHash);
    assert.equal(frozenVer.casAvailable, true);
    assert.equal(frozenVer.workspaceMatchesFrozenHash, true);
    assert.equal(frozenVer.frozenWorkspaceModified, false);

    const { immutableStoreDir, componentsDir } = getWorkspacePaths(tmpWs);
    assert.ok(fs.existsSync(path.join(immutableStoreDir, originalHash)));
    assert.equal(readCasBlob(originalHash, tmpWs), frozenOriginalCode);

    // 2. Simulate Rad directly modifying the Frozen workspace file via VS Code!
    const workspaceImplPath = path.join(componentsDir, 'eval-rms-spot', 'v0.2-cas', 'impl.mjs');
    const vscodeEditedCode = `// Rad VS Code direct edit on frozen workspace copy
export function evaluate() {
  return {
    passed: true,
    status: 'pass',
    lossScore: 0,
    summary: 'VSCODE_UNREVIEWED_OVERRIDE',
    checks: [],
    uncertainties: [],
  };
}
export function selfCheck() {
  return { passed: true, summary: 'edited' };
}
`;
    fs.writeFileSync(workspaceImplPath, vscodeEditedCode, 'utf8');

    // System MUST detect the workspace drift without losing the original source
    const detected = getComponent('eval-rms-spot', tmpWs)!;
    const detectedVer = detected.dossier.versions.find((v) => v.version === 'v0.2-cas')!;
    assert.equal(detected.dossier.frozenDriftDetected, true);
    assert.equal(detected.dossier.diskTamperDetected, true);
    assert.equal(detectedVer.frozenWorkspaceModified, true);
    assert.equal(detectedVer.workspaceMatchesFrozenHash, false);
    assert.equal(detectedVer.casAvailable, true);
    assert.equal(detected.codeByVersion['v0.2-cas'], frozenOriginalCode);

    const casRead = readFrozenComponentSource('eval-rms-spot', 'v0.2-cas', tmpWs);
    assert.equal(casRead.source, 'cas');
    assert.equal(casRead.codeHash, originalHash);
    assert.equal(casRead.codeContent, frozenOriginalCode);
    assert.equal(casRead.frozenWorkspaceModified, true);

    // Executing Frozen version MUST run the original CAS code, NEVER the VS Code edit!
    const verdictFromCas = await runEvaluatorComponent({
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: 'v0.2-cas',
      rawArtifacts: trace,
      spec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.equal(verdictFromCas.evaluatorCodeHash, originalHash);
    assert.match(verdictFromCas.summary, /FROZEN_CAS_ORIGINAL_VERDICT/);
    assert.equal(verdictFromCas.passed, false);

    // Even if Rad DELETES the workspace file, Frozen execution still recovers from CAS!
    fs.unlinkSync(workspaceImplPath);
    const verdictAfterDelete = await runEvaluatorComponent({
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: 'v0.2-cas',
      rawArtifacts: trace,
      spec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.equal(verdictAfterDelete.evaluatorCodeHash, originalHash);
    assert.match(verdictAfterDelete.summary, /FROZEN_CAS_ORIGINAL_VERDICT/);

    // 3. Rewrite Rad's edit & restore Frozen workspace file while preserving Rad's work as an editable Draft
    fs.writeFileSync(workspaceImplPath, vscodeEditedCode, 'utf8');
    const restored = restoreFrozenComponentWorkspaceFile('eval-rms-spot', 'v0.2-cas', undefined, tmpWs);
    assert.equal(restored.restoredFromCasHash, originalHash);
    assert.ok(restored.preservedDraftVersion);
    assert.equal(fs.readFileSync(workspaceImplPath, 'utf8'), frozenOriginalCode);
    assert.equal(restored.dossier.frozenDriftDetected, false);
    assert.equal(restored.dossier.diskTamperDetected, false);
    assert.equal(restored.dossier.activeVersion, 'v0.2-cas');

    // Preserved Draft can be edited further, approved, and executed
    const newDraftVer = restored.preservedDraftVersion!;
    const afterDraftEdit = saveComponentDraft(
      {
        componentId: 'eval-rms-spot',
        version: newDraftVer,
        updatedParams: { maxRmsUm: 38 },
        changeSummary: '在保留出的 Draft 上继续调整参数',
      },
      tmpWs,
    );
    assert.equal(afterDraftEdit.versions.find((v) => v.version === newDraftVer)?.lifecycle, 'draft');
    assert.equal(afterDraftEdit.versions.find((v) => v.version === newDraftVer)?.params.maxRmsUm, 38);

    approveComponentVersion('eval-rms-spot', newDraftVer, 'rad', tmpWs);
    const draftVerdict = await runEvaluatorComponent({
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: newDraftVer,
      rawArtifacts: trace,
      spec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.match(draftVerdict.summary, /VSCODE_UNREVIEWED_OVERRIDE/);

    // Original ExperimentRun reference & integrity remain 100% intact
    const reloadedRun = listRuns(tmpWs).find((r) => r.id === 'run-cas-ref')!;
    assert.equal(verifyRunIntegrity(reloadedRun), 'verified');
    assert.equal(reloadedRun.composition.parts[0].codeHash, originalHash);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.2.0: TOCTOU-free verified execution rejects mismatched hashes and ignores post-verification disk swaps', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-toctou-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const { componentsDir } = getWorkspacePaths(tmpWs);

    // Build a benign code and a tampered disk file at implPath
    const verifiedCode = `export function evaluate() { return { passed: true, status: 'pass', lossScore: 1, summary: 'VERIFIED_BYTES', checks: [], uncertainties: [] }; }`;
    const expectedHash = sha256(verifiedCode);
    const fakeDiskPath = path.join(tmpWs, 'toctou_disk_swap.mjs');
    fs.writeFileSync(fakeDiskPath, `export function evaluate() { return { passed: false, status: 'fail', lossScore: 999, summary: 'DISK_SWAP_HIJACK', checks: [], uncertainties: [] }; }`, 'utf8');

    // 1. Harness MUST execute verifiedCode, completely ignoring fakeDiskPath on disk
    const okOut = await runHarnessDirect({
      action: 'evaluate',
      implPath: fakeDiskPath,
      verifiedCode,
      expectedCodeHash: expectedHash,
      params: {},
      trace: {},
      spec: {},
    });
    assert.equal(okOut.code, 0, okOut.stderr);
    assert.match(okOut.stdout, /VERIFIED_BYTES/);
    assert.doesNotMatch(okOut.stdout, /DISK_SWAP_HIJACK/);

    // 2. Harness MUST reject when expectedCodeHash does not match verifiedCode
    const badOut = await runHarnessDirect({
      action: 'evaluate',
      implPath: fakeDiskPath,
      verifiedCode: verifiedCode + '\n// tampered',
      expectedCodeHash: expectedHash,
      params: {},
      trace: {},
      spec: {},
    });
    assert.notEqual(badOut.code, 0);
    assert.match(badOut.stderr, /TOCTOU|哈希校验失败/);

    // 3. Python verified bootstrap also verifies hash before exec & supports frozen CAS
    freezeComponentVersion('solver-optiland-python', 'v0.1', { runId: 'run-py-cas' }, tmpWs);
    const pyPath = path.join(componentsDir, 'solver-optiland-python', 'v0.1', 'impl.py');
    const originalPy = fs.readFileSync(pyPath, 'utf8');
    fs.writeFileSync(pyPath, 'import sys; sys.stderr.write("DISK_HIJACK"); sys.exit(99)', 'utf8');
    const pyCheck = await runComponentSelfCheck('solver-optiland-python', 'v0.1', tmpWs);
    assert.ok(pyCheck.dossier.selfCheck.checkedCodeHash === sha256(originalPy));

    // 4. Draft unreviewed disk edits MUST still be blocked with 安全审查拦截
    forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.3-draft',
        changeSummary: 'draft',
        codeContent: verifiedCode,
        updatedParams: {},
      },
      tmpWs,
    );
    approveComponentVersion('eval-rms-spot', 'v0.3-draft', 'rad', tmpWs);
    const draftPath = path.join(componentsDir, 'eval-rms-spot', 'v0.3-draft', 'impl.mjs');
    fs.appendFileSync(draftPath, '\n// unreviewed edit\n', 'utf8');
    assert.throws(
      () => resolveAndAssertApproved('eval-rms-spot', 'v0.3-draft', tmpWs),
      /安全审查拦截/,
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.2.0: missing_on_disk historical versions forbid in-place writes and allow forking new editable Drafts', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-missing-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const compDir = path.join(tmpWs, 'components', 'eval-rms-spot');
    const dossierPath = path.join(compDir, 'dossier.json');
    const rawDossier = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));

    // Add a missing_on_disk metadata-only historical version (analogous to eval-rms-spot@v0.2)
    rawDossier.versions.unshift({
      version: 'v0.2',
      createdAt: '2026-11-16T15:29:04.225Z',
      parentVersion: 'v0.1',
      author: 'rad',
      changeSummary: '历史元数据存在但源码缺失',
      codeHash: 'a3b03826e7ce6dccbaac59ab5eb8f46b479bbd41b3ce7a3817f66939ce062b55',
      params: { maxRmsUm: 40, eflToleranceMm: 3 },
      codeFile: 'impl.mjs',
      sourceAvailability: 'missing_on_disk',
    });
    saveComponentDossier(rawDossier, tmpWs);

    // Must forbid writing directly onto missing_on_disk version
    assert.throws(
      () =>
        saveComponentDraft(
          {
            componentId: 'eval-rms-spot',
            version: 'v0.2',
            codeContent: '// attempt to fabricate missing v0.2 in place',
          },
          tmpWs,
        ),
      /missing_on_disk|禁止原地写入/,
    );

    // Forking from missing_on_disk MUST succeed as a new editable Draft without fabricating v0.2 on disk
    const forked = forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.2',
        newVersion: 'v0.3-from-v02',
        changeSummary: '从缺失源码的历史版本 v0.2 派生全新可编辑 Draft',
        codeContent: 'export function evaluate() { return { passed: true, status: "pass", lossScore: 0, summary: "new", checks: [], uncertainties: [] }; }',
        updatedParams: { maxRmsUm: 40, eflToleranceMm: 3 },
      },
      tmpWs,
    );

    assert.equal(forked.codeSecurityReview.status, 'unreviewed_modified');
    const v02 = forked.versions.find((v) => v.version === 'v0.2')!;
    const v03 = forked.versions.find((v) => v.version === 'v0.3-from-v02')!;
    assert.equal(v02.sourceAvailability, 'missing_on_disk');
    assert.equal(v02.casAvailable, false);
    assert.equal(fs.existsSync(path.join(compDir, 'v0.2', 'impl.mjs')), false);
    assert.equal(v03.lifecycle, 'draft');
    assert.equal(v03.parentVersion, 'v0.2');
    assert.equal(v03.sourceAvailability, 'available_on_disk');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.2.0: CAS blob modification (corruption) and deletion are detected, reject corrupted execution/restore, and fall back only when workspace matches pinned hash', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-cas-tamper-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const trace = traceOpticalSystem(INITIAL_SINGLET_SPEC);

    const originalCode = `export function evaluate() {
  return { passed: true, status: 'pass', lossScore: 5, summary: 'CAS_VERIFIED_OK', checks: [], uncertainties: [] };
}
export function selfCheck() { return { passed: true, summary: 'ok' }; }
`;
    const originalHash = sha256(originalCode);
    forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.2-cas-guard',
        changeSummary: 'CAS 损坏与删除测试',
        codeContent: originalCode,
        updatedParams: { maxRmsUm: 65 },
      },
      tmpWs,
    );
    approveComponentVersion('eval-rms-spot', 'v0.2-cas-guard', 'rad', tmpWs);
    freezeComponentVersion('eval-rms-spot', 'v0.2-cas-guard', { runId: 'run-guard' }, tmpWs);

    const { immutableStoreDir, componentsDir } = getWorkspacePaths(tmpWs);
    const casBlobPath = path.join(immutableStoreDir, originalHash);
    const workspaceImplPath = path.join(componentsDir, 'eval-rms-spot', 'v0.2-cas-guard', 'impl.mjs');

    // Case 1: CAS blob is MODIFIED (corrupted) while workspace file is still intact
    fs.writeFileSync(casBlobPath, originalCode + '\n// corrupted cas payload\n', 'utf8');

    const inspectedCorrupted = inspectCasBlob(originalHash, tmpWs);
    assert.equal(inspectedCorrupted.status, 'corrupted');
    assert.notEqual(inspectedCorrupted.actualHash, originalHash);

    const compCorrupted = getComponent('eval-rms-spot', tmpWs)!;
    const verCorrupted = compCorrupted.dossier.versions.find((v) => v.version === 'v0.2-cas-guard')!;
    assert.equal(compCorrupted.dossier.casTamperDetected, true);
    assert.equal(verCorrupted.casTamperDetected, true);
    assert.equal(verCorrupted.casIntegrityStatus, 'corrupted');
    assert.equal(verCorrupted.casAvailable, false);

    assert.throws(() => readCasBlob(originalHash, tmpWs), /CAS 不可变存储完整性校验失败/);
    assert.throws(() => readFrozenComponentSource('eval-rms-spot', 'v0.2-cas-guard', tmpWs), /CAS 不可变存储完整性校验失败/);
    assert.throws(() => restoreFrozenComponentWorkspaceFile('eval-rms-spot', 'v0.2-cas-guard', undefined, tmpWs), /CAS 不可变存储完整性校验失败/);
    await assert.rejects(
      () =>
        runEvaluatorComponent({
          evaluatorId: 'eval-rms-spot',
          evaluatorVersion: 'v0.2-cas-guard',
          rawArtifacts: trace,
          spec: INITIAL_SINGLET_SPEC,
          workspaceDir: tmpWs,
        }),
      /CAS 不可变存储完整性校验失败/,
    );

    // Case 2: CAS blob is DELETED while workspace file is still intact and matches ver.codeHash
    fs.unlinkSync(casBlobPath);
    const compMissingCas = getComponent('eval-rms-spot', tmpWs)!;
    const verMissingCas = compMissingCas.dossier.versions.find((v) => v.version === 'v0.2-cas-guard')!;
    assert.equal(compMissingCas.dossier.casTamperDetected, false);
    assert.equal(verMissingCas.casIntegrityStatus, 'missing');
    assert.equal(verMissingCas.casAvailable, false);
    assert.equal(verMissingCas.workspaceMatchesFrozenHash, true);

    const fallbackRead = readFrozenComponentSource('eval-rms-spot', 'v0.2-cas-guard', tmpWs);
    assert.equal(fallbackRead.source, 'workspace');
    assert.equal(fallbackRead.codeHash, originalHash);

    assert.throws(
      () => restoreFrozenComponentWorkspaceFile('eval-rms-spot', 'v0.2-cas-guard', undefined, tmpWs),
      /CAS 中未找到/,
    );

    const ctxFallback = resolveAndAssertApproved('eval-rms-spot', 'v0.2-cas-guard', tmpWs);
    assert.equal(ctxFallback.executedFromCas, false);
    assert.equal(ctxFallback.verifiedHash, originalHash);

    // Case 3: CAS blob is DELETED AND workspace file is ALSO modified or deleted -> strict failure
    fs.writeFileSync(workspaceImplPath, originalCode + '\n// tampered too\n', 'utf8');
    assert.throws(() => readFrozenComponentSource('eval-rms-spot', 'v0.2-cas-guard', tmpWs), /CAS 与工作区均不可用/);
    assert.throws(() => resolveAndAssertApproved('eval-rms-spot', 'v0.2-cas-guard', tmpWs), /安全审查拦截/);

    fs.unlinkSync(workspaceImplPath);
    assert.throws(() => readFrozenComponentSource('eval-rms-spot', 'v0.2-cas-guard', tmpWs), /CAS 与工作区均不可用/);
    assert.throws(() => resolveAndAssertApproved('eval-rms-spot', 'v0.2-cas-guard', tmpWs), /源码文件在磁盘缺失/);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.2.0: Frozen component relative dependencies are pinned into CAS, executed without disk reads, reject ../ escapes, and restore cleanly', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-rel-deps-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const trace = traceOpticalSystem(INITIAL_SINGLET_SPEC);
    const { componentsDir, immutableStoreDir } = getWorkspacePaths(tmpWs);

    const mathCode = `export function scaleLoss(val) { return val * 2; }\n`;
    const helperCode = `import { scaleLoss } from './lib/math.mjs';
export const TAG = 'PINNED_CAS_HELPER';
export function computeSummary(maxUm) { return TAG + ':' + scaleLoss(maxUm); }
`;
    const entryCode = `import { computeSummary } from './helper.mjs';
import { scaleLoss } from './lib/math.mjs';
export function evaluate(_rawArtifacts, _spec, params) {
  return {
    passed: true,
    status: 'pass',
    lossScore: scaleLoss(10),
    summary: computeSummary(params.maxRmsUm ?? 50),
    checks: [],
    uncertainties: [],
  };
}
export function selfCheck() {
  return { passed: true, summary: computeSummary(1) };
}
`;

    forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.4-deps',
        changeSummary: '带有多层相对依赖 ./helper.mjs 与 ./lib/math.mjs',
        codeContent: entryCode,
        updatedParams: { maxRmsUm: 25 },
      },
      tmpWs,
    );

    const verDir = path.join(componentsDir, 'eval-rms-spot', 'v0.4-deps');
    fs.mkdirSync(path.join(verDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(verDir, 'helper.mjs'), helperCode, 'utf8');
    fs.writeFileSync(path.join(verDir, 'lib', 'math.mjs'), mathCode, 'utf8');

    // Approve & freeze: pins both impl.mjs AND helper.mjs AND lib/math.mjs into CAS
    approveComponentVersion('eval-rms-spot', 'v0.4-deps', 'rad', tmpWs);
    const frozen = freezeComponentVersion('eval-rms-spot', 'v0.4-deps', { runId: 'run-deps' }, tmpWs);
    const frozenVer = frozen.versions.find((v) => v.version === 'v0.4-deps')!;

    assert.equal(frozenVer.pinnedRelativeDeps?.length, 2);
    assert.deepEqual(
      frozenVer.pinnedRelativeDeps?.map((d) => d.relativePath),
      ['helper.mjs', 'lib/math.mjs'],
    );
    for (const dep of frozenVer.pinnedRelativeDeps!) {
      assert.ok(dep.immutableBlobHash);
      assert.ok(fs.existsSync(path.join(immutableStoreDir, dep.immutableBlobHash!)));
    }

    // Mutate helper.mjs and DELETE lib/math.mjs on disk -> must detect drift, yet STILL execute CAS-pinned bytes!
    fs.writeFileSync(
      path.join(verDir, 'helper.mjs'),
      `export function computeSummary() { return 'DISK_HIJACKED_HELPER'; }\n`,
      'utf8',
    );
    fs.unlinkSync(path.join(verDir, 'lib', 'math.mjs'));

    const driftedComp = getComponent('eval-rms-spot', tmpWs)!;
    const driftedVer = driftedComp.dossier.versions.find((v) => v.version === 'v0.4-deps')!;
    assert.equal(driftedVer.relativeDepsWorkspaceModified, true);
    assert.equal(driftedVer.frozenWorkspaceModified, true);
    assert.equal(driftedComp.dossier.frozenDriftDetected, true);
    assert.equal(driftedComp.dossier.diskTamperDetected, true);

    const verdict = await runEvaluatorComponent({
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: 'v0.4-deps',
      rawArtifacts: trace,
      spec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.equal(verdict.lossScore, 20);
    assert.equal(verdict.summary, 'PINNED_CAS_HELPER:50');

    // Restore from CAS must restore BOTH helper.mjs and deleted lib/math.mjs
    const restored = restoreFrozenComponentWorkspaceFile('eval-rms-spot', 'v0.4-deps', undefined, tmpWs);
    assert.deepEqual(restored.restoredRelativePaths, ['helper.mjs', 'lib/math.mjs']);
    assert.equal(fs.readFileSync(path.join(verDir, 'helper.mjs'), 'utf8'), helperCode);
    assert.equal(fs.readFileSync(path.join(verDir, 'lib', 'math.mjs'), 'utf8'), mathCode);
    assert.equal(restored.dossier.frozenDriftDetected, false);
    assert.equal(restored.dossier.diskTamperDetected, false);

    // Relative import escaping version directory via ../ MUST be rejected
    forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.5-escape',
        changeSummary: '尝试 ../ 越界引用',
        codeContent: `import { evaluate as ev } from '../v0.1/impl.mjs'; export const evaluate = ev;`,
        updatedParams: {},
      },
      tmpWs,
    );
    assert.throws(
      () => approveComponentVersion('eval-rms-spot', 'v0.5-escape', 'rad', tmpWs),
      /越界|逃逸组件版本目录/,
    );

    // Approved Draft relative dep disk edit MUST trigger 安全审查拦截
    forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.6-draft-deps',
        changeSummary: 'Draft 相对依赖防篡改测试',
        codeContent: entryCode,
        updatedParams: { maxRmsUm: 30 },
      },
      tmpWs,
    );
    const draftDir = path.join(componentsDir, 'eval-rms-spot', 'v0.6-draft-deps');
    fs.mkdirSync(path.join(draftDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(draftDir, 'helper.mjs'), helperCode, 'utf8');
    fs.writeFileSync(path.join(draftDir, 'lib', 'math.mjs'), mathCode, 'utf8');
    approveComponentVersion('eval-rms-spot', 'v0.6-draft-deps', 'rad', tmpWs);

    // Tamper helper.mjs in Draft without re-approving
    fs.appendFileSync(path.join(draftDir, 'helper.mjs'), '\n// unapproved helper edit\n', 'utf8');
    assert.throws(
      () => resolveAndAssertApproved('eval-rms-spot', 'v0.6-draft-deps', tmpWs),
      /安全审查拦截/,
    );

    // Declared host core module (solver-ts-preview -> src/core/optics.ts) works even when Frozen in CAS inside tmpWs
    freezeComponentVersion('solver-ts-preview', 'v0.1', { runId: 'run-host-mod' }, tmpWs);
    const previewCheck = await runComponentSelfCheck('solver-ts-preview', 'v0.1', tmpWs);
    assert.equal(previewCheck.dossier.selfCheck.status, 'passed');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.2.0: pinnedHostModules pins declared src/core/optics.ts into CAS, executes via memory data URL (no fileUrl), survives optics.ts edit/delete, and blocks on unpinned/corrupted mismatch', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-host-repo-'));
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-host-ws-'));
  const prevRepoEnv = process.env.OPENLAB_REPO_ROOT;

  try {
    const realOpticsPath = path.resolve(process.cwd(), 'src', 'core', 'optics.ts');
    const originalOpticsCode = fs.readFileSync(realOpticsPath, 'utf8');
    const originalOpticsHash = sha256(originalOpticsCode);

    const isolatedOpticsDir = path.join(tmpRepo, 'src', 'core');
    const isolatedOpticsPath = path.join(isolatedOpticsDir, 'optics.ts');
    fs.mkdirSync(isolatedOpticsDir, { recursive: true });
    fs.writeFileSync(isolatedOpticsPath, originalOpticsCode, 'utf8');

    process.env.OPENLAB_REPO_ROOT = tmpRepo;
    ensureWorkspaceInitialized(tmpWs);

    // 1. Freezing solver-ts-preview@v0.1 AND opt-nelder-mead@v0.1 pins src/core/optics.ts into pinnedHostModules & CAS
    const frozenDossier = freezeComponentVersion(
      'solver-ts-preview',
      'v0.1',
      { runId: 'run-host-cas' },
      tmpWs,
    );
    const frozenOptDossier = freezeComponentVersion(
      'opt-nelder-mead',
      'v0.1',
      { runId: 'run-host-cas' },
      tmpWs,
    );
    const frozenVer = frozenDossier.versions.find((v) => v.version === 'v0.1')!;
    const frozenOptVer = frozenOptDossier.versions.find((v) => v.version === 'v0.1')!;
    assert.equal(frozenVer.lifecycle, 'frozen');
    assert.equal(frozenOptVer.lifecycle, 'frozen');
    assert.equal(frozenVer.pinnedHostModules?.length, 1);
    assert.equal(frozenOptVer.pinnedHostModules?.length, 1);
    assert.deepEqual(frozenVer.pinnedHostModules?.[0], {
      targetId: 'src/core/optics.ts',
      codeHash: originalOpticsHash,
      immutableBlobHash: originalOpticsHash,
      casPath: `immutable_store/sha256/${originalOpticsHash}`,
    });
    assert.deepEqual(frozenOptVer.pinnedHostModules?.[0], {
      targetId: 'src/core/optics.ts',
      codeHash: originalOpticsHash,
      immutableBlobHash: originalOpticsHash,
      casPath: `immutable_store/sha256/${originalOpticsHash}`,
    });

    const { immutableStoreDir } = getWorkspacePaths(tmpWs);
    const hostCasBlobPath = path.join(immutableStoreDir, originalOpticsHash);
    assert.ok(fs.existsSync(hostCasBlobPath));
    assert.equal(readCasBlob(originalOpticsHash, tmpWs), originalOpticsCode);

    // Harness MUST reject legacy fileUrl-only host module descriptors (never load host module via fileUrl)
    const previewCtx = resolveAndAssertApproved('solver-ts-preview', 'v0.1', tmpWs);
    assert.equal(previewCtx.executedFromCas, true);
    assert.equal(previewCtx.verifiedHostModules['src/core/optics.ts'].code, originalOpticsCode);
    assert.equal(previewCtx.verifiedHostModules['src/core/optics.ts'].codeHash, originalOpticsHash);
    assert.equal('fileUrl' in previewCtx.verifiedHostModules['src/core/optics.ts'], false);

    const fileUrlRejectOut = await runHarnessDirect({
      action: 'check',
      implPath: previewCtx.implPath,
      verifiedCode: previewCtx.verifiedCode,
      expectedCodeHash: previewCtx.verifiedHash,
      verifiedRelativeDeps: previewCtx.verifiedRelativeDeps,
      verifiedHostModules: {
        'src/core/optics.ts': {
          targetId: 'src/core/optics.ts',
          absPath: isolatedOpticsPath,
          fileUrl: `file://${isolatedOpticsPath}`,
          codeHash: originalOpticsHash,
        },
      },
      params: {},
    });
    assert.notEqual(fileUrlRejectOut.code, 0);
    assert.match(fileUrlRejectOut.stderr, /禁止通过 fileUrl 加载|缺少经校验的 code 字节/);

    // Harness MUST reject action === 'optimize' if verifiedHostModules is missing (no disk import fallback!)
    const optCtx = resolveAndAssertApproved('opt-nelder-mead', 'v0.1', tmpWs);
    const evalCtx = resolveAndAssertApproved('eval-rms-spot', 'v0.1', tmpWs);
    const unpinnedOptimizeOut = await runHarnessDirect({
      action: 'optimize',
      implPath: optCtx.implPath,
      verifiedCode: optCtx.verifiedCode,
      expectedCodeHash: optCtx.verifiedHash,
      verifiedRelativeDeps: optCtx.verifiedRelativeDeps,
      verifiedHostModules: {},
      solverVerifiedHostModules: {},
      evalImplPath: evalCtx.implPath,
      evalVerifiedCode: evalCtx.verifiedCode,
      expectedEvalCodeHash: evalCtx.verifiedHash,
      evalVerifiedRelativeDeps: evalCtx.verifiedRelativeDeps,
      evalVerifiedHostModules: evalCtx.verifiedHostModules,
      params: optCtx.ver.params,
      evalParams: evalCtx.ver.params,
      solverId: 'solver-optiland-python',
      initialSpec: INITIAL_SINGLET_SPEC,
    });
    assert.notEqual(unpinnedOptimizeOut.code, 0);
    assert.match(unpinnedOptimizeOut.stderr, /宿主模块安全校验失败 \(optimizer\)|禁止从磁盘加载/);

    // Create a mock python bridge to verify solver-optiland-python + opt-nelder-mead optimization path
    const mockBridgePath = path.join(tmpRepo, 'mock_optiland_bridge.py');
    fs.writeFileSync(
      mockBridgePath,
      `#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.read() or "{}")
spec = payload.get("systemSpec", {})
surfaces = spec.get("surfaces", [])
r1 = float(surfaces[0].get("radiusMm", 72.0)) if len(surfaces) > 0 else 72.0
efl = 100.0 + (r1 - 60.0) * 0.4
rms = abs(r1 - 60.0) * 1.5 + 12.0
print(json.dumps({
  "status": "ok",
  "result": {
    "solverEngine": "optiland",
    "paraxialEflMm": round(efl, 4),
    "paraxialBflMm": 95.0,
    "fNumber": 4.0,
    "imagePlaneZMm": 100.0,
    "totalLengthMm": 105.0,
    "rmsSpotRadiusUm": round(rms, 4),
    "rmsSpotByWavelengthUm": {"587.6": round(rms, 4)},
    "longitudinalSphericalAberrationMm": 0.1,
    "axialChromaticShiftMm": 0.2,
    "mtf30LpMm": 0.5,
    "mtf60LpMm": 0.3,
    "mtfCurve": [],
    "clippedRayCount": 0,
    "tirRayCount": 0,
    "totalRayCount": 21,
    "meridionalRays": [],
    "spotPoints": [],
    "aberrationFan": [],
    "surfaceVerticesZ": [0, 5.5]
  }
}))
`,
      'utf8',
    );

    // 2. Modify src/core/optics.ts on disk with sabotaged return values -> MUST still execute pinned CAS bytes via memory data URL
    const sabotagedOpticsCode = `export function traceOpticalSystem() {
  return {
    solverEngine: 'ts_preview',
    paraxialEflMm: 9999,
    paraxialBflMm: 9999,
    fNumber: 99,
    imagePlaneZMm: 9999,
    totalLengthMm: 9999,
    rmsSpotRadiusUm: 9999,
    rmsSpotByWavelengthUm: {},
    longitudinalSphericalAberrationMm: 99,
    axialChromaticShiftMm: 99,
    mtf30LpMm: 0,
    mtf60LpMm: 0,
    mtfCurve: [],
    clippedRayCount: 0,
    tirRayCount: 0,
    totalRayCount: 0,
    meridionalRays: [],
    spotPoints: [],
    aberrationFan: [],
    surfaceVerticesZ: [0, 5],
  };
}
export function extractVariables() { return []; }
export function applyVariableVector(s) { return s; }
`;
    fs.writeFileSync(isolatedOpticsPath, sabotagedOpticsCode, 'utf8');

    const compAfterEdit = getComponent('solver-ts-preview', tmpWs)!;
    const verAfterEdit = compAfterEdit.dossier.versions.find((v) => v.version === 'v0.1')!;
    assert.equal(compAfterEdit.dossier.hostModuleDriftDetected, true);
    assert.equal(verAfterEdit.hostModulesWorkspaceModified, true);
    assert.equal(verAfterEdit.casAvailable, true);

    const optCompAfterEdit = getComponent('opt-nelder-mead', tmpWs)!;
    assert.equal(optCompAfterEdit.dossier.hostModuleDriftDetected, true);

    const checkAfterEdit = await runComponentSelfCheck('solver-ts-preview', 'v0.1', tmpWs);
    assert.equal(checkAfterEdit.dossier.selfCheck.status, 'passed');
    assert.match(checkAfterEdit.dossier.selfCheck.summary, /96\.8/);

    const solveAfterEdit = await runSolverComponent('solver-ts-preview', INITIAL_SINGLET_SPEC, tmpWs);
    assert.ok(solveAfterEdit.result.paraxialEflMm > 50 && solveAfterEdit.result.paraxialEflMm < 200);
    assert.notEqual(solveAfterEdit.result.paraxialEflMm, 9999);

    const optAfterEdit = await runOptimizerComponent({
      optimizerId: 'opt-nelder-mead',
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: 'v0.1',
      solverId: 'solver-ts-preview',
      initialSpec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.ok(optAfterEdit.history.length >= 2);
    assert.ok(optAfterEdit.bestTrace.paraxialEflMm > 50 && optAfterEdit.bestTrace.paraxialEflMm < 200);

    // 3. DELETE src/core/optics.ts completely -> MUST still execute pinned CAS bytes cleanly via memory data URL,
    // including the solver-optiland-python + opt-nelder-mead combination!
    fs.unlinkSync(isolatedOpticsPath);

    const compAfterDelete = getComponent('solver-ts-preview', tmpWs)!;
    const verAfterDelete = compAfterDelete.dossier.versions.find((v) => v.version === 'v0.1')!;
    assert.equal(compAfterDelete.dossier.hostModuleDriftDetected, true);
    assert.equal(verAfterDelete.hostModulesWorkspaceModified, true);
    assert.equal(verAfterDelete.casAvailable, true);

    const checkAfterDelete = await runComponentSelfCheck('solver-ts-preview', 'v0.1', tmpWs);
    assert.equal(checkAfterDelete.dossier.selfCheck.status, 'passed');

    const solveAfterDelete = await runSolverComponent('solver-ts-preview', INITIAL_SINGLET_SPEC, tmpWs);
    assert.ok(solveAfterDelete.result.paraxialEflMm > 50 && solveAfterDelete.result.paraxialEflMm < 200);

    // Verify solver-optiland-python + opt-nelder-mead runs extractVariables/applyVariableVector from opt-nelder-mead's CAS-pinned host module even when src/core/optics.ts is deleted!
    const refreshedOptCtx = resolveAndAssertApproved('opt-nelder-mead', 'v0.1', tmpWs);
    const refreshedEvalCtx = resolveAndAssertApproved('eval-rms-spot', 'v0.1', tmpWs);
    const refreshedPySolverCtx = resolveAndAssertApproved('solver-optiland-python', 'v0.1', tmpWs);
    assert.deepEqual(refreshedPySolverCtx.verifiedHostModules, {}); // Python solver has no TS host module
    assert.ok(refreshedOptCtx.verifiedHostModules['src/core/optics.ts']); // Optimizer provides its own pinned host module

    const optilandOptimizeOut = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const harnessPath = path.resolve(process.cwd(), 'server', 'mjs_harness.mjs');
      const proc = execFile(
        'node',
        ['--no-warnings', harnessPath],
        {
          timeout: 15000,
          env: { ...process.env, OPENLAB_OPTILAND_BRIDGE: mockBridgePath },
        },
        (err, stdout, stderr) => {
          resolve({ stdout, stderr, code: err ? 1 : 0 });
        },
      );
      proc.stdin?.write(
        JSON.stringify({
          action: 'optimize',
          implPath: refreshedOptCtx.implPath,
          verifiedCode: refreshedOptCtx.verifiedCode,
          expectedCodeHash: refreshedOptCtx.verifiedHash,
          verifiedRelativeDeps: refreshedOptCtx.verifiedRelativeDeps,
          verifiedHostModules: refreshedOptCtx.verifiedHostModules,
          solverVerifiedHostModules: refreshedPySolverCtx.verifiedHostModules,
          evalImplPath: refreshedEvalCtx.implPath,
          evalVerifiedCode: refreshedEvalCtx.verifiedCode,
          expectedEvalCodeHash: refreshedEvalCtx.verifiedHash,
          evalVerifiedRelativeDeps: refreshedEvalCtx.verifiedRelativeDeps,
          evalVerifiedHostModules: refreshedEvalCtx.verifiedHostModules,
          params: { maxIterations: 6, simplexScaleMm: 4 },
          evalParams: refreshedEvalCtx.ver.params,
          solverId: 'solver-optiland-python',
          initialSpec: INITIAL_SINGLET_SPEC,
        }),
      );
      proc.stdin?.end();
    });
    assert.equal(optilandOptimizeOut.code, 0, optilandOptimizeOut.stderr);
    const optilandParsed = JSON.parse(optilandOptimizeOut.stdout);
    assert.ok(optilandParsed.history.length >= 2);
    assert.notEqual(
      optilandParsed.bestSpec.surfaces[0].radiusMm,
      INITIAL_SINGLET_SPEC.surfaces[0].radiusMm,
    );

    // 4. Corrupt host CAS blob -> MUST explicitly block execution (never mask CAS corruption)
    fs.writeFileSync(hostCasBlobPath, sabotagedOpticsCode, 'utf8');
    const compCasCorrupt = getComponent('solver-ts-preview', tmpWs)!;
    assert.equal(compCasCorrupt.dossier.casTamperDetected, true);
    await assert.rejects(
      () => runComponentSelfCheck('solver-ts-preview', 'v0.1', tmpWs),
      /CAS 不可变存储完整性校验失败/,
    );
    await assert.rejects(
      () => runSolverComponent('solver-ts-preview', INITIAL_SINGLET_SPEC, tmpWs),
      /CAS 不可变存储完整性校验失败/,
    );

    // 5. Delete host CAS blob:
    // 5a. If disk copy is ALSO deleted or modified -> MUST explicitly block execution
    fs.unlinkSync(hostCasBlobPath);
    await assert.rejects(
      () => runComponentSelfCheck('solver-ts-preview', 'v0.1', tmpWs),
      /明确阻断执行|在 CAS 与工作区均不可用/,
    );

    fs.writeFileSync(isolatedOpticsPath, sabotagedOpticsCode, 'utf8');
    await assert.rejects(
      () => runSolverComponent('solver-ts-preview', INITIAL_SINGLET_SPEC, tmpWs),
      /明确阻断执行|在 CAS 与工作区均不可用/,
    );

    // 5b. If host CAS blob is missing (deleted) BUT disk copy strictly matches pinned codeHash -> allowed fallback with executedFromCas=false
    fs.writeFileSync(isolatedOpticsPath, originalOpticsCode, 'utf8');
    const fallbackHostCtx = resolveAndAssertApproved('solver-ts-preview', 'v0.1', tmpWs);
    assert.equal(fallbackHostCtx.executedFromCas, false);
    assert.equal(fallbackHostCtx.verifiedHostModules['src/core/optics.ts'].codeHash, originalOpticsHash);
    const solveViaDiskFallback = await runSolverComponent('solver-ts-preview', INITIAL_SINGLET_SPEC, tmpWs);
    assert.ok(solveViaDiskFallback.result.paraxialEflMm > 50 && solveViaDiskFallback.result.paraxialEflMm < 200);

    // 6. Draft approved with pinnedHostModules MUST block execution if src/core/optics.ts is subsequently modified
    const stubCode = fs.readFileSync(
      path.join(getWorkspacePaths(tmpWs).componentsDir, 'solver-ts-preview', 'v0.1', 'impl.mjs'),
      'utf8',
    );
    forkComponentVersion(
      {
        componentId: 'solver-ts-preview',
        baseVersion: 'v0.1',
        newVersion: 'v0.2-draft-host',
        changeSummary: 'Draft 宿主模块哈希守卫测试',
        codeContent: stubCode,
        updatedParams: {},
      },
      tmpWs,
    );
    const approvedDraft = approveComponentVersion('solver-ts-preview', 'v0.2-draft-host', 'rad', tmpWs);
    const draftVer = approvedDraft.versions.find((v) => v.version === 'v0.2-draft-host')!;
    assert.equal(draftVer.pinnedHostModules?.[0].targetId, 'src/core/optics.ts');
    assert.equal(draftVer.pinnedHostModules?.[0].codeHash, originalOpticsHash);
    assert.equal(draftVer.pinnedHostModules?.[0].immutableBlobHash, null);

    fs.writeFileSync(isolatedOpticsPath, sabotagedOpticsCode, 'utf8');
    assert.throws(
      () => resolveAndAssertApproved('solver-ts-preview', 'v0.2-draft-host', tmpWs),
      /安全审查拦截.*宿主模块/,
    );
  } finally {
    if (prevRepoEnv === undefined) {
      delete process.env.OPENLAB_REPO_ROOT;
    } else {
      process.env.OPENLAB_REPO_ROOT = prevRepoEnv;
    }
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('A1.2.0: independent CAS fallback uses intact dep/host CAS when primary CAS is missing, and marks executedFromCas=false when pinnedRelativeDeps immutableBlobHash is null', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-indep-repo-'));
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a120-indep-ws-'));
  const prevRepoEnv = process.env.OPENLAB_REPO_ROOT;

  try {
    const realOpticsPath = path.resolve(process.cwd(), 'src', 'core', 'optics.ts');
    const originalOpticsCode = fs.readFileSync(realOpticsPath, 'utf8');
    const originalOpticsHash = sha256(originalOpticsCode);
    const isolatedOpticsDir = path.join(tmpRepo, 'src', 'core');
    const isolatedOpticsPath = path.join(isolatedOpticsDir, 'optics.ts');
    fs.mkdirSync(isolatedOpticsDir, { recursive: true });
    fs.writeFileSync(isolatedOpticsPath, originalOpticsCode, 'utf8');

    process.env.OPENLAB_REPO_ROOT = tmpRepo;
    ensureWorkspaceInitialized(tmpWs);

    // 1. Freeze solver-ts-preview@v0.1, then DELETE primary CAS blob AND DELETE src/core/optics.ts on disk
    // while keeping primary disk file intact and keeping optics.ts CAS blob intact!
    freezeComponentVersion('solver-ts-preview', 'v0.1', { runId: 'run-indep-host' }, tmpWs);
    const { immutableStoreDir, componentsDir } = getWorkspacePaths(tmpWs);
    const previewDossier = getComponent('solver-ts-preview', tmpWs)!.dossier;
    const previewPrimaryBlobHash = previewDossier.versions.find((v) => v.version === 'v0.1')!.immutableBlobHash!;
    assert.notEqual(previewPrimaryBlobHash, originalOpticsHash);

    fs.unlinkSync(path.join(immutableStoreDir, previewPrimaryBlobHash));
    fs.unlinkSync(isolatedOpticsPath);

    // Independent fallback: primary comes from verified disk, optics.ts comes from intact CAS -> succeeds with executedFromCas=false!
    const indepHostCtx = resolveAndAssertApproved('solver-ts-preview', 'v0.1', tmpWs);
    assert.equal(indepHostCtx.executedFromCas, false);
    assert.equal(indepHostCtx.verifiedHostModules['src/core/optics.ts'].codeHash, originalOpticsHash);
    const solveAfterIndep = await runSolverComponent('solver-ts-preview', INITIAL_SINGLET_SPEC, tmpWs);
    assert.ok(solveAfterIndep.result.paraxialEflMm > 50 && solveAfterIndep.result.paraxialEflMm < 200);

    // 2. Freeze component with relative dep -> delete primary CAS blob AND delete relative dep on disk while keeping dep CAS intact!
    const helperCode = `export function bonusScore() { return 7; }\n`;
    const evalEntry = `import { bonusScore } from './helper.mjs';
export function evaluate() {
  return { passed: true, status: 'pass', lossScore: bonusScore(), summary: 'INDEP_REL_DEP_OK', checks: [], uncertainties: [] };
}
export function selfCheck() { return { passed: true, summary: 'ok' }; }
`;
    forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.7-indep-dep',
        changeSummary: '独立回退与未固定相对依赖测试',
        codeContent: evalEntry,
        updatedParams: {},
      },
      tmpWs,
    );
    const evalDir = path.join(componentsDir, 'eval-rms-spot', 'v0.7-indep-dep');
    fs.writeFileSync(path.join(evalDir, 'helper.mjs'), helperCode, 'utf8');
    approveComponentVersion('eval-rms-spot', 'v0.7-indep-dep', 'rad', tmpWs);
    const frozenEval = freezeComponentVersion('eval-rms-spot', 'v0.7-indep-dep', { runId: 'run-indep-dep' }, tmpWs);
    const frozenEvalVer = frozenEval.versions.find((v) => v.version === 'v0.7-indep-dep')!;
    const evalPrimaryBlobHash = frozenEvalVer.immutableBlobHash!;
    const depBlobHash = frozenEvalVer.pinnedRelativeDeps![0].immutableBlobHash!;

    // Delete primary CAS blob AND delete helper.mjs on disk (dep CAS remains intact)
    fs.unlinkSync(path.join(immutableStoreDir, evalPrimaryBlobHash));
    fs.unlinkSync(path.join(evalDir, 'helper.mjs'));

    const indepRelCtx = resolveAndAssertApproved('eval-rms-spot', 'v0.7-indep-dep', tmpWs);
    assert.equal(indepRelCtx.executedFromCas, false);
    assert.equal(indepRelCtx.verifiedRelativeDeps['helper.mjs'].code, helperCode);

    const trace = traceOpticalSystem(INITIAL_SINGLET_SPEC);
    const verdictIndep = await runEvaluatorComponent({
      evaluatorId: 'eval-rms-spot',
      evaluatorVersion: 'v0.7-indep-dep',
      rawArtifacts: trace,
      spec: INITIAL_SINGLET_SPEC,
      workspaceDir: tmpWs,
    });
    assert.equal(verdictIndep.lossScore, 7);
    assert.equal(verdictIndep.summary, 'INDEP_REL_DEP_OK');

    const readIndep = readFrozenComponentSource('eval-rms-spot', 'v0.7-indep-dep', tmpWs);
    assert.equal(readIndep.source, 'workspace');
    assert.equal(readIndep.relativeDeps[0].codeContent, helperCode);

    // 3. When pinnedRelativeDeps[0].immutableBlobHash is null on a frozen version:
    // restore primary CAS + helper.mjs on disk, set dep immutableBlobHash = null -> executedFromCas MUST be false (never true!)
    fs.writeFileSync(path.join(immutableStoreDir, evalPrimaryBlobHash), evalEntry, 'utf8');
    fs.writeFileSync(path.join(evalDir, 'helper.mjs'), helperCode, 'utf8');
    const rawEvalDossier = JSON.parse(
      fs.readFileSync(path.join(componentsDir, 'eval-rms-spot', 'dossier.json'), 'utf8'),
    );
    const targetVer = rawEvalDossier.versions.find((v: { version: string }) => v.version === 'v0.7-indep-dep');
    targetVer.pinnedRelativeDeps[0].immutableBlobHash = null;
    saveComponentDossier(rawEvalDossier, tmpWs);

    // Even if old dep blob exists on disk in CAS, immutableBlobHash=null is unpinned for that dep -> executedFromCas MUST be false
    assert.ok(fs.existsSync(path.join(immutableStoreDir, depBlobHash)));
    const unpinnedDepCtx = resolveAndAssertApproved('eval-rms-spot', 'v0.7-indep-dep', tmpWs);
    assert.equal(unpinnedDepCtx.executedFromCas, false);
    assert.equal(unpinnedDepCtx.verifiedRelativeDeps['helper.mjs'].code, helperCode);

    // And if helper.mjs on disk is also tampered while dep immutableBlobHash is null -> MUST block execution
    fs.writeFileSync(path.join(evalDir, 'helper.mjs'), 'export function bonusScore() { return 999; }\n', 'utf8');
    assert.throws(
      () => resolveAndAssertApproved('eval-rms-spot', 'v0.7-indep-dep', tmpWs),
      /在 CAS 与工作区均不可用或哈希不匹配/,
    );
  } finally {
    if (prevRepoEnv === undefined) {
      delete process.env.OPENLAB_REPO_ROOT;
    } else {
      process.env.OPENLAB_REPO_ROOT = prevRepoEnv;
    }
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
