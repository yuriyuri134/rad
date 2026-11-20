import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ArtifactRecord, ExecutionRecord, RecipeRunRecord } from '../core/researchTypes.ts';
import type { ComponentDossier, FitsAnalysisResult } from '../core/types.ts';

export interface ResearchState {
  artifacts: ArtifactRecord[];
  executions: ExecutionRecord[];
  recipeRuns: RecipeRunRecord[];
}

const panel = 'max-w-[1440px] mx-auto my-4 p-4 border border-slate-200 rounded-md bg-white';
const fieldClass = 'border border-slate-300 rounded px-2 py-1 bg-white';
const buttonClass = 'px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-50';
const linkClass = 'text-blue-700 underline decoration-blue-300 underline-offset-2';
const statusText = { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };

export async function researchFetch<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? response.statusText);
  return value as T;
}

function ParameterDefaults(schema?: Record<string, unknown>) {
  const properties = (schema?.properties ?? {}) as Record<string, { default?: unknown }>;
  return JSON.stringify(Object.fromEntries(Object.entries(properties)
    .filter(([, value]) => value.default !== undefined).map(([key, value]) => [key, value.default])), null, 2);
}

export function ResearchRunControls({ studyId, components, state, refresh, openExecution, openComparison }: {
  studyId: string; components: ComponentDossier[]; state: ResearchState;
  refresh: () => Promise<void>; openExecution: (id: string) => void; openComparison: () => void;
}) {
  const available = components.flatMap((component) => component.versions
    .filter((version) => version.artifactContract && version.approval?.approvedHash === version.codeHash)
    .map((version) => ({ component, version, key: component.id + '@' + version.version })));
  const [choice, setChoice] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [parameters, setParameters] = useState('{}');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recipeId, setRecipeId] = useState('');
  const [stepId, setStepId] = useState('');
  const [systems, setSystems] = useState(['S3']);
  const [fields, setFields] = useState([0.6]);
  const selected = available.find((item) => item.key === choice);
  const contract = selected?.version.artifactContract;
  const recipes = state.recipeRuns.filter((item) => item.recipe.studyId === studyId);
  const recipe = recipes.find((item) => item.id === recipeId) ?? recipes[0];
  const progress = recipe?.recipe.steps.map((step) => ({
    step, execution: state.executions.find((run) => run.id === recipe.executions[step.id]),
  })) ?? [];
  const ongoing = progress.find(({ execution }) => execution?.status === 'running');
  const finished = progress.filter(({ execution }) => execution?.status === 'completed').length;
  const toggle = <T,>(values: T[], value: T) => values.includes(value)
    ? values.filter((item) => item !== value) : [...values, value].sort();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={panel} aria-label="科研执行">
      <h2 className="text-base font-semibold">科研执行</h2>
      {studyId === 'study-wf-rc-1000' && (
        <div className="my-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">共同星场对照</span>
          {['S1', 'S2', 'S3', 'S4'].map((item) => (
            <label key={item}><input checked={systems.includes(item)} onChange={() => setSystems(toggle(systems, item))} type="checkbox" /> {item}</label>
          ))}
          {[0, 0.25, 0.42, 0.6].map((item) => (
            <label key={item}><input checked={fields.includes(item)} onChange={() => setFields(toggle(fields, item))} type="checkbox" /> {item}°</label>
          ))}
          <button className={buttonClass} disabled={busy || !systems.length || !fields.length} onClick={() => run(async () => {
            const result = await researchFetch<RecipeRunRecord>('/api/research/wf-rc-1000', { systems, fields });
            setRecipeId(result.id);
          })}>开始 {systems.length * fields.length} 帧实算</button>
          <button className={buttonClass} onClick={() => { setSystems(['S1', 'S2', 'S3', 'S4']); setFields([0, 0.25, 0.42, 0.6]); }}>选择全部</button>
          {finished > 0 && <button className={linkClass} onClick={openComparison}>查看对比与产物</button>}
        </div>
      )}
      <details className="text-sm border-t border-slate-100 pt-2">
        <summary className="cursor-pointer font-medium">独立执行组件</summary>
        <div className="mt-2 space-y-2">
          <label className="block">能力 <select className={fieldClass} value={choice} onChange={(event) => {
            const next = available.find((item) => item.key === event.target.value);
            setChoice(event.target.value);
            setInputs({});
            setParameters(ParameterDefaults(next?.version.artifactContract?.parameters));
          }}>
            <option value="">选择已审批版本</option>
            {available.map((item) => <option key={item.key} value={item.key}>{item.component.name} · {item.version.version}</option>)}
          </select></label>
          {contract && selected && <>
            {Object.entries(contract.inputs).map(([port, descriptor]) => (
              <label className="block" key={port}>{port} <select className={fieldClass} value={inputs[port] ?? ''} onChange={(event) => setInputs({ ...inputs, [port]: event.target.value })}>
                <option value="">选择 {descriptor.schemaId}</option>
                {state.artifacts.filter((artifact) => artifact.schemaId === descriptor.schemaId && artifact.mediaType === descriptor.mediaType)
                  .map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.name} · {artifact.studyId} · {artifact.id.slice(-8)}</option>)}
              </select></label>
            ))}
            <label className="block">参数 JSON<textarea className={fieldClass + ' block w-full max-w-xl font-mono'} rows={4} value={parameters} onChange={(event) => setParameters(event.target.value)} /></label>
            <button className={buttonClass} disabled={busy || Object.keys(contract.inputs).some((key) => !inputs[key])} onClick={() => run(async () => {
              const started = await researchFetch<ExecutionRecord>('/api/research/executions', {
                studyId, componentId: selected.component.id, version: selected.version.version, inputs,
                parameters: JSON.parse(parameters),
              });
              openExecution(started.id);
            })}>启动组件</button>
          </>}
        </div>
      </details>
      {recipe && (
        <div className="mt-3 pt-3 border-t border-slate-200 text-sm space-y-2">
          <label>配方运行 <select className={fieldClass} value={recipe.id} onChange={(event) => { setRecipeId(event.target.value); setStepId(''); }}>
            {recipes.map((item) => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()} · {statusText[item.status]} · {item.id.slice(-8)}</option>)}
          </select></label>
          <div role="status">{statusText[recipe.status]} · {finished}/{recipe.recipe.steps.length} 步已完成{ongoing && ' · ' + ongoing.step.label}</div>
          {recipe.error && <p className="text-rose-700 whitespace-pre-wrap max-h-32 overflow-auto">{recipe.error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {recipe.status === 'running' && <button className={buttonClass} disabled={busy} onClick={() => run(async () => { await researchFetch('/api/research/cancel/' + recipe.id, {}); })}>取消</button>}
            {ongoing?.execution && <button className={linkClass} onClick={() => openExecution(ongoing.execution!.id)}>查看实时日志</button>}
            <label>步骤 <select className={fieldClass} value={stepId} onChange={(event) => setStepId(event.target.value)}>
              <option value="">选择步骤</option>
              {progress.map(({ step, execution }) => <option key={step.id} value={step.id}>{step.label} · {execution ? statusText[execution.status] : '等待'}</option>)}
            </select></label>
            {recipe.executions[stepId] && <button className={linkClass} onClick={() => openExecution(recipe.executions[stepId])}>打开执行</button>}
            {recipe.status !== 'running' && <button className={buttonClass} disabled={busy || (recipe.status === 'completed' && !stepId)} onClick={() => run(async () => {
              const next = await researchFetch<RecipeRunRecord>('/api/research/recipes/' + recipe.id + '/continue', stepId ? { rerunStep: stepId } : {});
              setRecipeId(next.id);
            })}>{stepId ? '重跑所选步骤和下游' : '续跑未完成步骤'}</button>}
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-rose-700 my-2 whitespace-pre-wrap">{error}</p>}
    </section>
  );
}

function PortList({ ports }: { ports: Record<string, { schemaId: string; mediaType: string }> }) {
  return <ul className="space-y-1">{Object.entries(ports).map(([name, port]) => (
    <li key={name}><code>{name}</code> · {port.schemaId} <span className="text-slate-500">{port.mediaType}</span></li>
  ))}{!Object.keys(ports).length && <li>无文件输入</li>}</ul>;
}

export function ResearchComponentContract({ dossier, state, openExecution }: {
  dossier?: ComponentDossier; state: ResearchState; openExecution: (id: string) => void;
}) {
  const versions = dossier?.versions.filter((version) => version.artifactContract) ?? [];
  if (!dossier || !versions.length) return null;
  return (
    <section className={panel} aria-label="文件执行契约">
      <h2 className="font-semibold">{dossier.name} · 文件执行契约</h2>
      {versions.map((version) => {
        const contract = version.artifactContract!;
        const uses = state.executions.filter((record) => record.component.componentId === dossier.id && record.component.version === version.version);
        return (
          <details key={version.version} open={version.version === dossier.activeVersion} className="text-sm mt-2">
            <summary className="cursor-pointer font-medium">{version.version} · {dossier.runtime} · {uses.length} 次执行</summary>
            <div className="mt-2 space-y-2">
              <div>{version.approval ? '审批来源 ' + version.approval.reviewedBy : '等待版本审批'} · <code className="break-all">{version.codeHash}</code></div>
              <div>命名输入 <PortList ports={contract.inputs} /></div>
              <div>命名输出 <PortList ports={contract.outputs} /></div>
              <details><summary>机器可读契约</summary><pre className="max-h-56 overflow-auto text-xs">{JSON.stringify(contract, null, 2)}</pre></details>
              {uses.length > 0 && <ul className="space-y-1">{uses.slice(0, 8).map((record) =>
                <li key={record.id}><button className={linkClass} onClick={() => openExecution(record.id)}>{statusText[record.status]} · {record.id} · {record.request.studyId}</button></li>
              )}</ul>}
            </div>
          </details>
        );
      })}
    </section>
  );
}

function FitsPreview({ result }: { result: FitsAnalysisResult }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [probe, setProbe] = useState('');
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(result.width, result.height);
    const scale = Math.max(result.madNoise * 20, 1);
    result.pixels.forEach((value, index) => {
      const intensity = Math.round(255 * Math.asinh(Math.max(0, Math.min(1, (value - result.medianSky) / scale)) * 6) / Math.asinh(6));
      const offset = index * 4;
      image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = intensity;
      image.data[offset + 3] = 255;
    });
    ctx.putImageData(image, 0, 0);
  }, [result]);
  return (
    <div className="space-y-2">
      <p>{result.objectName} · {result.width} × {result.height} · {result.wcs ? 'TAN WCS' : 'FITS'}</p>
      <canvas ref={canvas} width={result.width} height={result.height} aria-label="模拟探测器图像"
        className="rounded w-full max-w-[512px] border border-slate-200" onPointerMove={(event) => {
          const view = event.currentTarget.getBoundingClientRect();
          const x = Math.min(result.width - 1, Math.max(0, Math.floor((event.clientX - view.left) * result.width / view.width)));
          const y = Math.min(result.height - 1, Math.max(0, Math.floor((event.clientY - view.top) * result.height / view.height)));
          setProbe('x=' + x + ' y=' + y + ' · ' + result.pixels[y * result.width + x]?.toFixed(2) + ' ADU');
        }} />
      <p className="font-mono text-sm">{probe}</p>
      <details><summary>FITS 头</summary><pre className="max-h-64 overflow-auto text-xs">{result.headers.map((card) => card.keyword + ' = ' + card.value).join('\n')}</pre></details>
    </div>
  );
}

type ComparisonRow = {
  system: string; field_deg: number; method: string; truth_total: number; truth_eligible: number;
  field_retention: number | null; detected: number; matched: number; missed: number; false_detections: number;
  completeness: number | null; precision: number | null; position_rms_px: number | null; faint_completeness: number | null;
  evaluation_id: string; truth_id: string; catalog_id: string;
};
interface ArtifactPreview { artifact: ArtifactRecord; data?: unknown; fits?: FitsAnalysisResult; text?: string }

function percentage(value: number | null) {
  return value === null ? '—' : (100 * value).toFixed(1) + '%';
}

function ComparisonTable({ rows, inspect }: { rows: ComparisonRow[]; inspect: (id: string) => void }) {
  return <div className="overflow-auto max-h-[35rem]"><table className="min-w-full text-xs whitespace-nowrap">
    <thead className="bg-slate-100 sticky top-0">
      <tr>{['构型 / 视场', '方法', '有效 / 注入', '视场保持', '检出 / 匹配', '漏检 / 误检', '完备率', '精确率', '暗星完备率', '位置 RMS (px)', '证据'].map((label) =>
        <th className="p-2 text-left" key={label}>{label}</th>)}</tr>
    </thead>
    <tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.evaluation_id}>
      <td className="p-2">{row.system.split('_')[0]} · {row.field_deg.toFixed(2)}°</td><td className="p-2">{row.method}</td>
      <td className="p-2">{row.truth_eligible} / {row.truth_total}</td><td className="p-2">{percentage(row.field_retention)}</td>
      <td className="p-2">{row.detected} / {row.matched}</td><td className="p-2">{row.missed} / {row.false_detections}</td>
      <td className="p-2">{percentage(row.completeness)}</td><td className="p-2">{percentage(row.precision)}</td><td className="p-2">{percentage(row.faint_completeness)}</td>
      <td className="p-2">{row.position_rms_px?.toFixed(3) ?? '—'}</td>
      <td className="p-2 space-x-2">
        <button className={linkClass} onClick={() => inspect(row.evaluation_id)}>匹配</button>
        <button className={linkClass} onClick={() => inspect(row.truth_id)}>真值</button>
        <button className={linkClass} onClick={() => inspect(row.catalog_id)}>检出</button>
      </td>
    </tr>)}</tbody>
  </table></div>;
}

function DataTables({ data }: { data: unknown }) {
  if (!data || typeof data !== 'object') return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
  const record = data as Record<string, unknown>;
  const tableNames: Record<string, string> = {
    stars: '逐星真值', sources: '检测星表', matches: '一对一匹配', by_flux: '按通量分组',
    radius_sensitivity: '匹配半径敏感性', ignored_edge_matches: '边缘星匹配',
  };
  return <div className="space-y-2">
    {Object.entries(tableNames).map(([key, title]) => {
      const rows = record[key] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(rows)) return null;
      const heads = Object.keys(rows[0] ?? {});
      return (
        <details key={key} open={key !== 'ignored_edge_matches'}>
          <summary className="cursor-pointer">{title} · {rows.length}</summary>
          <div className="overflow-auto max-h-72">
            <table className="w-full whitespace-nowrap text-xs"><thead><tr>{heads.map((head) => <th key={head} className="text-left p-1">{head}</th>)}</tr></thead>
              <tbody>{rows.map((row, index) => <tr className="border-b border-slate-100" key={index}>{heads.map((head) => <td key={head} className="p-1">{typeof row[head] === 'number' ? Number(Number(row[head]).toPrecision(7)) : String(row[head] ?? '—')}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
      );
    })}
    <details><summary>完整 JSON 与方法说明</summary><pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(data, null, 2)}</pre></details>
  </div>;
}

export function ResearchArtifacts({ studyId, state, selectedId, inspect, openExecution }: {
  studyId: string; state: ResearchState; selectedId: string; inspect: (id: string) => void; openExecution: (id: string) => void;
}) {
  const artifacts = state.artifacts.filter((item) => item.studyId === studyId || item.id === selectedId);
  const runs = state.recipeRuns.filter((item) => item.recipe.studyId === studyId);
  const [recipeId, setRecipeId] = useState('');
  const run = runs.find((item) => item.id === recipeId) ?? runs[0];
  const compareIds = Object.values(run?.executions ?? {}).flatMap((id) => {
    const result = state.executions.find((record) => record.id === id);
    return Object.values(result?.outputs ?? {}).filter((item) => item.schemaId === 'astro/astrometry-comparison-v1').map((item) => item.id);
  }).join(',');
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [error, setError] = useState('');
  const [comparisonError, setComparisonError] = useState('');
  useEffect(() => {
    setPreview(null);
    setError('');
    if (!selectedId) return;
    const controller = new AbortController();
    researchFetch<ArtifactPreview>('/api/research/artifacts/' + selectedId + '?preview=1', undefined, controller.signal)
      .then(setPreview).catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [selectedId]);
  useEffect(() => {
    setComparison([]);
    setComparisonError('');
    if (!compareIds) return;
    const controller = new AbortController();
    Promise.all(compareIds.split(',').map((id) => researchFetch<{ data: { rows: ComparisonRow[] } }>(
      '/api/research/artifacts/' + id + '?preview=1', undefined, controller.signal,
    ))).then((reports) => {
      if (!controller.signal.aborted) setComparison(reports.flatMap((report) => report.data.rows));
    }).catch((cause) => { if (!controller.signal.aborted) setComparisonError(String(cause)); });
    return () => controller.abort();
  }, [compareIds]);
  const label = (artifact: ArtifactRecord) => {
    const execution = state.executions.find((item) => item.id === artifact.executionId);
    return [artifact.name, execution?.recipeStepId, artifact.id.slice(-8)].filter(Boolean).join(' · ');
  };
  return (
    <section className={panel + ' space-y-3 text-sm'} aria-label="科研产物与比较">
      <h2 className="text-base font-semibold">科研产物与比较</h2>
      {runs.length > 0 && <label>实算批次 <select className={fieldClass} value={run?.id ?? ''} onChange={(event) => setRecipeId(event.target.value)}>
        {runs.map((item) => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()} · {statusText[item.status]} · {item.id.slice(-8)}</option>)}
      </select></label>}
      {comparisonError && <p role="alert" className="text-rose-700">{comparisonError}</p>}
      {comparison.length > 0 && <ComparisonTable rows={comparison} inspect={inspect} />}
      <label className="block">查看产物 <select className={fieldClass + ' max-w-full'} value={selectedId} onChange={(event) => inspect(event.target.value)}>
        <option value="">{artifacts.length ? '选择 FITS、真值、星表或报告' : '此课题暂无已发布产物'}</option>
        {artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{label(artifact)}</option>)}
      </select></label>
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      {preview?.artifact && <div className="border-t border-slate-200 pt-2 space-y-2">
        <div className="flex gap-3 flex-wrap">
          <span>{preview.artifact.name} · {preview.artifact.schemaId}</span>
          <a className={linkClass} href={'/api/research/artifacts/' + preview.artifact.id}>下载原始文件</a>
          {preview.artifact.executionId && <button className={linkClass} onClick={() => openExecution(preview.artifact.executionId!)}>查看生成执行</button>}
        </div>
        <div className="font-mono break-all text-xs">SHA-256 {preview.artifact.sha256}</div>
        {preview.fits && <FitsPreview result={preview.fits} />}
        {preview.text !== undefined && <pre>{preview.text}</pre>}
        {preview.data !== undefined && <DataTables data={preview.data} />}
      </div>}
    </section>
  );
}

export function ResearchObservedMap({ state, openExecution, inspect }: {
  state: ResearchState; openExecution: (id: string) => void; inspect: (id: string) => void;
}) {
  const [id, setId] = useState('');
  const completed = state.executions.filter((item) => item.status === 'completed');
  const execution = completed.find((item) => item.id === id) ?? completed[0];
  return (
    <section className={panel + ' space-y-2 text-sm'} aria-label="已观察的科研执行关系">
      <h2 className="text-base font-semibold">已观察的科研执行关系</h2>
      {execution ? <>
        <label>执行 <select className={fieldClass} value={execution.id} onChange={(event) => setId(event.target.value)}>
          {completed.map((item) => <option key={item.id} value={item.id}>{item.recipeStepId ?? item.component.componentId} · {item.id.slice(-8)}</option>)}
        </select></label>
        <p>使用 <code>{execution.component.componentId}@{execution.component.version}</code> · <button className={linkClass} onClick={() => openExecution(execution.id)}>执行记录及代码指纹</button></p>
        <div className="grid gap-4 md:grid-cols-2">
          <div><h3 className="font-medium">实际消费</h3><ul>{Object.entries(execution.inputs).map(([port, artifact]) => (
            <li key={port}>{port} · <button className={linkClass} onClick={() => inspect(artifact.id)}>{artifact.name}</button>
              {artifact.executionId ? <> ← <button className={linkClass} onClick={() => openExecution(artifact.executionId!)}>{artifact.executionId}</button></> : <> ← {artifact.importedFrom}</>}
            </li>
          ))}</ul></div>
          <div><h3 className="font-medium">实际发布及下游</h3><ul>{Object.entries(execution.outputs).map(([port, artifact]) => {
            const consumers = completed.filter((item) => Object.values(item.inputs).some((input) => input.id === artifact.id));
            return <li key={port}>{port} · <button className={linkClass} onClick={() => inspect(artifact.id)}>{artifact.name}</button>
              <ul className="ml-3">{consumers.map((consumer) => <li key={consumer.id}>→ <button className={linkClass} onClick={() => openExecution(consumer.id)}>{consumer.recipeStepId ?? consumer.component.componentId} · {consumer.id.slice(-8)}</button></li>)}</ul>
            </li>;
          })}</ul></div>
        </div>
        <details><summary>本次执行绑定的组件声明</summary><pre className="max-h-56 overflow-auto text-xs">{JSON.stringify(execution.component.contract, null, 2)}</pre></details>
      </> : <p className="text-slate-500">完成科研执行后将在此显示真实产物关系。</p>}
    </section>
  );
}

export function ResearchExecutionDialog({ id, close, inspect, openExecution, refresh }: {
  id: string; close: () => void; inspect: (id: string) => void; openExecution: (id: string) => void; refresh: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [contents, setContents] = useState<{ record: ExecutionRecord; log: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function update() {
      try {
        const result = await researchFetch<{ record: ExecutionRecord; log: string }>('/api/research/executions/' + id, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setContents(result);
        if (result.record.status === 'running') timer = window.setTimeout(update, 1000);
      } catch (cause) {
        if (!controller.signal.aborted) setError(String(cause));
      }
    }
    void update();
    return () => { controller.abort(); if (timer) window.clearTimeout(timer); };
  }, [id]);
  async function mutate(url: string, rerun: boolean) {
    try {
      const result = await researchFetch<ExecutionRecord>(url, {});
      await refresh();
      if (rerun) openExecution(result.id);
      else {
        setError('');
        const updated = await researchFetch<typeof contents>('/api/research/executions/' + id);
        setContents(updated);
      }
    } catch (cause) {
      setError(String(cause));
    }
  }
  const record = contents?.record;
  const artifactLink = (artifact: ArtifactRecord): ReactNode => (
    <button className={linkClass} onClick={() => { close(); inspect(artifact.id); }}>{artifact.name} · {artifact.id.slice(-8)}</button>
  );
  return (
    <dialog ref={dialog} onCancel={close} className="rounded-lg max-w-4xl w-[90vw] max-h-[85vh] p-5 backdrop:bg-slate-900/40">
      <header className="flex justify-between items-center gap-3">
        <h2 className="text-lg font-semibold">科研执行记录</h2><button className={buttonClass} onClick={close}>关闭</button>
      </header>
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      {record ? (
        <div className="mt-3 space-y-3 text-sm">
          <p>{record.component.componentId}@{record.component.version} · {statusText[record.status]} · {record.id}</p>
          <p className="break-all font-mono text-xs">代码 SHA-256 {record.component.codeHash}</p>
          {record.error && <p className="text-rose-700 whitespace-pre-wrap">{record.error}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            <div><h3 className="font-medium">输入</h3>{Object.entries(record.inputs).map(([port, artifact]) => <div key={port}>{port} · {artifactLink(artifact)}</div>)}</div>
            <div><h3 className="font-medium">输出</h3>{Object.entries(record.outputs).map(([port, artifact]) => <div key={port}>{port} · {artifactLink(artifact)}</div>)}</div>
          </div>
          <details><summary>参数、源码指纹和运行环境</summary><pre className="max-h-52 overflow-auto text-xs">{JSON.stringify({ parameters: record.request.parameters, sources: record.component.sources, environment: record.environment }, null, 2)}</pre></details>
          <h3 className="font-medium">执行日志</h3>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap bg-slate-50 p-2 text-xs">{contents.log || '等待日志输出'}</pre>
          {record.status !== 'running' ?
            <button className={buttonClass} onClick={() => mutate('/api/research/executions/' + id + '/rerun', true)}>以原输入重新执行</button> :
            <button className={buttonClass} onClick={() => mutate('/api/research/cancel/' + id, false)}>取消执行</button>}
        </div>
      ) : <p className="text-sm mt-2">正在读取执行记录</p>}
    </dialog>
  );
}
