import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  addArchitectureAnnotation,
  adoptStudyBranch,
  createCustomStudy,
  createNewComponent,
  ensureWorkbenchInitialized,
  listArchitectureAnnotations,
  listPersistedArchSnapshots,
  listWorkbenchData,
  savePersistedArchSnapshot,
} from './workbench.ts';
import { buildDeterministicCollaboration } from './ai.ts';
import { buildArchitectureMap } from '../src/core/architectureMap.ts';
import { ensureWorkspaceInitialized } from './storage.ts';

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-wb-test-'));
  ensureWorkspaceInitialized(dir);
  return dir;
}

test('workbench seeds WF-RC-1000 with authentic S0-S4 metrics, 20 FITS tiles, and P1 read-only projection', () => {
  const ws = createTempWorkspace();
  try {
    ensureWorkbenchInitialized(ws);
    const wb = listWorkbenchData(ws);

    const wfStudy = wb.studies.find((s) => s.id === 'study-wf-rc-1000');
    const p1Study = wb.studies.find((s) => s.provenanceTier === 'historical_migrated');
    assert.ok(wfStudy, 'Expected WF-RC-1000 study to be seeded');
    assert.ok(p1Study, 'Expected P1 read-only study projection');
    assert.equal(wfStudy.provenanceTier, 'external_verified_import');
    assert.equal(p1Study.provenanceTier, 'historical_migrated');
    assert.equal(wfStudy.adoptedBranchId, 'branch-p2-s3');

    const s3 = wb.branches.find((b) => b.id === 'branch-p2-s3');
    assert.ok(s3);
    assert.ok(Math.abs(Number(s3.metrics.maxRmsPolyUm) - 1.063) < 0.05);
    assert.equal(wb.fitsCatalog.length, 20, 'Expected all 20 P2 FITS tiles in catalog');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('custom study creation, branch adoption, component authoring, and arch snapshots persist cleanly', () => {
  const ws = createTempWorkspace();
  try {
    const created = createCustomStudy(
      {
        title: '三镜离轴自由曲面光谱相机热稳定性',
        problemStatement: '验证铝合金支架温漂 ±10K 对像面位移的影响',
      },
      ws,
    );
    assert.equal(created.study.provenanceTier, 'workbench_native');
    assert.equal(created.branch.shortCode, 'B0');

    // Adopt S2 then back to S3 on WF-RC-1000
    const adopted = adoptStudyBranch('study-wf-rc-1000', 'branch-p2-s2', '测试切换采纳 S2', ws);
    assert.equal(adopted.study.adoptedBranchId, 'branch-p2-s2');
    assert.equal(adopted.branch.status, 'adopted');

    // Author a new component in temp workspace
    const dossier = createNewComponent(
      {
        id: 'test-fits-metric',
        name: 'FITS 测试评估器',
        kind: 'analysis_plugin',
        runtime: 'local_process_mjs',
        summary: '用于单元测试新建组件的磁盘写入',
        purpose: '单元测试',
        codeContent: 'console.log(JSON.stringify({ ok: true }));\n',
      },
      ws,
    );
    assert.equal(dossier.id, 'test-fits-metric');
    assert.ok(fs.existsSync(path.join(ws, 'components', 'test-fits-metric', 'v0.1', 'impl.mjs')));

    // Persisted snapshot & annotation
    const map = buildArchitectureMap({
      rootDir: process.cwd(),
      components: [],
      runs: [],
      runtimeEnv: {
        hostMode: 'cloud_preview',
        nodeVersion: process.version,
        pythonVersion: null,
        pythonOkForOptiland: false,
        optilandVersion: null,
        numpyVersion: null,
        scipyVersion: null,
        platform: process.platform,
      },
    });
    const snap = savePersistedArchSnapshot('测试快照', map, ws);
    assert.equal(listPersistedArchSnapshots(ws).length, 1);
    assert.equal(snap.nodeCount, map.nodes.length);

    addArchitectureAnnotation({ nodeId: 'study:study-wf-rc-1000', tag: 'fact', note: '已验证' }, ws);
    assert.equal(listArchitectureAnnotations(ws).length, 1);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('AI deterministic collaborator proposes fits_batch_completeness and wf_rc_s4_reopt_probe for WF-RC-1000 open questions', () => {
  const ws = createTempWorkspace();
  try {
    ensureWorkbenchInitialized(ws);
    const wb = listWorkbenchData(ws);
    const wfStudy = wb.studies.find((s) => s.id === 'study-wf-rc-1000')!;
    const wfBranches = wb.branches.filter((b) => b.studyId === wfStudy.id);

    const batchResp = buildDeterministicCollaboration({
      study: wfStudy,
      branches: wfBranches,
      executions: [],
      notes: [],
      fitsCatalog: wb.fitsCatalog,
      question: '批量全视场验证 16 帧 FITS 下 DAO fwhm=1.5px 能否对齐 SEP',
    });
    assert.equal(batchResp.proposedAction?.runnerMode, 'fits_batch_completeness');
    assert.equal(batchResp.proposedAction?.parameters.fwhmPx, 1.5);

    const s4Resp = buildDeterministicCollaboration({
      study: wfStudy,
      branches: wfBranches,
      executions: [],
      notes: [],
      fitsCatalog: wb.fitsCatalog,
      question: '请分析 S4 (FS+F2) 为什么卡在 cost=597.635，并建议多起点诊断',
    });
    assert.equal(s4Resp.proposedAction?.runnerMode, 'wf_rc_s4_reopt_probe');
    assert.equal(s4Resp.proposedAction?.parameters.strategy, 'unlock_conics_multi_seed');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('python workbench runner executes real fits_batch_completeness on S3 4-tile FITS frames when /tmp/p2_venv exists', () => {
  const pyExe = '/tmp/p2_venv/bin/python';
  if (!fs.existsSync(pyExe)) return;
  const out = execFileSync(
    pyExe,
    ['-u', 'python/workbench_p2_runner.py', '--mode', 'fits_batch_completeness'],
    {
      input: JSON.stringify({
        systemKeys: ['S3_3Lens_Wynne_FS_QuasiRC'],
        fwhmPx: 1.5,
        thresholdSigma: 4.5,
        sepThresholdSigma: 4.5,
        sepMinArea: 4,
        matchRadiusPx: 3.5,
      }),
      encoding: 'utf-8',
      timeout: 30000,
    },
  );
  const resultLine = out.split(/\r?\n/).find((l) => l.startsWith('RESULT_JSON:'));
  assert.ok(resultLine, 'Expected RESULT_JSON output line');
  const parsed = JSON.parse(resultLine.slice('RESULT_JSON:'.length));
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.tilesCount, 4);
  assert.ok(
    parsed.meanDaoMatchedToSepPct >= 70 && parsed.meanDaoMatchedToSepPct > parsed.meanStage3Dao3pxPct,
    `Expected DAO(1.5px) match rate >= 70% and > Stage3 baseline (${parsed.meanStage3Dao3pxPct}%), got ${parsed.meanDaoMatchedToSepPct}%`,
  );
});

test('legacy workspace/runs.jsonl SHA-256 digest remains completely intact', () => {
  const runsPath = path.join(process.cwd(), 'workspace', 'runs.jsonl');
  if (fs.existsSync(runsPath)) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(runsPath)).digest('hex');
    assert.equal(
      digest,
      '698ff3e99c846a050abb559620c3602f4e8af65bcd3e4688739b031e9e35b42d',
      'Legacy runs.jsonl SHA-256 must never change',
    );
  }
});

test('ensureWorkbenchInitialized and listWorkbenchData never duplicate seeded notes even if studies.json is re-seeded or JSONL has duplicate lines', () => {
  const ws = createTempWorkspace();
  try {
    ensureWorkbenchInitialized(ws);
    const wbDir = path.join(ws, 'workbench');
    // Simulate duplicate lines in notes.jsonl and missing studies.json
    const notesPath = path.join(wbDir, 'notes.jsonl');
    const originalNotes = fs.readFileSync(notesPath, 'utf8');
    fs.appendFileSync(notesPath, originalNotes, 'utf8');
    fs.unlinkSync(path.join(wbDir, 'studies.json'));

    ensureWorkbenchInitialized(ws);
    const wb = listWorkbenchData(ws);
    const noteIds = wb.notes.map((n) => n.id);
    assert.equal(new Set(noteIds).size, noteIds.length, 'Expected all note IDs to be unique');
    assert.equal(
      noteIds.filter((id) => id === 'note-p2-fact-s3').length,
      1,
      'note-p2-fact-s3 must appear exactly once',
    );
    assert.equal(
      noteIds.filter((id) => id === 'note-p2-judgment-shim').length,
      1,
      'note-p2-judgment-shim must appear exactly once',
    );
    assert.equal(
      noteIds.filter((id) => id === 'note-p2-hypothesis-fits').length,
      1,
      'note-p2-hypothesis-fits must appear exactly once',
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

