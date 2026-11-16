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
