import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactContract, ArtifactPort, RecipeInput, RecipeStep, WorkflowRecipe } from '../src/core/researchTypes.ts';
import type { CodeSecurityReviewState, ComponentDossier } from '../src/core/types.ts';
import { readVerifiedSource } from './process.ts';
import { checkId, controlledFile, validateContract, type ResearchStore } from './research_store.ts';
import { getWorkspacePaths, resolveRepoRoot } from './storage.ts';

const studyId = 'study-wf-rc-1000';
const systems = ['S1', 'S2', 'S3', 'S4'];
const fields = [0, 0.25, 0.42, 0.6];
type Source = { path: string; sha256: string };
interface Bundle {
  version: string;
  prescriptionPort: ArtifactPort;
  prescriptions: Record<string, Source>;
  components: Array<{ id: string; name: string; entry: Source; local: Source[]; contract: ArtifactContract }>;
}

function loadBundle() {
  const root = resolveRepoRoot();
  const descriptor = controlledFile(root, 'research/wf_rc/components.json');
  return JSON.parse(fs.readFileSync(descriptor, 'utf8')) as Bundle;
}

export function installWfRcComponents(workspaceDir?: string) {
  const root = resolveRepoRoot();
  const bundle = loadBundle();
  const { componentsDir } = getWorkspacePaths(workspaceDir);
  fs.mkdirSync(componentsDir, { recursive: true });
  for (const component of bundle.components) {
    checkId(component.id, '组件');
    checkId(bundle.version, '版本');
    validateContract(component.contract);
    const target = path.join(componentsDir, component.id);
    if (fs.existsSync(target)) continue;
    const pending = path.join(componentsDir, '.bundle-' + randomUUID());
    fs.mkdirSync(path.join(pending, bundle.version), { recursive: true });
    try {
      for (const source of [component.entry, ...component.local]) {
        const file = controlledFile(root, source.path);
        const verified = readVerifiedSource(file, source.sha256);
        fs.writeFileSync(path.join(pending, bundle.version, path.basename(file)), verified.code,
          { encoding: 'utf8', flag: 'wx' });
      }
      const review: CodeSecurityReviewState = {
        status: 'builtin_reviewed', approvedHash: component.entry.sha256,
        reviewedBy: 'OpenLab Bench project bundle', reviewedAt: null,
        executionModelNote: '本地账户执行。入口与声明依赖使用仓库中随版本交付的指纹核验。',
      };
      const contractFields = (ports: Record<string, ArtifactPort>) => Object.entries(ports).map(([name, port]) => ({
        name, type: port.schemaId, description: port.description ?? port.mediaType,
      }));
      const dossier: ComponentDossier = {
        id: component.id, name: component.name, kind: 'research_component',
        runtime: component.entry.path.endsWith('.py') ? 'local_process_py' : 'local_process_mjs',
        activeVersion: bundle.version, summary: component.name, purpose: component.name,
        capabilityBoundary: '通过文件协议使用已显式绑定的输入产物。',
        inputs: contractFields(component.contract.inputs), outputs: contractFields(component.contract.outputs),
        dependencies: component.local.map((source) => ({
          kind: 'module', targetId: 'local:' + path.basename(source.path), reason: '随版本固定的本地依赖',
        })),
        compatibility: ['openlab-files/v1'], assumptions: [], limits: [], editableParts: [], parameters: [],
        versions: [{
          version: bundle.version, createdAt: new Date().toISOString(), parentVersion: null,
          author: 'system', changeSummary: 'WF-RC M1 科研组件',
          codeHash: component.entry.sha256, codeFile: path.basename(component.entry.path), params: {},
          approval: review, lifecycle: 'draft', sourceAvailability: 'available_on_disk',
          pinnedRelativeDeps: component.local
            .map((source) => ({ relativePath: path.basename(source.path), codeHash: source.sha256 }))
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
          artifactContract: component.contract,
        }],
        selfCheck: { status: 'unrun', checkedAt: null, checkedCodeHash: null, summary: '从执行记录核对实际运行。' },
        scientificValidation: { status: 'unvalidated', basis: '合成曝光配对实验。', caveats: ['近似模型见逐星真值产物。'] },
        codeSecurityReview: review,
      };
      fs.writeFileSync(path.join(pending, 'dossier.json'), JSON.stringify(dossier, null, 2), 'utf8');
      fs.renameSync(pending, target);
    } finally {
      fs.rmSync(pending, { recursive: true, force: true });
    }
  }
}

export async function buildWfRcRecipe(store: ResearchStore, selection: { systems?: string[]; fields?: number[] } = {}) {
  const bundle = loadBundle();
  const selectedSystems = selection.systems ?? systems;
  const selectedFields = selection.fields ?? fields;
  if (!Array.isArray(selectedSystems) || !selectedSystems.length || new Set(selectedSystems).size !== selectedSystems.length ||
      !selectedSystems.every((item) => systems.includes(item)) ||
      !Array.isArray(selectedFields) || !selectedFields.length || new Set(selectedFields).size !== selectedFields.length ||
      !selectedFields.every((item) => fields.includes(item))) throw new Error('请选择 S1–S4 和受支持的视场');
  const root = resolveRepoRoot();
  const prescriptions = Object.fromEntries(await Promise.all(selectedSystems.map(async (system) => {
    const source = bundle.prescriptions[system];
    const artifact = await store.importArtifact(controlledFile(root, source.path), bundle.prescriptionPort, {
      studyId, importedFrom: source.path, expectedHash: source.sha256,
    });
    return [system, artifact.id];
  })));

  const recipe: WorkflowRecipe = { name: 'WF-RC-1000 · 共同星场检出对照', studyId, steps: [] };
  const step = (id: string, label: string, componentId: string, inputs: RecipeStep['inputs'], parameters: RecipeStep['parameters']) => {
    recipe.steps.push({ id, label, componentId, version: bundle.version, inputs, parameters });
  };
  const ref = (stepId: string, outputPort: string): RecipeInput => ({ stepId, outputPort });
  for (const field of selectedFields) {
    const fieldCode = String(Math.round(field * 1000));
    const sky = 'sky-' + fieldCode;
    step(sky, field + '° 共同星场', 'wf-shared-sky', {}, {
      field_deg: field, seed: 42 + Number(fieldCode), reference_efl_mm: 6000,
    });
    for (const system of selectedSystems) {
      const id = system + '-' + fieldCode;
      const render = 'render-' + id;
      const label = system + ' / ' + field + '°';
      step(render, label + ' 探测器模拟', 'wf-exposure-render', {
        sky: ref(sky, 'sky'), prescription: { artifactId: prescriptions[system] },
      }, { noise_seed: 10042 + Number(fieldCode) });
      const candidates = [
        { key: 'dao30', component: 'wf-dao-extract', parameters: { fwhm_px: 3, threshold_sigma: 4.5 } },
        { key: 'dao15', component: 'wf-dao-extract', parameters: { fwhm_px: 1.5, threshold_sigma: 4.5 } },
        { key: 'sep', component: 'wf-sep-extract', parameters: { threshold_sigma: 4.5, minarea: 4 } },
      ];
      const scores = Object.fromEntries(candidates.map(({ key, component, parameters }) => {
        const extract = 'extract-' + id + '-' + key;
        const score = 'score-' + id + '-' + key;
        step(extract, label + ' ' + key + ' 提取', component, { fits: ref(render, 'fits') }, parameters);
        step(score, label + ' ' + key + ' 真值匹配', 'wf-score', {
          truth: ref(render, 'truth'), catalog: ref(extract, 'catalog'),
        }, { radius_px: 4 });
        return [key, ref(score, 'evaluation')];
      }));
      step('compare-' + id, label + ' 对比', 'wf-compare', scores, {});
    }
  }
  return recipe;
}
