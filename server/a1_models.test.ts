import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { traceOpticalSystem } from '../src/core/optics.ts';
import type {
  Branch,
  EffectiveExecutionConfig,
  ExperimentRun,
  ResearchObject,
  ResearchSnapshot,
  RunSupplement,
} from '../src/core/types.ts';
import {
  appendRun,
  appendRunStandaloneAnalysis,
  appendRunSupplement,
  appendSnapshot,
  computeRunHashes,
  ensureWorkspaceInitialized,
  forkComponentVersion,
  freezeComponentVersion,
  getComponent,
  getWorkspacePaths,
  hydrateRunsWithSupplements,
  INITIAL_SINGLET_SPEC,
  listBranches,
  listRawRuns,
  listResearchObjects,
  listRuns,
  listRunSupplements,
  listSnapshots,
  saveBranches,
  saveComponentDraft,
  saveResearchObjects,
  sha256,
  updateRunEvaluations,
  verifyRunIntegrity,
} from './storage.ts';

test('A1.1: ensureWorkspaceInitialized never overwrites existing user-edited component code on disk', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a1-no-overwrite-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const compPath = path.join(tmpWs, 'components', 'eval-rms-spot', 'v0.1', 'impl.mjs');
    const dossierPath = path.join(tmpWs, 'components', 'eval-rms-spot', 'dossier.json');

    // Simulate legacy dossier missing selfCheck/codeSecurityReview + user-customized v0.1 source
    const rawDossier = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));
    delete rawDossier.selfCheck;
    fs.writeFileSync(dossierPath, JSON.stringify(rawDossier, null, 2), 'utf8');
    const customCode = '// USER CUSTOM CODE MUST NOT BE OVERWRITTEN\nexport function evaluate() { return { passed: true }; }\n';
    fs.writeFileSync(compPath, customCode, 'utf8');

    // Re-running initialization must NOT overwrite user code on disk
    ensureWorkspaceInitialized(tmpWs);
    assert.equal(fs.readFileSync(compPath, 'utf8'), customCode);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.1: Draft/Frozen immutability allows editing unreferenced Drafts but blocks overwriting Frozen versions', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a1-draft-frozen-'));
  try {
    ensureWorkspaceInitialized(tmpWs);

    // Create a Draft version -> editable in place
    const forked = forkComponentVersion(
      {
        componentId: 'eval-rms-spot',
        baseVersion: 'v0.1',
        newVersion: 'v0.2-draft',
        changeSummary: '实验前微调阈值',
        codeContent: '// draft v1\nexport function evaluate() { return { passed: true, status: "pass", lossScore: 0, summary: "ok", checks: [], uncertainties: [] }; }',
        updatedParams: { maxRmsUm: 50 },
      },
      tmpWs,
    );
    const draftVer = forked.versions.find((v) => v.version === 'v0.2-draft')!;
    assert.equal(draftVer.lifecycle, 'draft');

    const editedDraft = saveComponentDraft(
      {
        componentId: 'eval-rms-spot',
        version: 'v0.2-draft',
        updatedParams: { maxRmsUm: 45 },
        changeSummary: 'Draft 参数更新到 45',
      },
      tmpWs,
    );
    assert.equal(editedDraft.versions.find((v) => v.version === 'v0.2-draft')?.params.maxRmsUm, 45);

    // Freeze version -> MUST reject direct edits
    const frozen = freezeComponentVersion(
      'eval-rms-spot',
      'v0.2-draft',
      { runId: 'run-test-freeze', snapshotId: 'snap-test-freeze' },
      tmpWs,
    );
    const frozenVer = frozen.versions.find((v) => v.version === 'v0.2-draft')!;
    assert.equal(frozenVer.lifecycle, 'frozen');
    assert.equal(frozenVer.sourceAvailability, 'available_on_disk');
    assert.deepEqual(frozenVer.frozenByRunIds, ['run-test-freeze']);

    assert.throws(
      () =>
        saveComponentDraft(
          {
            componentId: 'eval-rms-spot',
            version: 'v0.2-draft',
            codeContent: '// attempt overwrite',
          },
          tmpWs,
        ),
      /不可变版本保护/,
    );
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.1: RunSupplement writes are strictly append-only (runs.jsonl unchanged) and deduplicated without duplicating legacy records', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a1-supplements-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const paths = getWorkspacePaths(tmpWs);
    const runsHashBefore = sha256(fs.readFileSync(paths.runsFile, 'utf8'));

    const beforeRuns = listRuns(tmpWs);
    const run1 = beforeRuns[0];
    assert.equal(run1.evaluations.length, 1);

    // Post-hoc reevaluation via updateRunEvaluations MUST NOT rewrite runs.jsonl
    const reevalVerdict = {
      id: 'ev-posthoc-1',
      evaluatorId: 'eval-mtf-chromatic',
      evaluatorName: 'MTF30 与消色差严格评价器',
      evaluatorVersion: 'v0.1',
      evaluatorCodeHash: 'a'.repeat(64),
      evaluatedAt: '2026-11-16T20:00:00.000Z',
      passed: false,
      status: 'fail' as const,
      lossScore: 180,
      summary: '事后重评不通过',
      checks: [],
      uncertainties: [],
    };
    const afterReeval = updateRunEvaluations(run1.id, reevalVerdict, undefined, tmpWs);
    assert.equal(afterReeval.evaluations.length, 2);

    // Standalone analysis via appendRunStandaloneAnalysis MUST NOT rewrite runs.jsonl
    const afterStandalone = appendRunStandaloneAnalysis(
      run1.id,
      {
        id: 'sa-test-1',
        componentId: 'analysis-aberration-summary',
        componentName: '球差/色差主导诊断插件',
        version: 'v0.1',
        codeHash: 'b'.repeat(64),
        ranAt: '2026-11-16T20:05:00.000Z',
        output: { summary: 'test' },
      },
      undefined,
      tmpWs,
    );
    assert.equal(afterStandalone.standaloneAnalyses?.length, 1);

    const runsHashAfter = sha256(fs.readFileSync(paths.runsFile, 'utf8'));
    assert.equal(runsHashAfter, runsHashBefore, 'runs.jsonl must NEVER be rewritten by supplements');
    assert.equal(listRunSupplements(tmpWs).length, 2);

    // Deduplication check: if a migrated supplement shares legacyOriginalId with an item already in runs.jsonl, never duplicate!
    const dupSup: RunSupplement = {
      id: 'sup-dup-check',
      runId: run1.id,
      supplementKind: 'post_hoc_reevaluation',
      createdAt: reevalVerdict.evaluatedAt,
      createdBy: { actorId: 'migrated:unknown', displayName: '迁移', actorKind: 'migrated_unknown' },
      sourceStorage: 'migrated_from_runs_jsonl',
      legacyOriginalId: 'ev-posthoc-1',
      legacySourceField: 'runs.jsonl#run-001.evaluations[1]',
      originalOrder: 1,
      classificationBasis: 'test dedup',
      verdict: reevalVerdict,
    };
    appendRunSupplement(dupSup, tmpWs);
    const deduped = hydrateRunsWithSupplements(listRawRuns(tmpWs), listRunSupplements(tmpWs));
    assert.equal(deduped[0].evaluations.length, 2);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.1: ResearchObject, ResearchSnapshot (with evaluatorBindings[]), Branch, and EffectiveExecutionConfig round-trip cleanly with SHA-256 verification', () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a1-domain-'));
  try {
    ensureWorkspaceInitialized(tmpWs);
    const trace = traceOpticalSystem(INITIAL_SINGLET_SPEC);

    const ro: ResearchObject = {
      id: 'obj-1',
      domainId: 'optics.geometric',
      title: '100mm f/4 成像镜头探索',
      problemStatement: '验证单透镜与双胶合色差权衡',
      objectives: [{ id: 'obj-efl', title: '维持 100mm 焦距', description: 'EFL=100±2.5mm', priority: 'primary' }],
      criteria: [
        { id: 'crit-mtf', metricKey: 'mtf30LpMm', label: 'MTF@30', operator: '>=', targetValue: 0.35, required: true },
        { id: 'crit-chrom', metricKey: 'axialChromaticShiftMm', label: 'F-C 色差', operator: '<=', targetValue: 0.45, unit: 'mm', required: true },
      ],
      openQuestions: ['双胶合优化后 MTF30 仅 0.2237，是否放宽孔径或增加第三片？'],
      createdAt: '2026-11-16T20:00:00.000Z',
      createdBy: { actorId: 'human:rad', displayName: 'Rad', actorKind: 'human' },
    };
    saveResearchObjects([ro], tmpWs);
    assert.equal(listResearchObjects(tmpWs).length, 1);

    const snap: ResearchSnapshot = {
      id: 'snap-1',
      researchObjectId: ro.id,
      parentSnapshotId: null,
      branchId: 'branch-1',
      title: '双胶合起点',
      description: '基线快照',
      systemSpec: INITIAL_SINGLET_SPEC,
      objectivesSnapshot: ro.objectives,
      criteriaSnapshot: ro.criteria,
      evaluatorBindings: [
        {
          bindingId: 'b-1',
          evaluatorId: 'eval-mtf-chromatic',
          evaluatorVersion: 'v0.1',
          evaluatorCodeHash: 'c'.repeat(64),
          paramsSnapshot: { minMtf30: 0.35 },
          criterionIds: ['crit-mtf', 'crit-chrom'],
          coverageNote: '同时覆盖 MTF30 与 F-C 色差两项判据',
          sourceAvailability: 'available_on_disk',
        },
        {
          bindingId: 'b-2',
          evaluatorId: 'eval-rms-spot',
          evaluatorVersion: 'v0.1',
          evaluatorCodeHash: 'd'.repeat(64),
          paramsSnapshot: { maxRmsUm: 65 },
          criterionIds: [],
          coverageNote: '补充 RMS 参考对照',
          sourceAvailability: 'available_on_disk',
        },
      ],
      pinnedComponents: [
        {
          slot: 'optical_solver',
          componentId: 'solver-ts-preview',
          version: 'v0.1',
          codeHash: 'e'.repeat(64),
          sourceAvailability: 'available_on_disk',
        },
      ],
      evidenceGrade: 'preview_computed',
      createdAt: '2026-11-16T20:00:00.000Z',
      createdBy: { actorId: 'human:rad', displayName: 'Rad', actorKind: 'human' },
    };
    appendSnapshot(snap, tmpWs);
    assert.equal(listSnapshots(tmpWs)[0].evaluatorBindings.length, 2);

    const branch: Branch = {
      id: 'branch-1',
      researchObjectId: ro.id,
      name: '双胶合探索路线',
      hypothesis: '使用 N-BK7 + N-SF11 消色差',
      status: 'exploring',
      owner: { actorId: 'human:rad', displayName: 'Rad', actorKind: 'human' },
      baseSnapshotId: 'snap-1',
      headSnapshotId: 'snap-1',
      unadoptedRunIds: ['run-effective-1'],
      adoptedRunIds: [],
      createdAt: '2026-11-16T20:00:00.000Z',
      updatedAt: '2026-11-16T20:00:00.000Z',
    };
    saveBranches([branch], tmpWs);
    assert.equal(listBranches(tmpWs)[0].headSnapshotId, 'snap-1');

    const effectiveConfig: EffectiveExecutionConfig = {
      effectiveSystemSpec: INITIAL_SINGLET_SPEC,
      effectiveParts: [
        {
          slot: 'optical_solver',
          componentId: 'solver-ts-preview',
          componentName: 'TS Preview',
          kind: 'optical_solver',
          version: 'v0.1',
          codeHash: 'e'.repeat(64),
          paramsSnapshot: {},
        },
      ],
      overrides: [{ targetScope: 'evaluator', componentId: 'eval-mtf-chromatic', key: 'minMtf30', baseValue: 0.35, overrideValue: 0.3 }],
      evaluationPolicy: {
        researchObjectId: ro.id,
        policyVersion: 'v1.1',
        objectives: ro.objectives,
        criteria: ro.criteria,
        evaluatorBindings: snap.evaluatorBindings,
      },
      executor: { actorId: 'human:rad', displayName: 'Rad', actorKind: 'human' },
    };

    const hashes = computeRunHashes({
      id: 'run-effective-1',
      sequenceNumber: 2,
      createdAt: '2026-11-16T20:01:00.000Z',
      parentRunId: null,
      branchLabel: branch.name,
      intent: '测试完整配置哈希',
      mode: 'solve_only',
      seed: 42,
      runtimeEnv: listRawRuns(tmpWs)[0].runtimeEnv,
      composition: { pattern: 'solve_and_evaluate', parts: effectiveConfig.effectiveParts },
      baseSnapshotId: snap.id,
      researchObjectId: ro.id,
      branchId: branch.id,
      effectiveConfig,
      systemBefore: INITIAL_SINGLET_SPEC,
      systemAfter: INITIAL_SINGLET_SPEC,
      rawArtifactsBefore: trace,
      rawArtifactsAfter: trace,
    });
    const run: ExperimentRun = {
      id: 'run-effective-1',
      sequenceNumber: 2,
      createdAt: '2026-11-16T20:01:00.000Z',
      parentRunId: null,
      branchLabel: branch.name,
      intent: '测试完整配置哈希',
      mode: 'solve_only',
      seed: 42,
      runtimeEnv: listRawRuns(tmpWs)[0].runtimeEnv,
      composition: { pattern: 'solve_and_evaluate', parts: effectiveConfig.effectiveParts },
      baseSnapshotId: snap.id,
      researchObjectId: ro.id,
      branchId: branch.id,
      effectiveConfig,
      candidateStatus: 'unadopted',
      systemBefore: INITIAL_SINGLET_SPEC,
      systemAfter: INITIAL_SINGLET_SPEC,
      rawArtifactsBefore: trace,
      rawArtifactsAfter: trace,
      optimizationTrace: [],
      evaluations: [],
      ...hashes,
      executionMs: 5,
      status: 'completed',
    };
    appendRun(run, tmpWs);

    const loaded = listRawRuns(tmpWs).find((r) => r.id === 'run-effective-1')!;
    assert.equal(verifyRunIntegrity(loaded), 'verified');

    // Tampering with overrides MUST invalidate integrity hash!
    const tampered: ExperimentRun = {
      ...loaded,
      effectiveConfig: { ...effectiveConfig, overrides: [] },
    };
    assert.equal(verifyRunIntegrity(tampered), 'tampered');

    // Check missing_on_disk awareness in getComponent
    const comp = getComponent('eval-rms-spot', tmpWs)!;
    assert.ok(comp.dossier.versions.every((v) => v.sourceAvailability === 'available_on_disk'));
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
