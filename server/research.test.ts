import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactContract, WorkflowRecipe } from '../src/core/researchTypes.ts';
import { ResearchEngine } from './research_engine.ts';
import { createNewComponent } from './workbench.ts';
import { approveComponentVersion, forkComponentVersion, getComponent, readCasBlob, saveComponentDraft, sha256 } from './storage.ts';
import { runLocalProcess } from './process.ts';

const readings = {
  schemaId: 'example/readings-v1', mediaType: 'application/json',
  jsonSchema: { type: 'array', items: { type: 'number' }, minItems: 1 },
};
const summary = {
  schemaId: 'example/summary-v1', mediaType: 'application/json',
  jsonSchema: { type: 'object', required: ['mean'], properties: { mean: { type: 'number' } } },
};
const textFile = { schemaId: 'example/report-v1', mediaType: 'text/plain' };

function add(ws: string, id: string, runtime: 'local_process_mjs' | 'local_process_py',
  inputs: ArtifactContract['inputs'], outputs: ArtifactContract['outputs'], codeContent: string) {
  const component = createNewComponent({
    id, name: id, summary: id, purpose: id, kind: 'analysis_plugin', runtime, codeContent,
    artifactContract: { protocol: 'openlab-files/v1', inputs, outputs },
  }, ws);
  return approveComponentVersion(component.id, 'v0.1', 'test', ws);
}

test('file protocol joins compatible artifacts across Node and Python, persists lineage and selectively replays', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-research-'));
  try {
    const engine = new ResearchEngine(ws);
    const input = path.join(ws, 'readings.json');
    fs.writeFileSync(input, '[2,4,9]');
    const artifact = await engine.store.importArtifact(input, readings, { studyId: 'example', importedFrom: 'test readings' });
    add(ws, 'mean-reading', 'local_process_mjs', { readings }, { summary, text: textFile }, `
      import fs from 'node:fs';
      import path from 'node:path';
      const m = JSON.parse(fs.readFileSync(0));
      const values = JSON.parse(fs.readFileSync(m.inputs.readings.path));
      const mean = values.reduce((a,b) => a+b,0) / values.length;
      fs.writeFileSync(path.join(m.outputDir, 'summary.json'), JSON.stringify({mean}));
      fs.writeFileSync(path.join(m.outputDir, 'report.txt'), 'sensor mean=' + mean);
      fs.writeFileSync(m.manifestPath, JSON.stringify({outputs:{summary:'summary.json',text:'report.txt'}}));
      console.log('published sensor mean');
    `);
    add(ws, 'compare-reading', 'local_process_py', { readings, summary }, { report: textFile }, `
import json, sys
from pathlib import Path
m = json.load(sys.stdin)
values = json.loads(Path(m['inputs']['readings']['path']).read_text())
mean = json.loads(Path(m['inputs']['summary']['path']).read_text())['mean']
Path(m['outputDir'], 'comparison.txt').write_text(str(max(values) - mean))
Path(m['manifestPath']).write_text(json.dumps({'outputs': {'report': 'comparison.txt'}}))
    `);
    const recipe: WorkflowRecipe = {
      name: 'Compare sensor readings', studyId: 'example',
      steps: [
        { id: 'calibrate', label: 'Summarize', componentId: 'mean-reading', version: 'v0.1',
          inputs: { readings: { artifactId: artifact.id } }, parameters: {} },
        { id: 'compare', label: 'Compare', componentId: 'compare-reading', version: 'v0.1',
          inputs: { readings: { artifactId: artifact.id }, summary: { stepId: 'calibrate', outputPort: 'summary' } }, parameters: {} },
      ],
    };
    const first = await engine.startRecipe(recipe).done;
    assert.equal(first.status, 'completed', first.error);
    const mean = engine.store.getExecution(first.executions.calibrate)!;
    const compare = engine.store.getExecution(first.executions.compare)!;
    assert.equal(compare.inputs.summary.id, mean.outputs.summary.id);
    assert.equal(compare.inputs.readings.id, artifact.id);
    assert.equal(compare.environment.runtime, 'python');
    assert.equal(fs.readFileSync(await engine.store.openArtifact(compare.outputs.report), 'utf8'), '4');
    assert.match(fs.readFileSync(engine.store.logPath(mean.id), 'utf8'), /published sensor mean/);
    const replay = await engine.startRecipe(recipe, { continuedFrom: first.id, rerunStep: 'compare' }).done;
    assert.equal(replay.status, 'completed', replay.error);
    assert.equal(replay.executions.calibrate, mean.id);
    assert.notEqual(replay.executions.compare, compare.id);
    assert.equal(engine.store.getExecution(compare.id)?.status, 'completed');
    assert.equal(engine.store.listArtifacts().length, 5);
    const standalone = await engine.rerunExecution(compare.id).done;
    assert.equal(standalone.status, 'completed', standalone.error);
    assert.equal(standalone.rerunOf, compare.id);
    assert.throws(() => engine.rerunExecution(compare.id, { inputs: { readings: artifact.id, summary: artifact.id } }), /Schema/);
    const badInput = path.join(ws, 'bad.json');
    fs.writeFileSync(badInput, '{"mean":9}');
    const mislabeled = await engine.store.importArtifact(badInput, {
      schemaId: readings.schemaId, mediaType: readings.mediaType,
    }, { studyId: 'example', importedFrom: 'unvalidated input' });
    const schemaFailure = await engine.startExecution({
      studyId: 'example', componentId: 'mean-reading', version: 'v0.1',
      inputs: { readings: mislabeled.id }, parameters: {},
    }).done;
    assert.equal(schemaFailure.status, 'failed');
    assert.match(schemaFailure.error ?? '', /JSON Schema/);
    assert.deepEqual(schemaFailure.outputs, {});
    fs.writeFileSync(await engine.store.openArtifact(artifact), '[3,4,9]');
    const failure = await engine.rerunExecution(compare.id).done;
    assert.equal(failure.status, 'failed');
    assert.match(failure.error ?? '', /SHA-256/);
    assert.deepEqual(failure.outputs, {});
    const staleId = 'interrupted-test';
    engine.store.saveExecution({ ...compare, id: staleId, status: 'running', outputs: {} });
    new ResearchEngine(ws).store.recoverInterrupted();
    assert.equal(engine.store.getExecution(staleId)?.status, 'failed');
    assert.deepEqual(engine.store.getExecution(staleId)?.outputs, {});
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('timeouts and cancellation terminate a running child within the forced-exit budget', async () => {
  const source = "process.on('SIGTERM', () => {}); setInterval(() => {}, 500); console.log('ready');";
  const startedAt = Date.now();
  await assert.rejects(runLocalProcess(process.execPath, ['-e', source], '', 350), /时间预算/);
  assert.ok(Date.now() - startedAt < 5500);
  const controller = new AbortController();
  await assert.rejects(runLocalProcess(process.execPath, ['-e', source], '', 6000, process.env, {
    signal: controller.signal,
    log: (chunk) => { if (chunk.toString().includes('ready')) controller.abort(); },
  }), /已取消/);
});

const reportScript = `
import fs from 'node:fs';
import path from 'node:path';
import { value } from './value.mjs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(path.join(input.outputDir, 'report.txt'), String(value * input.parameters.scale));
fs.writeFileSync(input.manifestPath, JSON.stringify({ outputs: { report: 'report.txt' } }));
`;

function configuredReporter(ws: string) {
  const componentId = 'sample-reporter';
  const contract: ArtifactContract = {
    protocol: 'openlab-files/v1', inputs: {}, outputs: { report: textFile },
    parameters: { type: 'object', required: ['scale'], properties: { scale: { type: 'number' } } },
  };
  createNewComponent({
    id: componentId, name: componentId, purpose: componentId, summary: componentId,
    kind: 'analysis_plugin', runtime: 'local_process_mjs', artifactContract: contract, codeContent: reportScript,
  }, ws);
  const directory = path.join(ws, 'components', componentId);
  const dependency = 'export const value = 3;';
  fs.writeFileSync(path.join(directory, 'v0.1', 'value.mjs'), dependency);
  approveComponentVersion(componentId, 'v0.1', 'test', ws);
  const dossierPath = path.join(directory, 'dossier.json');
  const approved = fs.readFileSync(dossierPath, 'utf8');
  const request = { studyId: 'example', componentId, version: 'v0.1', inputs: {}, parameters: { scale: 2 } };
  const recipe: WorkflowRecipe = {
    name: 'Reporter', studyId: 'example',
    steps: [{ id: 'report', label: 'Report', componentId, version: 'v0.1', inputs: {}, parameters: { scale: 2 } }],
  };
  return { approved, dependency, directory, dossierPath, request, recipe };
}

test('actual file execution freezes its approved source and dependency, rejecting same-version edits', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-research-freeze-'));
  try {
    const { approved, dependency, directory, dossierPath, request } = configuredReporter(ws);
    const engine = new ResearchEngine(ws);
    const result = await engine.startExecution(request).done;
    assert.equal(result.status, 'completed', result.error);
    const version = () => getComponent(request.componentId, ws)!.dossier.versions.find((item) => item.version === request.version)!;
    assert.equal(version().lifecycle, 'frozen');
    assert.deepEqual(version().frozenByExecutionIds, [result.id]);
    assert.equal(readCasBlob(version().immutableBlobHash!, ws), reportScript);
    assert.equal(readCasBlob(version().pinnedRelativeDeps![0].immutableBlobHash!, ws), dependency);

    assert.throws(() => saveComponentDraft({ ...request, codeContent: '// replaced' }, ws), /不可变版本保护.*派生版本/);

    // Restore the pre-M1.1 dossier layout. Startup must attach the completed run
    // without rewriting its historical execution record.
    const saved = engine.store.getExecution(result.id);
    fs.writeFileSync(dossierPath, approved);
    assert.throws(() => saveComponentDraft({ ...request, codeContent: '// replaced' }, ws), /不可变版本保护/);
    engine.recoverInterrupted();
    assert.deepEqual(version().frozenByExecutionIds, [result.id]);
    assert.deepEqual(engine.store.getExecution(result.id), saved);

    forkComponentVersion({
      componentId: request.componentId, baseVersion: request.version, newVersion: 'v0.2',
      changeSummary: 'new version', codeContent: reportScript, updatedParams: {},
    }, ws);
    assert.equal(fs.readFileSync(path.join(directory, 'v0.2', 'value.mjs'), 'utf8'), dependency);
    approveComponentVersion(request.componentId, 'v0.2', 'test', ws);
    const forked = await engine.startExecution({ ...request, version: 'v0.2' }).done;
    assert.equal(forked.status, 'completed', forked.error);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('recipe continuation never reuses a different component version or effective parameters', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-research-cache-'));
  try {
    const { request, recipe } = configuredReporter(ws);
    const engine = new ResearchEngine(ws);
    const first = await engine.startRecipe(recipe).done;
    assert.equal(first.status, 'completed', first.error);
    const same = await engine.startRecipe(recipe, { continuedFrom: first.id }).done;
    assert.equal(same.status, 'completed', same.error);
    assert.equal(same.executions.report, first.executions.report);

    const otherParams = await engine.startExecution({ ...request, parameters: { scale: 4 } }).done;
    forkComponentVersion({
      componentId: request.componentId, baseVersion: request.version, newVersion: 'v0.2',
      changeSummary: 'new version', codeContent: reportScript, updatedParams: {},
    }, ws);
    approveComponentVersion(request.componentId, 'v0.2', 'test', ws);
    const otherVersion = await engine.startExecution({ ...request, version: 'v0.2' }).done;
    for (const other of [otherParams, otherVersion]) {
      assert.equal(other.status, 'completed', other.error);
      const prior = { ...first, id: 'prior-' + other.id, executions: { report: other.id } };
      engine.store.saveRecipeRun(prior);
      const rerun = await engine.startRecipe(recipe, { continuedFrom: prior.id }).done;
      assert.equal(rerun.status, 'completed', rerun.error);
      assert.notEqual(rerun.executions.report, other.id);
      const output = engine.store.getExecution(rerun.executions.report)!;
      assert.equal(output.component.version, 'v0.1');
      assert.equal(fs.readFileSync(await engine.store.openArtifact(output.outputs.report), 'utf8'), '6');
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('recipe continuation rejects changed code, dependency hashes and contracts on an M1 version', async (t) => {
  for (const changed of ['main source', 'dependency', 'contract']) {
    await t.test(changed, async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-research-drift-'));
      try {
        const { approved, directory, dossierPath, recipe } = configuredReporter(ws);
        const engine = new ResearchEngine(ws);
        const first = await engine.startRecipe(recipe).done;
        assert.equal(first.status, 'completed', first.error);

        // Represent a pre-M1.1 workspace where the approved Draft could change in place.
        const dossier = JSON.parse(approved);
        const version = dossier.versions[0];
        if (changed === 'main source') {
          const replacement = reportScript + '\n// new M1 implementation\n';
          fs.writeFileSync(path.join(directory, 'v0.1', version.codeFile), replacement);
          version.codeHash = sha256(replacement);
          version.approval.approvedHash = version.codeHash;
        } else if (changed === 'dependency') {
          const replacement = 'export const value = 5;';
          fs.writeFileSync(path.join(directory, 'v0.1', 'value.mjs'), replacement);
          version.pinnedRelativeDeps[0].codeHash = sha256(replacement);
        } else {
          version.artifactContract.timeoutMs = 45000;
        }
        fs.writeFileSync(dossierPath, JSON.stringify(dossier));
        const continuation = await engine.startRecipe(recipe, { continuedFrom: first.id }).done;
        assert.equal(continuation.status, 'failed');
        assert.match(continuation.error ?? '', /代码、依赖或契约不一致.*派生/);
        assert.deepEqual(continuation.executions, {});
        assert.equal(engine.store.getExecution(first.executions.report)?.status, 'completed');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  }
});
