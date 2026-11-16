import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildArchitectureMap } from '../src/core/architectureMap.ts';
import {
  auditWorkspaceAndBuildMigrationPlan,
  collectWorkspaceFiles,
  createPreStageABackup,
  verifyBackupRestore,
} from './a0_audit.ts';
import { detectRuntimeEnvironment, listComponents, listRuns } from './storage.ts';

test('A0: backup excludes only exact .backups/.migration_tmp dirs, preserves other hidden files, outputs excludedPaths, and passes isolated restore check', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a0-test-'));
  try {
    const ws = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(path.join(ws, 'components', 'demo', 'v0.1'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'runs.jsonl'), '{"id":"r1"}\n', 'utf8');
    fs.writeFileSync(path.join(ws, '.openlab-note'), 'keep-me\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'components', 'demo', 'dossier.json'), '{"id":"demo"}', 'utf8');
    fs.writeFileSync(path.join(ws, 'components', 'demo', 'v0.1', 'impl.mjs'), 'export const x = 1;', 'utf8');

    // Create first backup
    const b1 = createPreStageABackup(ws, 't1');
    assert.equal(b1.manifest.totalFiles, 4);
    assert.ok(b1.manifest.files.some((f) => f.relativePath === '.openlab-note'));
    assert.ok(b1.manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.deepEqual(b1.manifest.excludedPaths, []);

    // Create second backup — MUST skip `.backups/` and record it in excludedPaths while preserving `.openlab-note`!
    const b2 = createPreStageABackup(ws, 't2');
    assert.equal(b2.manifest.totalFiles, 4);
    assert.ok(b2.manifest.files.some((f) => f.relativePath === '.openlab-note'));
    assert.ok(!b2.manifest.files.some((f) => f.relativePath.includes('.backups')));
    assert.deepEqual(b2.manifest.excludedPaths, ['.backups/']);

    const verify = verifyBackupRestore(b2.backupDir, ws);
    assert.equal(verify.passed, true);
    assert.equal(verify.restoredMatchesManifest, true);
    assert.equal(verify.liveMatchesManifest, true);
    assert.deepEqual(verify.mismatches, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('A0: read-only audit on real workspace leaves formal data untouched, excludes .backups from ArchitectureMap, and respects parentSnapshotId uncertainty', () => {
  const repoRoot = process.cwd();
  const realWs = path.join(repoRoot, 'workspace');
  const beforeFiles = collectWorkspaceFiles(realWs);

  const plan = auditWorkspaceAndBuildMigrationPlan(realWs, repoRoot);

  // Confirm read-only: zero files added/modified/deleted outside .backups
  const afterFiles = collectWorkspaceFiles(realWs);
  assert.deepEqual(afterFiles, beforeFiles);

  // Constraint 3: snap-002-before MUST NOT invent confirmed parentSnapshotId = 'snap-001'
  const snap2Before = plan.snapshots.find((s) => s.id === 'snap-002-before');
  assert.ok(snap2Before);
  assert.equal(snap2Before.parentSnapshotId, null);
  assert.equal(snap2Before.legacyParentRunId, 'run-001');

  // Verify existing component versions referenced by runs.jsonl are flagged to freeze in A1
  const frozenIds = plan.componentAudit
    .filter((c) => c.versions.some((v) => v.mustFreezeInA1))
    .map((c) => c.id)
    .sort();
  assert.deepEqual(frozenIds, [
    'analysis-aberration-summary',
    'eval-mtf-chromatic',
    'eval-rms-spot',
    'opt-nelder-mead',
    'solver-ts-preview',
  ]);

  // Verify A0 audit surfaces real historical anomalies (eval-rms-spot@v0.2 missing file + run-001 v0.1 hash drift)
  assert.ok(plan.findings.some((f) => f.area.includes('非活跃组件版本磁盘缺失')));
  assert.ok(plan.findings.some((f) => f.area.includes('历史 ExperimentRun 与当前磁盘组件哈希漂移')));

  // Verify Architecture Map never flags `.backups` as an unmapped component directory
  const map = buildArchitectureMap({
    rootDir: repoRoot,
    components: listComponents(),
    runs: listRuns(),
    runtimeEnv: detectRuntimeEnvironment(),
  });
  assert.equal(
    map.nodes.some((n) => n.id.includes('.backups') || n.label.includes('.backups')),
    false,
  );
});
