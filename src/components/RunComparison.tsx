import { useState } from 'react';
import { ArrowRight, GitCompare, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ExperimentRun } from '../core/types.ts';
import { OpticalViewport } from './OpticalViewport.tsx';

interface RunComparisonProps {
  runs: ExperimentRun[];
}

function formatDelta(a: number, b: number, unit: string, lowerIsBetter = true): {
  text: string;
  tone: string;
} {
  const diff = b - a;
  if (Math.abs(diff) < 1e-4) return { text: `0 ${unit}`, tone: 'text-slate-500' };
  const sign = diff > 0 ? '+' : '';
  const improved = lowerIsBetter ? diff < 0 : diff > 0;
  return {
    text: `${sign}${diff.toFixed(3)} ${unit}`,
    tone: improved ? 'text-emerald-700 font-semibold' : 'text-rose-700 font-semibold',
  };
}

export function RunComparison({ runs }: RunComparisonProps) {
  const [runAId, setRunAId] = useState<string>(runs[0]?.id ?? '');
  const [runBId, setRunBId] = useState<string>(runs[runs.length - 1]?.id ?? runs[0]?.id ?? '');

  const runA = runs.find((r) => r.id === runAId) ?? runs[0];
  const runB = runs.find((r) => r.id === runBId) ?? runs[runs.length - 1];

  if (!runA || !runB) {
    return (
      <div className="max-w-[1400px] mx-auto px-6 py-12 text-center text-sm text-slate-500">
        当前尚无足够的实验运行记录，请先在「实验台」中运行至少一次实验。
      </div>
    );
  }

  const artA = runA.rawArtifactsAfter;
  const artB = runB.rawArtifactsAfter;

  const deltaRms = formatDelta(artA.rmsSpotRadiusUm, artB.rmsSpotRadiusUm, 'μm', true);
  const deltaChrom = formatDelta(artA.axialChromaticShiftMm, artB.axialChromaticShiftMm, 'mm', true);
  const deltaMtf = formatDelta(artA.mtf30LpMm, artB.mtf30LpMm, '', false);
  const eflDiff = artB.paraxialEflMm - artA.paraxialEflMm;
  const eflErrA = Math.abs(artA.paraxialEflMm - runA.systemAfter.targetEflMm);
  const eflErrB = Math.abs(artB.paraxialEflMm - runB.systemAfter.targetEflMm);
  const deltaEfl =
    Math.abs(eflDiff) < 1e-4
      ? { text: '0 mm', tone: 'text-slate-500' }
      : {
          text: `${eflDiff > 0 ? '+' : ''}${eflDiff.toFixed(3)} mm`,
          tone: eflErrB <= eflErrA ? 'text-emerald-700 font-semibold' : 'text-rose-700 font-semibold',
        };

  const evalA = runA.evaluations[runA.evaluations.length - 1];
  const evalB = runB.evaluations[runB.evaluations.length - 1];

  const partsA = runA.composition.parts.map((p) => `${p.slot}:${p.componentId}@${p.version}`).join(' · ');
  const partsB = runB.composition.parts.map((p) => `${p.slot}:${p.componentId}@${p.version}`).join(' · ');

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-6">
      {/* Selector Bar */}
      <div className="bg-white border border-slate-200 rounded-md p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-blue-700" aria-hidden="true" />
          <h1 className="text-base font-semibold text-slate-900">历史实验方案并排对照（基于各自不可变原始产物）</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="compare-run-a" className="text-xs font-medium text-slate-600">
              基线方案 A
            </label>
            <select
              id="compare-run-a"
              value={runA.id}
              onChange={(e) => setRunAId(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  Run #{r.sequenceNumber} · {r.branchLabel}
                </option>
              ))}
            </select>
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400" aria-hidden="true" />
          <div className="flex items-center gap-2">
            <label htmlFor="compare-run-b" className="text-xs font-medium text-slate-600">
              对照方案 B
            </label>
            <select
              id="compare-run-b"
              value={runB.id}
              onChange={(e) => setRunBId(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  Run #{r.sequenceNumber} · {r.branchLabel}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Quantitative Metrics Diff Table */}
      <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-semibold">物理指标 / 组合与指纹</th>
              <th className="px-4 py-3 font-semibold font-mono">
                方案 A · Run #{runA.sequenceNumber} ({runA.branchLabel})
              </th>
              <th className="px-4 py-3 font-semibold font-mono">
                方案 B · Run #{runB.sequenceNumber} ({runB.branchLabel})
              </th>
              <th className="px-4 py-3 font-semibold">变化量 (B − A)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">组件组合 ({runA.composition.pattern})</td>
              <td className="px-4 py-2.5 text-slate-600 break-all">{partsA}</td>
              <td className="px-4 py-2.5 text-slate-600 break-all">{partsB}</td>
              <td className="px-4 py-2.5 font-sans text-slate-500">
                {partsA === partsB ? '组件版本相同' : '组件或版本已变化'}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">运行环境 / 随机种子</td>
              <td className="px-4 py-2.5 text-slate-600">
                {runA.runtimeEnv.hostMode} · seed={runA.seed} · {artA.solverEngine ?? 'ts_preview'}
              </td>
              <td className="px-4 py-2.5 text-slate-600">
                {runB.runtimeEnv.hostMode} · seed={runB.seed} · {artB.solverEngine ?? 'ts_preview'}
              </td>
              <td className="px-4 py-2.5 font-sans text-slate-500">
                {runA.runtimeEnv.hostMode === runB.runtimeEnv.hostMode ? '同一环境' : '环境不同'}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">记录完整性 (64 位 SHA-256)</td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1">
                  {runA.tamperStatus === 'verified' ? (
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                  ) : (
                    <ShieldAlert className="w-3.5 h-3.5 text-rose-700" aria-hidden="true" />
                  )}
                  <span>{runA.recordIntegrityHash.slice(0, 16)}...</span>
                </span>
              </td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1">
                  {runB.tamperStatus === 'verified' ? (
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                  ) : (
                    <ShieldAlert className="w-3.5 h-3.5 text-rose-700" aria-hidden="true" />
                  )}
                  <span>{runB.recordIntegrityHash.slice(0, 16)}...</span>
                </span>
              </td>
              <td className="px-4 py-2.5 font-sans text-slate-600">
                {runA.tamperStatus === 'verified' && runB.tamperStatus === 'verified' ? '双方均未被篡改' : '存在异常记录'}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">有效焦距 (EFL)</td>
              <td className="px-4 py-2.5">{artA.paraxialEflMm.toFixed(3)} mm</td>
              <td className="px-4 py-2.5">{artB.paraxialEflMm.toFixed(3)} mm</td>
              <td className={`px-4 py-2.5 ${deltaEfl.tone}`}>{deltaEfl.text}</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">多波段 RMS 光斑半径</td>
              <td className="px-4 py-2.5">{artA.rmsSpotRadiusUm.toFixed(3)} μm</td>
              <td className="px-4 py-2.5">{artB.rmsSpotRadiusUm.toFixed(3)} μm</td>
              <td className={`px-4 py-2.5 ${deltaRms.tone}`}>{deltaRms.text}</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">F-C 轴向色差焦点漂移</td>
              <td className="px-4 py-2.5">{artA.axialChromaticShiftMm.toFixed(4)} mm</td>
              <td className="px-4 py-2.5">{artB.axialChromaticShiftMm.toFixed(4)} mm</td>
              <td className={`px-4 py-2.5 ${deltaChrom.tone}`}>{deltaChrom.text}</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">30 lp/mm 子午 MTF</td>
              <td className="px-4 py-2.5">{artA.mtf30LpMm.toFixed(4)}</td>
              <td className="px-4 py-2.5">{artB.mtf30LpMm.toFixed(4)}</td>
              <td className={`px-4 py-2.5 ${deltaMtf.tone}`}>{deltaMtf.text}</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-sans text-slate-700">最新评价器结论</td>
              <td className="px-4 py-2.5 font-sans">
                {evalA ? `${evalA.status.toUpperCase()} (${evalA.evaluatorName}@${evalA.evaluatorVersion})` : '无'}
              </td>
              <td className="px-4 py-2.5 font-sans">
                {evalB ? `${evalB.status.toUpperCase()} (${evalB.evaluatorName}@${evalB.evaluatorVersion})` : '无'}
              </td>
              <td className="px-4 py-2.5 font-sans text-slate-600">
                {evalA && evalB ? (evalA.status === evalB.status ? '结论一致' : '结论不同') : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Visual Ray-Trace & Spot Comparison */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <OpticalViewport
          spec={runA.systemAfter}
          trace={artA}
          title={`方案 A · Run #${runA.sequenceNumber} (${runA.branchLabel})`}
          compact
        />
        <OpticalViewport
          spec={runB.systemAfter}
          trace={artB}
          title={`方案 B · Run #${runB.sequenceNumber} (${runB.branchLabel})`}
          compact
        />
      </div>
    </div>
  );
}
