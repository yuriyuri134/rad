import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildArchitectureMap } from '../src/core/architectureMap.ts';
import { collectWorkspaceFiles } from './a0_audit.ts';
import { migrateWorkspaceToStageA1 } from './a1_migrate.ts';
import {
  canonicalJson,
  detectRuntimeEnvironment,
  getComponent,
  listBranches,
  listComponents,
  listResearchObjects,
  listRuns,
  listRunSupplements,
  listSnapshots,
  sha256,
  updateRunEvaluations,
} from './storage.ts';

function clonePreMigrationWorkspace(): string {
  const srcWs = path.resolve(process.cwd(), 'workspace');
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a1-migrate-test-'));
  const files = collectWorkspaceFiles(srcWs);
  for (const f of files) {
    // Only clone original pre-migration files (runs.jsonl, thread.jsonl, components/*)
    if (
      f.relativePath === 'runs.jsonl' ||
      f.relativePath === 'thread.jsonl' ||
      f.relativePath.startsWith('components/')
    ) {
      const srcPath = path.join(srcWs, f.relativePath);
      const dstPath = path.join(tmpWs, f.relativePath);
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
    }
  }
  return tmpWs;
}

test('A1.2.1: simulated mid-commit failure triggers complete rollback leaving workspace identical to pre-migration state', () => {
  const tmpWs = clonePreMigrationWorkspace();
  try {
    const beforeSnapshot = collectWorkspaceFiles(tmpWs).map((f) => ({
      path: f.relativePath,
      sha256: f.sha256,
      bytes: f.bytes,
    }));

    assert.throws(
      () => migrateWorkspaceToStageA1(tmpWs, { simulateCommitFailureAfterFiles: 7 }),
      /模拟提交中断/,
    );

    const afterSnapshot = collectWorkspaceFiles(tmpWs).map((f) => ({
      path: f.relativePath,
      sha256: f.sha256,
      bytes: f.bytes,
    }));

    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(fs.existsSync(path.join(tmpWs, 'research_objects.json')), false);
    assert.equal(fs.existsSync(path.join(tmpWs, 'snapshots.jsonl')), false);
    assert.equal(fs.existsSync(path.join(tmpWs, 'branches.json')), false);
    assert.equal(fs.existsSync(path.join(tmpWs, 'run_supplements.jsonl')), false);
    assert.equal(fs.existsSync(path.join(tmpWs, 'immutable_store')), false);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('A1.2.1: staged migration enforces all constraints, preserves legacy files & eval-rms-spot drift, avoids RunSupplement duplication, and is strictly idempotent', () => {
  const tmpWs = clonePreMigrationWorkspace();
  try {
    const result1 = migrateWorkspaceToStageA1(tmpWs);
    assert.equal(result1.success, true);
    assert.equal(result1.correspondence.hydratingRunsPreservesCountsWithoutDuplication, true);
    assert.equal(result1.correspondence.evalRmsSpotV01DriftPreserved, true);
    assert.equal(result1.correspondence.evalRmsSpotV02MissingPreserved, true);
    assert.equal(result1.correspondence.branchBDoubletHeadStaysBefore, true);
    assert.equal(result1.correspondence.snap002BeforeParentNull, true);

    // 1. Verify ResearchObject, Snapshots, and Branches
    const ros = listResearchObjects(tmpWs);
    assert.equal(ros.length, 1);
    assert.equal(ros[0].id, 'obj-optics-100mm-f4');

    const snaps = listSnapshots(tmpWs);
    assert.equal(snaps.length, 3);
    const snap002Before = snaps.find((s) => s.id === 'snap-002-before')!;
    const snap002After = snaps.find((s) => s.id === 'snap-002-after')!;
    assert.equal(snap002Before.parentSnapshotId, null);
    assert.equal(snap002Before.legacyParentRunId, 'run-001');
    assert.equal(snap002After.parentSnapshotId, 'snap-002-before');

    const branches = listBranches(tmpWs);
    assert.equal(branches.length, 2);
    const branchB = branches.find((b) => b.id === 'branch-b-doublet')!;
    assert.equal(branchB.baseSnapshotId, 'snap-002-before');
    assert.equal(branchB.headSnapshotId, 'snap-002-before');
    assert.deepEqual(branchB.unadoptedRunIds, ['run-002']);
    assert.deepEqual(branchB.adoptedRunIds, []);

    // 2. Verify eval-rms-spot historical drift & missing_on_disk v0.2
    const evalRms = getComponent('eval-rms-spot', tmpWs)!.dossier;
    const v01 = evalRms.versions.find((v) => v.version === 'v0.1')!;
    const v02 = evalRms.versions.find((v) => v.version === 'v0.2')!;
    assert.equal(v01.lifecycle, 'frozen');
    assert.equal(v01.casAvailable, true);
    assert.equal(
      v01.immutableBlobHash,
      '0b2d535914f6e07f262e4421f48c91e0fbb78d912360c5b20e7bf9ef66cb2f8b',
    );
    assert.equal(v01.sourceAvailability, 'historical_hash_drifted');
    assert.ok(
      v01.historicalDriftedHashes?.some(
        (h) =>
          h.runId === 'run-001' &&
          h.recordedCodeHash === 'a3b03826e7ce6dccbaac59ab5eb8f46b479bbd41b3ce7a3817f66939ce062b55',
      ),
    );
    assert.equal(v02.lifecycle, 'draft');
    assert.equal(v02.sourceAvailability, 'missing_on_disk');
    assert.equal(v02.casAvailable, false);
    assert.equal(fs.existsSync(path.join(tmpWs, 'components', 'eval-rms-spot', 'v0.2', 'impl.mjs')), false);

    // 3. Verify RunSupplements provenance & non-duplication
    const supplements = listRunSupplements(tmpWs);
    assert.equal(supplements.length, 5);
    const run1Init = supplements.find((s) => s.legacyOriginalId === 'ev-1794854860076-init')!;
    const run1Post = supplements.find((s) => s.legacyOriginalId === 'ev-1794855148534-48uq')!;
    assert.equal(run1Init.supplementKind, 'initial_run_evaluation');
    assert.equal(run1Post.supplementKind, 'post_hoc_reevaluation');

    const hydratedRuns = listRuns(tmpWs);
    const run1 = hydratedRuns.find((r) => r.id === 'run-001')!;
    assert.equal(run1.evaluations.length, 2);
    assert.equal(run1.standaloneAnalyses?.length, 2);

    // 4. Verify ArchitectureMap parses migrated components & runs cleanly
    const map = buildArchitectureMap({
      rootDir: process.cwd(),
      components: listComponents(tmpWs),
      runs: hydratedRuns,
      runtimeEnv: detectRuntimeEnvironment(),
    });
    assert.ok(map.nodes.length > 0);

    // 5. Verify idempotency on repeat migration run
    const stateBeforeRepeat = canonicalJson({
      ros: listResearchObjects(tmpWs),
      snaps: listSnapshots(tmpWs),
      branches: listBranches(tmpWs),
      sups: listRunSupplements(tmpWs),
      files: collectWorkspaceFiles(tmpWs).map((f) => ({ path: f.relativePath, sha256: f.sha256 })),
    });

    const result2 = migrateWorkspaceToStageA1(tmpWs);
    assert.equal(result2.success, true);

    const stateAfterRepeat = canonicalJson({
      ros: listResearchObjects(tmpWs),
      snaps: listSnapshots(tmpWs),
      branches: listBranches(tmpWs),
      sups: listRunSupplements(tmpWs),
      files: collectWorkspaceFiles(tmpWs).map((f) => ({ path: f.relativePath, sha256: f.sha256 })),
    });
    assert.equal(stateAfterRepeat, stateBeforeRepeat);

    // 6. Verify subsequent append-only post-hoc supplement survives repeat migration without duplication
    updateRunEvaluations(
      'run-001',
      {
        id: 'ev-new-posthoc',
        evaluatorId: 'eval-rms-spot',
        evaluatorName: 'RMS',
        evaluatorVersion: 'v0.1',
        evaluatorCodeHash: sha256('x'),
        evaluatedAt: '2026-11-16T22:00:00.000Z',
        passed: false,
        status: 'fail',
        lossScore: 100,
        summary: 'posthoc check',
        checks: [],
        uncertainties: [],
      },
      undefined,
      tmpWs,
    );
    migrateWorkspaceToStageA1(tmpWs);
    assert.equal(listRunSupplements(tmpWs).length, 6);
    assert.equal(listRuns(tmpWs).find((r) => r.id === 'run-001')!.evaluations.length, 3);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
