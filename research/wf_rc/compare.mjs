import fs from 'node:fs';
import path from 'node:path';

const job = JSON.parse(fs.readFileSync(0, 'utf8'));
const rows = Object.entries(job.inputs).map(([method, input]) => {
  const data = JSON.parse(fs.readFileSync(input.path, 'utf8'));
  return {
    method, evaluation_id: input.id, system: data.system, field_deg: data.field_deg, exposure_sha256: data.exposure_sha256,
    truth_id: data.truth_id, catalog_id: data.catalog_id, sky_artifact_id: data.sky_artifact_id,
    radius_px: data.radius_px, truth_total: data.truth_total, truth_eligible: data.truth_eligible,
    detected: data.detected, matched: data.matched, missed: data.missed, false_detections: data.false_detections,
    scored_detections: data.evaluated_detections, ignored_edge_detections: data.edge_detections_ignored,
    completeness: data.completeness, precision: data.precision, field_retention: data.field_retention,
    position_rms_px: data.position_rms_px, position_rms_arcsec: data.position_rms_arcsec,
    faint_completeness: data.by_flux.find((group) => group.group === 'faint')?.completeness ?? null,
  };
});
if (new Set(rows.map((row) => row.exposure_sha256)).size !== 1 || new Set(rows.map((row) => row.truth_id)).size !== 1 ||
    new Set(rows.map((row) => row.radius_px)).size !== 1) {
  throw new Error('Comparisons require the same FITS, truth artifact and matching radius');
}
fs.writeFileSync(path.join(job.outputDir, 'comparison.json'), JSON.stringify({ rows }, null, 2));
fs.writeFileSync(job.manifestPath, JSON.stringify({ outputs: { comparison: 'comparison.json' } }));
console.log('Compared', rows.length, 'evaluations');
