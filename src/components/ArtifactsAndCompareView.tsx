import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Database, FileCode2, GitCompare, Telescope } from 'lucide-react';
import type {
  ArtifactRef,
  FitsCatalogEntry,
  FitsSourceDetection,
  ProvenanceTier,
  ResearchStudy,
  StudyBranch,
  WorkflowExecution,
  ExperimentRun,
} from '../core/types.ts';
import { FitsWorkspace } from './FitsWorkspace.tsx';
import { RunComparison } from './RunComparison.tsx';

export type CompareSubTab = 'matrix' | 'fits' | 'artifacts';

interface ArtifactsAndCompareViewProps {
  study: ResearchStudy;
  branches: StudyBranch[];
  executions: WorkflowExecution[];
  artifacts: ArtifactRef[];
  fitsCatalog: FitsCatalogEntry[];
  legacyRuns: ExperimentRun[];
  activeSubTab: CompareSubTab;
  onChangeSubTab: (t: CompareSubTab) => void;
  initialFitsPath?: string | null;
  pythonFitsResult?: {
    extractor: string;
    fitsPath: string;
    detectedSources: FitsSourceDetection[];
    medianSkyAdu?: number;
    skyNoiseSigmaAdu?: number;
    medianFwhmPx?: number | null;
    medianFwhmArcsec?: number | null;
  } | null;
  onAdoptBranch: (studyId: string, branchId: string, reason?: string) => Promise<void>;
  onSelectFitsPath?: (fitsPath: string) => void;
  onTriggerPythonExtract: (params: {
    fitsPath: string;
    extractor: 'photutils_DAOStarFinder' | 'sep_extract';
    fwhmPx: number;
    thresholdSigma: number;
    apertureRadiusPx: number;
  }) => void;
  isJobRunning: boolean;
}

const PROVENANCE_LABEL: Record<ProvenanceTier, { text: string; cls: string }> = {
  external_verified_import: {
    text: '外部验证导入',
    cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  workbench_native: {
    text: '工作台原生实算',
    cls: 'bg-blue-50 text-blue-800 border-blue-200',
  },
  historical_migrated: {
    text: '历史迁移只读',
    cls: 'bg-slate-100 text-slate-700 border-slate-300',
  },
};

function fmtNum(val: unknown, digits = 3): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
  return val.toFixed(digits);
}

export function ArtifactsAndCompareView({
  study,
  branches,
  executions,
  artifacts,
  fitsCatalog,
  legacyRuns,
  activeSubTab,
  onChangeSubTab,
  initialFitsPath,
  pythonFitsResult,
  onAdoptBranch,
  onSelectFitsPath,
  onTriggerPythonExtract,
  isJobRunning,
}: ArtifactsAndCompareViewProps) {
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  const [selectedPrescriptionBranchId, setSelectedPrescriptionBranchId] = useState<string>('branch-p2-s3');

  const isP1Study = study.provenanceTier === 'historical_migrated';

  const opticalBranches = useMemo(
    () =>
      branches.filter(
        (b) =>
          typeof b.metrics.maxRmsPolyUm === 'number' ||
          typeof b.metrics.rms000Um === 'number',
      ),
    [branches],
  );

  const stage4Artifact = artifacts.find((artifact) => artifact.id === 'art-p2-stage4-tol');
  const [stage4, setStage4] = useState<{
    oat_sensitivities_bfl_12mm?: Array<Record<string, number | string>>;
    oat_m1_r1_with_m2_shim?: Record<string, number>;
  } | null>(null);
  useEffect(() => {
    if (!stage4Artifact) return;
    const controller = new AbortController();
    fetch('/api/fits/inspect-artifact?artifactId=' + encodeURIComponent(stage4Artifact.id), { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => { if (!controller.signal.aborted) setStage4(value); })
      .catch(() => { if (!controller.signal.aborted) setStage4(null); });
    return () => controller.abort();
  }, [stage4Artifact?.id, stage4Artifact?.sha256]);
  const stage4Metrics = branches.find((branch) => branch.id === 'branch-p2-s3')?.metrics;

  const prescriptionBranch =
    branches.find((b) => b.id === selectedPrescriptionBranchId) ??
    branches.find((b) => b.shortCode === 'S3') ??
    branches[0];
  const prescriptionLenses = Array.isArray(
    (prescriptionBranch?.prescription as Record<string, unknown> | undefined)?.lenses,
  )
    ? ((prescriptionBranch?.prescription as Record<string, unknown>).lenses as Array<Record<string, unknown>>)
    : [];

  if (isP1Study) {
    return (
      <div className="space-y-4">
        <div className="max-w-[1400px] mx-auto px-6 pt-5 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-slate-900">P1 历史单/双胶合光学方案对比</h1>
            <p className="text-xs text-slate-500">
              数据源：workspace/runs.jsonl 不可变账本（切换到 WF-RC-1000 可查看宽视场天文望远镜 S0–S4 矩阵与 20 帧 FITS）
            </p>
          </div>
          <div className="flex items-center gap-2 border-b border-slate-200">
            <button
              type="button"
              onClick={() => onChangeSubTab('matrix')}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 cursor-pointer ${
                activeSubTab === 'matrix'
                  ? 'border-blue-700 text-blue-700'
                  : 'border-transparent text-slate-600'
              }`}
            >
              P1 运行对比
            </button>
            <button
              type="button"
              onClick={() => onChangeSubTab('fits')}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 cursor-pointer ${
                activeSubTab === 'fits'
                  ? 'border-blue-700 text-blue-700'
                  : 'border-transparent text-slate-600'
              }`}
            >
              FITS 检验帧
            </button>
          </div>
        </div>
        {activeSubTab === 'fits' ? (
          <div className="max-w-[1400px] mx-auto px-6 pb-8">
            <FitsWorkspace
              catalog={fitsCatalog}
              initialCatalogPath={initialFitsPath}
              pythonSourcesOverride={pythonFitsResult}
              onTriggerPythonExtract={onTriggerPythonExtract}
              isJobRunning={isJobRunning}
            />
          </div>
        ) : (
          <RunComparison runs={legacyRuns} />
        )}
      </div>
    );
  }

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-6 space-y-6">
      {/* Sub-navigation strip */}
      <div className="bg-white border border-slate-200 rounded-md px-5 py-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-slate-900">
            {study.title} · 产物、仿真与 FITS 对比台
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            区分外部验证导入数据与工作台实时派生实算分支 · {branches.length} 个分支 · {fitsCatalog.length} 帧真实 FITS · {artifacts.length} 项校验产物
          </p>
        </div>

        <div className="flex items-center gap-1 border-b border-slate-200">
          {(
            [
              { id: 'matrix', label: 'S0–S4 与派生对比矩阵', icon: GitCompare },
              { id: 'fits', label: '2D FITS 星场与 WCS 检查器', icon: Telescope },
              { id: 'artifacts', label: '产物账本与 SHA-256 校验', icon: Database },
            ] as Array<{ id: CompareSubTab; label: string; icon: typeof GitCompare }>
          ).map((tab) => {
            const Icon = tab.icon;
            const active = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onChangeSubTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
                  active
                    ? 'border-blue-700 text-blue-700'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Sub-view 1: Multi-Branch Matrix + SVG Engineering Charts */}
      {activeSubTab === 'matrix' && (
        <div className="space-y-6">
          {/* Full Branch Matrix */}
          <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                全分支多维度评价矩阵（几何光学 · 衍射 PSF/MTF · 天体测量 · 装配公差）
              </h2>
              <span className="text-xs font-mono text-slate-500">
                红色为超标 · 蓝框为当前采纳基线
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-sans">
                  <tr>
                    <th className="px-3 py-2.5">分支</th>
                    <th className="px-3 py-2.5">来源可信层</th>
                    <th className="px-3 py-2.5">状态</th>
                    <th className="px-3 py-2.5">0° RMS (μm)</th>
                    <th className="px-3 py-2.5">0.60° RMS (μm)</th>
                    <th className="px-3 py-2.5">最大 RMS (&le;7.5)</th>
                    <th className="px-3 py-2.5">Strehl 0° / 0.6° (&ge;0.80)</th>
                    <th className="px-3 py-2.5">MTF@33.3</th>
                    <th className="px-3 py-2.5">畸变 %</th>
                    <th className="px-3 py-2.5">SEP 边缘完备度</th>
                    <th className="px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {branches.map((b) => {
                    const isAdopted = b.id === study.adoptedBranchId || b.status === 'adopted';
                    const prov = PROVENANCE_LABEL[b.provenanceTier];
                    const maxRms = b.metrics.maxRmsPolyUm;
                    const rmsFail = typeof maxRms === 'number' && maxRms > 7.5;
                    const sEdge = b.metrics.strehlEdge;
                    const strehlFail = typeof sEdge === 'number' && sEdge < 0.8;
                    const isFitsSingle = typeof b.metrics.detectedCount === 'number';
                    const isFitsBatch = typeof b.metrics.fitsBatchTilesCount === 'number';

                    return (
                      <tr
                        key={b.id}
                        className={isAdopted ? 'bg-blue-50/40' : 'hover:bg-slate-50'}
                      >
                        <td className="px-3 py-2.5 font-sans">
                          <div className="font-semibold text-slate-900">
                            {b.shortCode} · {b.name}
                          </div>
                          <div className="text-[11px] text-slate-500 max-w-xs truncate">{b.summary}</div>
                        </td>
                        <td className="px-3 py-2.5 font-sans whitespace-nowrap">
                          <span className={`inline-block px-1.5 py-0.5 text-[11px] border rounded-sm ${prov.cls}`}>
                            {prov.text}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-sans whitespace-nowrap">
                          {isAdopted ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold bg-blue-700 text-white rounded-sm">
                              <CheckCircle2 className="w-3 h-3" />
                              已采纳
                            </span>
                          ) : b.status === 'archived_blocked' ? (
                            <span className="text-amber-700 font-medium">预算受限阻塞</span>
                          ) : b.status === 'rejected' ? (
                            <span className="text-rose-700 font-medium">指标未通过</span>
                          ) : (
                            <span className="text-slate-600">{b.status === 'baseline' ? '基线对照' : '探索候选'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {isFitsBatch
                            ? `批量 ${b.metrics.fitsBatchTilesCount} 帧`
                            : isFitsSingle
                              ? 'FITS 单帧'
                              : fmtNum(b.metrics.rms000Um)}
                        </td>
                        <td className="px-3 py-2.5">
                          {isFitsBatch
                            ? `FWHM ${b.metrics.fwhmPx ?? '?'}px`
                            : isFitsSingle
                              ? `${b.metrics.detectedCount} 源`
                              : fmtNum(b.metrics.rms060Um)}
                        </td>
                        <td
                          className={`px-3 py-2.5 font-semibold ${
                            isFitsBatch || isFitsSingle
                              ? 'text-slate-700'
                              : rmsFail
                                ? 'text-rose-700'
                                : 'text-emerald-700'
                          }`}
                        >
                          {isFitsBatch
                            ? `最低 ${b.metrics.batchMinDaoMatchPct}%`
                            : isFitsSingle
                              ? `FWHM ${b.metrics.medianFwhmPx ?? '?'}px`
                              : fmtNum(maxRms)}
                        </td>
                        <td
                          className={`px-3 py-2.5 ${
                            isFitsBatch || isFitsSingle
                              ? 'text-slate-700'
                              : strehlFail
                                ? 'text-rose-700 font-semibold'
                                : 'text-slate-900'
                          }`}
                        >
                          {isFitsBatch
                            ? `余项 ${b.metrics.batchDaoUnmatchedExcess ?? 0}`
                            : isFitsSingle
                              ? `Sky ${fmtNum(b.metrics.medianSkyAdu, 1)}`
                              : `${fmtNum(b.metrics.strehlCenter, 3)} / ${fmtNum(b.metrics.strehlEdge, 3)}`}
                        </td>
                        <td className="px-3 py-2.5">
                          {isFitsBatch
                            ? '—'
                            : fmtNum(b.metrics.mtfEdgeTan, 3)}
                        </td>
                        <td className="px-3 py-2.5">
                          {isFitsBatch ? '—' : fmtNum(b.metrics.distortionMaxPct, 3)}
                        </td>
                        <td className="px-3 py-2.5">
                          {isFitsBatch ? (
                            <span className="font-semibold text-emerald-700">
                              SEP 代理匹配 {b.metrics.batchMeanDaoMatchPct}%
                            </span>
                          ) : typeof b.metrics.sepCompletenessEdgePct === 'number' ? (
                            `${b.metrics.sepCompletenessEdgePct}%`
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-sans whitespace-nowrap">
                          {!isAdopted && (
                            <button
                              type="button"
                              disabled={adoptingId === b.id}
                              onClick={async () => {
                                setAdoptingId(b.id);
                                try {
                                  await onAdoptBranch(study.id, b.id, `在对比矩阵审查后显式采纳 ${b.shortCode}`);
                                } finally {
                                  setAdoptingId(null);
                                }
                              }}
                              className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded whitespace-nowrap cursor-pointer"
                            >
                              {adoptingId === b.id ? '采纳中...' : '设为采纳基线'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Interactive SVG Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Chart 1: Off-axis RMS & 7.5 um Threshold */}
            <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  视场 RMS 光斑半径曲线 (0.00°–0.60°)
                </h3>
                <span className="text-xs font-mono text-slate-500">基准阈值 = 7.5 μm (0.5 px)</span>
              </div>
              <svg viewBox="0 0 520 220" className="w-full h-52 border border-slate-100 bg-slate-50 rounded">
                {/* Grid & Threshold */}
                <line x1="55" y1="180" x2="495" y2="180" stroke="#cbd5e1" strokeWidth="1" />
                <line x1="55" y1="20" x2="55" y2="180" stroke="#cbd5e1" strokeWidth="1" />
                {/* y scale 0..12 um -> y = 180 - (val/12)*150 */}
                {[0, 3, 6, 7.5, 9, 12].map((tick) => {
                  const y = 180 - (tick / 12) * 150;
                  const isThresh = tick === 7.5;
                  return (
                    <g key={tick}>
                      <line
                        x1="55"
                        y1={y}
                        x2="495"
                        y2={y}
                        stroke={isThresh ? '#dc2626' : '#e2e8f0'}
                        strokeWidth={isThresh ? '1.2' : '1'}
                        strokeDasharray={isThresh ? '4 3' : undefined}
                      />
                      <text
                        x="48"
                        y={y + 3}
                        textAnchor="end"
                        className={`text-[10px] font-mono ${isThresh ? 'fill-rose-700 font-semibold' : 'fill-slate-500'}`}
                      >
                        {tick}μm
                      </text>
                    </g>
                  );
                })}
                {[
                  { deg: '0.00°', x: 75 },
                  { deg: '0.25°', x: 210 },
                  { deg: '0.42°', x: 345 },
                  { deg: '0.60°', x: 475 },
                ].map((fx) => (
                  <text key={fx.deg} x={fx.x} y="198" textAnchor="middle" className="fill-slate-600 text-[10px] font-mono">
                    {fx.deg}
                  </text>
                ))}
                {/* Plot S1, S2, S3, S4 (S0 is 170 um off-scale noted in legend) */}
                {opticalBranches
                  .filter((b) => b.shortCode !== 'S0')
                  .map((b, idx) => {
                    const colors = ['#d97706', '#0891b2', '#1d4ed8', '#9333ea', '#059669', '#dc2626'];
                    const color = colors[idx % colors.length];
                    const pts = [
                      { x: 75, v: Number(b.metrics.rms000Um ?? 0) },
                      { x: 210, v: Number(b.metrics.rms025Um ?? b.metrics.rms000Um ?? 0) },
                      { x: 345, v: Number(b.metrics.rms042Um ?? 0) },
                      { x: 475, v: Number(b.metrics.rms060Um ?? 0) },
                    ];
                    const d = pts
                      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${Math.max(20, 180 - (Math.min(12, p.v) / 12) * 150)}`)
                      .join(' ');
                    return (
                      <g key={b.id}>
                        <path d={d} fill="none" stroke={color} strokeWidth={b.shortCode === 'S3' ? '2.5' : '1.6'} />
                        {pts.map((p, i) => (
                          <circle
                            key={i}
                            cx={p.x}
                            cy={Math.max(20, 180 - (Math.min(12, p.v) / 12) * 150)}
                            r={b.shortCode === 'S3' ? '3.5' : '2.5'}
                            fill={color}
                          />
                        ))}
                      </g>
                    );
                  })}
              </svg>
              <div className="flex flex-wrap gap-3 text-[11px] font-mono text-slate-600">
                <span className="text-slate-500">S0 裸 RC 0.60°=170.7μm (超量程)</span>
                {opticalBranches
                  .filter((b) => b.shortCode !== 'S0')
                  .map((b, idx) => {
                    const colors = ['text-amber-700', 'text-cyan-700', 'text-blue-700', 'text-purple-700', 'text-emerald-700', 'text-rose-700'];
                    return (
                      <span key={b.id} className={`font-semibold ${colors[idx % colors.length]}`}>
                        ● {b.shortCode} (max {fmtNum(b.metrics.maxRmsPolyUm, 2)}μm)
                      </span>
                    );
                  })}
              </div>
            </div>

            {/* Chart 2: Stage 4 OAT Sensitivity & Compensator Rescue */}
            <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  Stage 4 公差补偿对比：仅 BFL 调焦 vs M2 垫片 + BFL
                </h3>
                <span className="text-xs font-mono text-slate-500">550 nm 边缘 Strehl &amp; Max RMS</span>
              </div>
              <div className="space-y-2.5 pt-1">
                {(stage4Artifact && stage4?.oat_sensitivities_bfl_12mm || []).map((row) => {
                  const shim = row.perturbation === 'M1_R1_+1.5mm' ? stage4?.oat_m1_r1_with_m2_shim : undefined;
                  return (
                    <div key={String(row.perturbation)} className="text-xs font-mono">
                      {row.perturbation} · 未补偿平均 RMS {fmtNum(row.uncomp_mean_rms_um)} μm ·
                      BFL 最大 RMS {fmtNum(row.max_rms_um)} μm / Strehl {fmtNum(row.strehl_550_edge)}
                      {shim && <> · M2 垫片+BFL 最大 RMS {fmtNum(shim.max_rms_um)} μm / Strehl {fmtNum(shim.strehl_550_edge)}</>}
                    </div>
                  );
                })}
                {!stage4 && <span className="text-xs text-slate-500">原始敏感度数据暂无可核验记录。</span>}
              </div>
              <div className="pt-2 border-t border-slate-100 text-xs space-y-1">
                <div>仅 BFL（{stage4Metrics?.mcBflOnlyTrials ?? '—'} 次） · P50 {fmtNum(stage4Metrics?.mcBflOnlyP50RmsUm)} μm · P95 {fmtNum(stage4Metrics?.mcBflOnlyP95RmsUm)} μm · RMS ≤ 7.5 μm 通过率 {fmtNum(stage4Metrics?.mcBflOnlyYield7_5Pct, 0)}%</div>
                <div>M2 垫片+BFL（{stage4Metrics?.mcM2ShimTrials ?? '—'} 次） · P50 {fmtNum(stage4Metrics?.mcM2ShimP50RmsUm)} μm · P95 {fmtNum(stage4Metrics?.mcM2ShimP95RmsUm)} μm · RMS ≤ 7.5 μm 通过率 {fmtNum(stage4Metrics?.mcM2ShimYield7_5Pct, 0)}%</div>
                {stage4Artifact && <a className="underline" href={'/api/fits/inspect-artifact?artifactId=' + stage4Artifact.id}>Stage 4 原始产物</a>}
              </div>
            </div>
          </div>

          {/* Optical Prescription & Schematic Viewer */}
          <div className="bg-white border border-slate-200 rounded-md p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  折反系统光路结构与 Wynne 校正镜处方参数表
                </h3>
                <p className="text-xs text-slate-500">
                  1000 mm f/2.2 主镜 → f/6.0 次镜 (M1-M2 间距 1489.02 mm, 中心遮拦 36.4%) → 后焦校正透镜组
                </p>
              </div>
              <select
                value={prescriptionBranch?.id ?? ''}
                onChange={(e) => setSelectedPrescriptionBranchId(e.target.value)}
                className="text-xs font-mono bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5"
              >
                {branches
                  .filter((b) => Array.isArray((b.prescription as Record<string, unknown> | undefined)?.lenses))
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.shortCode} · {b.name}
                    </option>
                  ))}
              </select>
            </div>

            {/* Clean RC + Wynne Schematic SVG */}
            <svg viewBox="0 0 820 185" className="w-full h-44 bg-slate-950 rounded border border-slate-300">
              <line x1="20" y1="92" x2="800" y2="92" stroke="#334155" strokeDasharray="4 4" strokeWidth="1" />
              {/* Entering Collimated Beam */}
              <path d="M 35 30 L 580 30 L 210 72 L 735 92" fill="none" stroke="#38bdf8" strokeWidth="1.2" opacity="0.85" />
              <path d="M 35 154 L 580 154 L 210 112 L 735 92" fill="none" stroke="#38bdf8" strokeWidth="1.2" opacity="0.85" />
              {/* Primary Mirror M1 */}
              <path d="M 565 24 Q 586 58 586 78" fill="none" stroke="#e2e8f0" strokeWidth="4" />
              <path d="M 586 106 Q 586 126 565 160" fill="none" stroke="#e2e8f0" strokeWidth="4" />
              <text x="588" y="24" className="fill-slate-200 text-[10px] font-mono">
                M1 R=-4400 K1={fmtNum(prescriptionBranch?.metrics.k1, 4)}
              </text>
              {/* Secondary Mirror M2 */}
              <path d="M 218 66 Q 204 92 218 118" fill="none" stroke="#e2e8f0" strokeWidth="4" />
              <text x="148" y="54" className="fill-slate-200 text-[10px] font-mono">
                M2 R=-2245.2 K2={fmtNum(prescriptionBranch?.metrics.k2, 4)}
              </text>
              {/* Wynne Corrector Lenses (L1..L3) */}
              {prescriptionLenses.map((_, i) => {
                const lx = 615 + i * 32;
                return (
                  <g key={i}>
                    <rect x={lx} y="74" width="12" height="36" rx="3" fill="#0ea5e9" fillOpacity="0.35" stroke="#7dd3fc" />
                    <text x={lx + 6} y="124" textAnchor="middle" className="fill-cyan-200 text-[9px] font-mono">
                      L{i + 1}
                    </text>
                  </g>
                );
              })}
              {/* Focal Plane */}
              <line x1="735" y1="70" x2="735" y2="114" stroke="#f59e0b" strokeWidth="2.5" />
              <text x="742" y="88" className="fill-amber-300 text-[10px] font-mono">
                焦面 BFL={fmtNum(prescriptionBranch?.metrics.bflMm, 2)}mm
              </text>
              <text x="742" y="103" className="fill-slate-400 text-[9px] font-mono">
                15μm 像元 (1.2° FoV)
              </text>
            </svg>

            {prescriptionLenses.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums border border-slate-200 rounded">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-sans">
                    <tr>
                      <th className="px-3 py-2">透镜编号</th>
                      <th className="px-3 py-2">光学材料</th>
                      <th className="px-3 py-2">前表面 R1 (mm)</th>
                      <th className="px-3 py-2">后表面 R2 (mm)</th>
                      <th className="px-3 py-2">中心厚度 (mm)</th>
                      <th className="px-3 py-2">后空气间隔 (mm)</th>
                      <th className="px-3 py-2">通光半口径 (mm)</th>
                      <th className="px-3 py-2">边缘厚度 (mm)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {prescriptionLenses.map((l, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-2 font-semibold">L{String(l.lens ?? idx + 1)}</td>
                        <td className="px-3 py-2">{String(l.material ?? 'Fused Silica')}</td>
                        <td className="px-3 py-2">{fmtNum(l.r1_mm, 3)}</td>
                        <td className="px-3 py-2">{fmtNum(l.r2_mm, 3)}</td>
                        <td className="px-3 py-2">{fmtNum(l.tc_mm, 2)}</td>
                        <td className="px-3 py-2">{fmtNum(l.gap_after_mm, 3)}</td>
                        <td className="px-3 py-2">{fmtNum(l.clear_semi_ap_mm, 2)}</td>
                        <td className="px-3 py-2">{fmtNum(l.edge_thickness_mm, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sub-view 2: Integrated Interactive 2D FITS Inspector */}
      {activeSubTab === 'fits' && (
        <FitsWorkspace
          catalog={fitsCatalog}
          initialCatalogPath={initialFitsPath}
          pythonSourcesOverride={pythonFitsResult}
          onTriggerPythonExtract={onTriggerPythonExtract}
          isJobRunning={isJobRunning}
        />
      )}

      {/* Sub-view 3: Artifacts DAG & SHA-256 Registry */}
      {activeSubTab === 'artifacts' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCode2 className="w-4 h-4 text-blue-700" />
                <h2 className="text-sm font-semibold text-slate-900">已登记科学计算报告与原生派生 JSON/日志产物</h2>
              </div>
              <span className="text-xs font-mono text-slate-500">共 {artifacts.length} 项 · 全部带 SHA-256 指纹</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-sans">
                  <tr>
                    <th className="px-3 py-2">产物名称</th>
                    <th className="px-3 py-2">类型</th>
                    <th className="px-3 py-2">来源层</th>
                    <th className="px-3 py-2">路径</th>
                    <th className="px-3 py-2">大小</th>
                    <th className="px-3 py-2">SHA-256 摘要</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {artifacts.map((art) => {
                    const prov = PROVENANCE_LABEL[art.provenanceTier];
                    return (
                      <tr key={art.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-sans font-medium text-slate-900">{art.title}</td>
                        <td className="px-3 py-2 text-slate-600">{art.kind}</td>
                        <td className="px-3 py-2 font-sans">
                          <span className={`px-1.5 py-0.5 text-[11px] border rounded-sm ${prov.cls}`}>
                            {prov.text}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-blue-700">{art.relativePath}</td>
                        <td className="px-3 py-2">
                          {art.byteLength !== null ? `${(art.byteLength / 1024).toFixed(1)} KB` : '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-500" title={art.sha256}>
                          {art.sha256.slice(0, 16)}…
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                20 帧真实 PSF 卷积 FITS 天体观测帧账本 (S0–S4 × 4 视场)
              </h3>
              <span className="text-xs font-mono text-slate-500">点击任意帧直接在 2D FITS 检查器打开</span>
            </div>
            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-sans sticky top-0">
                  <tr>
                    <th className="px-3 py-2">系统 / 视场</th>
                    <th className="px-3 py-2">文件名</th>
                    <th className="px-3 py-2">SEP 完备度</th>
                    <th className="px-3 py-2">DAO(3px) 完备度</th>
                    <th className="px-3 py-2">SHA-256</th>
                    <th className="px-3 py-2 text-right">检查</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fitsCatalog.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-semibold text-slate-900">
                        {item.systemKey} · {item.fieldDeg.toFixed(2)}°
                      </td>
                      <td className="px-3 py-2 text-slate-600">{item.fileName}</td>
                      <td className="px-3 py-2 text-emerald-700">
                        {item.summaryMetrics?.sepCompletenessPct !== undefined
                          ? `${item.summaryMetrics.sepCompletenessPct}%`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-amber-700">
                        {item.summaryMetrics?.photutilsCompletenessPct !== undefined
                          ? `${item.summaryMetrics.photutilsCompletenessPct}%`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{item.sha256.slice(0, 14)}…</td>
                      <td className="px-3 py-2 text-right font-sans">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectFitsPath?.(item.relativePath);
                            onChangeSubTab('fits');
                          }}
                          className="text-xs text-blue-700 hover:underline cursor-pointer"
                        >
                          打开查看
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Workflow executions ledger */}
          <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                工作流执行记录 ({executions.length} 次)
              </h3>
            </div>
            <div className="divide-y divide-slate-100 text-xs">
              {executions.map((ex) => (
                <div key={ex.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900">
                      {ex.title} <span className="font-mono text-slate-500">({ex.runnerMode})</span>
                    </div>
                    <div className="text-slate-600">{ex.intent}</div>
                  </div>
                  <div className="font-mono tabular-nums text-slate-500 text-right">
                    <div>{ex.durationMs} ms · {ex.status}</div>
                    <div>SHA-256={ex.sha256Digest.slice(0, 14)}…</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
