import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildArchitectureMap,
  diffArchitectureSnapshots,
} from './architectureMap.ts';
import type { ComponentDossier, ExperimentRun, RuntimeEnvironmentSnapshot } from './types.ts';
import { traceOpticalSystem } from './optics.ts';

function makeRuntimeEnv(optilandInstalled = false): RuntimeEnvironmentSnapshot {
  return {
    hostMode: optilandInstalled ? 'local_python_ready' : 'cloud_preview',
    nodeVersion: process.version,
    pythonVersion: '3.10.12',
    pythonOkForOptiland: false,
    optilandVersion: optilandInstalled ? '0.5.8' : null,
    numpyVersion: null,
    scipyVersion: null,
    platform: `${process.platform}-${process.arch}`,
  };
}

function makeTempWorkspace(): {
  rootDir: string;
  components: ComponentDossier[];
  runs: ExperimentRun[];
  cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-arch-test-'));
  fs.mkdirSync(path.join(rootDir, 'workspace', 'components', 'arch-map-engine', 'v0.1'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'workspace', 'components', 'eval-rms-spot', 'v0.1'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'server'), { recursive: true });

  fs.writeFileSync(
    path.join(rootDir, 'src', 'core', 'architectureMap.ts'),
    "import { traceOpticalSystem } from './optics.ts';\nexport const x = 1;\n",
  );
  fs.writeFileSync(path.join(rootDir, 'src', 'core', 'optics.ts'), 'export function traceOpticalSystem() {}\n');
  fs.writeFileSync(
    path.join(rootDir, 'server', 'storage.ts'),
    "import { traceOpticalSystem } from '../src/core/optics.ts';\n",
  );

  const archDossier: ComponentDossier = {
    id: 'arch-map-engine',
    name: '整体架构地图引擎',
    kind: 'architecture_map',
    runtime: 'builtin_engine',
    activeVersion: 'v0.1',
    summary: '自描述架构地图引擎',
    purpose: '映射系统自身',
    capabilityBoundary: '有限扫描',
    inputs: [],
    outputs: [],
    dependencies: [{ kind: 'module', targetId: 'src/core/architectureMap.ts', reason: '核心引擎' }],
    compatibility: [],
    assumptions: [],
    limits: [],
    editableParts: [],
    parameters: [],
    versions: [
      {
        version: 'v0.1',
        createdAt: '2026-01-01T00:00:00.000Z',
        parentVersion: null,
        author: 'system',
        changeSummary: 'init',
        codeHash: 'a'.repeat(64),
        params: {},
        codeFile: 'impl.mjs',
      },
    ],
    selfCheck: { status: 'passed', checkedAt: '2026-01-01T00:00:00.000Z', checkedCodeHash: 'a'.repeat(64), summary: 'ok' },
    scientificValidation: { status: 'validated_reference', basis: 'test', caveats: [] },
    codeSecurityReview: {
      status: 'builtin_reviewed',
      approvedHash: 'a'.repeat(64),
      reviewedBy: 'system',
      reviewedAt: '2026-01-01T00:00:00.000Z',
      executionModelNote: 'readonly',
    },
  };

  const evalDossier: ComponentDossier = {
    ...archDossier,
    id: 'eval-rms-spot',
    name: 'RMS 评价器',
    kind: 'evaluator',
    runtime: 'local_process_mjs',
    dependencies: [],
  };

  fs.writeFileSync(
    path.join(rootDir, 'workspace', 'components', 'arch-map-engine', 'dossier.json'),
    JSON.stringify(archDossier),
  );
  fs.writeFileSync(
    path.join(rootDir, 'workspace', 'components', 'eval-rms-spot', 'dossier.json'),
    JSON.stringify(evalDossier),
  );

  const spec = {
    name: 'Test',
    description: 'Test',
    entrancePupilDiameterMm: 10,
    fieldAnglesDeg: [0],
    wavelengthsNm: [587.56],
    targetEflMm: 100,
    focusMode: 'paraxial_d' as const,
    surfaces: [
      { id: 's1', label: 'F', radiusMm: 100, thicknessMm: 2, semiApertureMm: 10, glassAfter: 'N-BK7' as const },
      { id: 's2', label: 'B', radiusMm: -100, thicknessMm: 0, semiApertureMm: 10, glassAfter: 'AIR' as const },
    ],
  };
  const trace = traceOpticalSystem(spec);
  const run: ExperimentRun = {
    id: 'run-001',
    sequenceNumber: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentRunId: null,
    branchLabel: '基线',
    intent: 'test',
    mode: 'solve_only',
    seed: 42,
    runtimeEnv: makeRuntimeEnv(false),
    composition: {
      pattern: 'solve_and_evaluate',
      parts: [
        {
          slot: 'evaluator',
          componentId: 'eval-rms-spot',
          componentName: 'RMS 评价器',
          kind: 'evaluator',
          version: 'v0.1',
          codeHash: 'a'.repeat(64),
          paramsSnapshot: {},
        },
      ],
    },
    systemBefore: spec,
    systemAfter: spec,
    rawArtifactsBefore: trace,
    rawArtifactsAfter: trace,
    optimizationTrace: [],
    evaluations: [],
    inputHash: 'b'.repeat(64),
    rawArtifactsHash: 'c'.repeat(64),
    recordIntegrityHash: 'd'.repeat(64),
    tamperStatus: 'verified',
    executionMs: 5,
    status: 'completed',
  };

  return {
    rootDir,
    components: [archDossier, evalDossier],
    runs: [run],
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

test('Architecture Map builds bounded self-referencing graph with explicit provenance and real import edges', () => {
  const ws = makeTempWorkspace();
  try {
    const map = buildArchitectureMap({
      rootDir: ws.rootDir,
      components: ws.components,
      runs: ws.runs,
      runtimeEnv: makeRuntimeEnv(false),
    });

    // Self-reference edge exists once, bounded
    const selfRefs = map.edges.filter((e) => e.isSelfReference);
    assert.equal(selfRefs.length, 1);
    assert.equal(selfRefs[0].source, 'comp:arch-map-engine');
    assert.equal(selfRefs[0].target, 'scope:openlab-bench');
    assert.equal(selfRefs[0].relation, 'represents');

    // Every edge has valid provenance and evidence
    for (const edge of map.edges) {
      assert.ok(['scanned', 'observed', 'declared', 'manual', 'inferred'].includes(edge.provenance));
      assert.ok(edge.evidence.length > 0);
    }

    // Real static import edge scanned
    const importEdge = map.edges.find(
      (e) =>
        e.source === 'mod:src/core/architectureMap.ts' &&
        e.target === 'mod:src/core/optics.ts' &&
        e.relation === 'depends_on',
    );
    assert.ok(importEdge);
    assert.equal(importEdge.provenance, 'scanned');

    // Observed run usage edge
    const observedRunUse = map.edges.find(
      (e) => e.source === 'run:run-001' && e.target === 'comp:eval-rms-spot' && e.relation === 'uses',
    );
    assert.ok(observedRunUse);
    assert.equal(observedRunUse.provenance, 'observed');
  } finally {
    ws.cleanup();
  }
});

test('Architecture Map detects unmapped folders, disk hash tamper, tampered runs, and snapshot diffs', () => {
  const ws = makeTempWorkspace();
  try {
    const before = buildArchitectureMap({
      rootDir: ws.rootDir,
      components: ws.components,
      runs: ws.runs,
      runtimeEnv: makeRuntimeEnv(false),
    });

    // Add unmapped directory + mark component diskTamperDetected + mark run tampered
    fs.mkdirSync(path.join(ws.rootDir, 'workspace', 'components', 'mystery-folder'), { recursive: true });
    ws.components[1].diskTamperDetected = true;
    ws.runs[0].tamperStatus = 'tampered';

    const after = buildArchitectureMap({
      rootDir: ws.rootDir,
      components: ws.components,
      runs: ws.runs,
      runtimeEnv: makeRuntimeEnv(false),
    });

    assert.ok(after.anomalies.some((a) => a.code === 'unmapped_directory' && a.nodeId === 'unmapped:mystery-folder'));
    assert.ok(after.anomalies.some((a) => a.code === 'disk_hash_mismatch' && a.nodeId === 'comp:eval-rms-spot'));
    assert.ok(after.anomalies.some((a) => a.code === 'tampered_run_record' && a.nodeId === 'run:run-001'));

    const diff = diffArchitectureSnapshots(before, after);
    assert.ok(diff.addedNodes.some((n) => n.id === 'unmapped:mystery-folder'));
    assert.ok(diff.changedNodes.some((c) => c.id === 'comp:eval-rms-spot' && c.afterStatus === 'error'));
  } finally {
    ws.cleanup();
  }
});
