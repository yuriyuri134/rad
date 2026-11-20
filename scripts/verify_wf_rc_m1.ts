import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { ResearchEngine } from '../server/research_engine.ts';
import { installWfRcComponents, buildWfRcRecipe } from '../server/wf_rc.ts';
import { resolveWorkspaceDir } from '../server/storage.ts';

const destination = process.argv[2];
assert.ok(destination, 'Supply a new, independent validation workspace');
const workspace = path.resolve(destination);
assert.notEqual(workspace, resolveWorkspaceDir());
assert.ok(!fs.existsSync(workspace), 'Validation workspace already exists');
installWfRcComponents(workspace);
const engine = new ResearchEngine(workspace);
const recipe = await buildWfRcRecipe(engine.store, process.argv.includes('--smoke') ? { systems: ['S3'], fields: [0.6] } : {});
const run = engine.startRecipe(recipe);
console.log('Started', run.record.id, 'at', workspace);
const progress = setInterval(() => {
  const current = engine.store.getRecipeRun(run.record.id);
  console.log(Object.keys(current?.executions ?? {}).length, '/', recipe.steps.length, 'steps started');
}, 15000);
const completed = await run.done.finally(() => clearInterval(progress));
assert.equal(completed.status, 'completed', completed.error);
const rows = [];
for (const step of recipe.steps.filter((item) => item.componentId === 'wf-compare')) {
  const execution = engine.store.getExecution(completed.executions[step.id])!;
  const report = JSON.parse(fs.readFileSync(await engine.store.openArtifact(execution.outputs.comparison), 'utf8'));
  assert.equal(report.rows.length, 3);
  const matched = report.rows;
  assert.equal(new Set(matched.map((row: { exposure_sha256: string }) => row.exposure_sha256)).size, 1);
  for (const row of matched) {
    const evaluation = engine.store.listArtifacts().find((artifact) => artifact.id === row.evaluation_id)!;
    const raw = JSON.parse(fs.readFileSync(await engine.store.openArtifact(evaluation), 'utf8'));
    assert.equal(raw.matches.length, row.matched);
    assert.equal(new Set(raw.matches.map((pair: { truth_id: number }) => pair.truth_id)).size, row.matched);
    assert.equal(new Set(raw.matches.map((pair: { detection_id: number }) => pair.detection_id)).size, row.matched);
    assert.equal(raw.missed_truth_ids.length, row.missed);
    assert.equal(raw.false_detection_ids.length, row.false_detections);
    assert.equal(row.field_retention, row.truth_eligible / row.truth_total);
    assert.equal(row.completeness, row.matched / row.truth_eligible);
    assert.equal(row.precision, row.matched / row.scored_detections);
    rows.push(row);
  }
}
assert.equal(rows.length, process.argv.includes('--smoke') ? 3 : 48);
for (const field of new Set(rows.map((row) => row.field_deg))) {
  assert.equal(new Set(rows.filter((row) => row.field_deg === field).map((row) => row.sky_artifact_id)).size, 1);
}
const target = recipe.steps.filter((step) => step.componentId === 'wf-score').slice(-1)[0];
const replay = await engine.startRecipe(recipe, { continuedFrom: completed.id, rerunStep: target.id }).done;
assert.equal(replay.status, 'completed', replay.error);
assert.notEqual(replay.executions[target.id], completed.executions[target.id]);
for (const step of recipe.steps.filter((item) => item.componentId === 'wf-exposure-render')) {
  assert.equal(replay.executions[step.id], completed.executions[step.id]);
}
fs.writeFileSync(path.join(workspace, 'verification.json'), JSON.stringify({ runId: completed.id, replayId: replay.id, rows }, null, 2));
console.log('Verified', rows.length, 'evaluations and selective replay', replay.id);
