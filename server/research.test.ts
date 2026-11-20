import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactContract, WorkflowRecipe } from '../src/core/researchTypes.ts';
import { ResearchEngine } from './research_engine.ts';
import { createNewComponent } from './workbench.ts';
import { approveComponentVersion } from './storage.ts';
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
