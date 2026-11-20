import type { EpistemicNote, ResearchStudy, StudyBranch, WorkflowExecution } from '../src/core/types.ts';

type MonteCarlo = Record<string, number | undefined>;
export type Stage4 = {
  monte_carlo_bfl_12mm?: MonteCarlo;
  monte_carlo_m2_shim_plus_bfl_3mm?: MonteCarlo;
};

export function stage4Metrics(stage4?: Stage4) {
  const bfl = stage4?.monte_carlo_bfl_12mm;
  const shim = stage4?.monte_carlo_m2_shim_plus_bfl_3mm;
  return {
    mcBflOnlyP50RmsUm: bfl?.max_rms_um_p50 ?? null,
    mcBflOnlyP95RmsUm: bfl?.max_rms_um_p95 ?? null,
    mcBflOnlyYield7_5Pct: bfl?.yield_max_rms_le_7_5um_pct ?? null,
    mcBflOnlyTrials: bfl?.n_trials ?? null,
    mcM2ShimP50RmsUm: shim?.max_rms_um_p50 ?? null,
    mcM2ShimP95RmsUm: shim?.max_rms_um_p95 ?? null,
    mcM2ShimYield7_5Pct: shim?.yield_max_rms_le_7_5um_pct ?? null,
    mcM2ShimTrials: shim?.n_trials ?? null,
  };
}

export type S2Prescription = {
  metrics: {
    rms_um_poly_by_field: Record<string, number>;
    fft_strehl_550nm: Record<string, number>;
    max_rms_poly_um: number;
    mean_rms_poly_um: number;
  };
};

export const s2SummaryArtifactId = 'art-p2-s2-prescription';

export function s2ScienceSummary(data?: S2Prescription) {
  if (!data) return { summary: 'S2 原始处方与指标尚未核验。' };
  const fields = ['0.0', '0.25', '0.42', '0.6'];
  const rms = fields.map((field) => data.metrics.rms_um_poly_by_field[field]);
  const strehl = fields.map((field) => data.metrics.fft_strehl_550nm[field]);
  const underThreshold = fields.filter((_, index) => strehl[index] < 0.80);
  const summary = '四个采样视场的多色 RMS 为 ' + Math.min(...rms).toFixed(3) + '–' + Math.max(...rms).toFixed(3) +
    ' μm，550 nm FFTPSF Strehl 为 ' + Math.min(...strehl).toFixed(5) + '–' + Math.max(...strehl).toFixed(5) +
    '。' + (underThreshold.length ? underThreshold.join('°、') + '° 低于 0.80 门槛。' : '全部采样视场达到 0.80 门槛。');
  return {
    summary,
    summaryArtifactId: s2SummaryArtifactId,
    metrics: {
      rms000Um: rms[0], rms025Um: rms[1], rms042Um: rms[2], rms060Um: rms[3],
      maxRmsPolyUm: data.metrics.max_rms_poly_um, meanRmsPolyUm: data.metrics.mean_rms_poly_um,
      strehlCenter: strehl[0], strehl025: strehl[1], strehlMid: strehl[2], strehlEdge: strehl[3],
    },
  };
}

export const fitsProxyCaveat = '与 SEP 的代理交叉匹配，缺少独立逐星真值。DAO 独有检出尚未判定为误检。';

export function projectScienceCorrections(
  studies: ResearchStudy[], branches: StudyBranch[], executions: WorkflowExecution[],
  notes: EpistemicNote[], stage4?: Stage4, s2?: S2Prescription,
) {
  const correction = stage4Metrics(stage4);
  const s2Correction = s2ScienceSummary(s2);
  const stage4Note = stage4
    ? '原始蒙特卡洛数据：RMS ≤ 7.5 μm 的通过率为 ' + correction.mcBflOnlyYield7_5Pct + '% / ' + correction.mcM2ShimYield7_5Pct +
      '%，P95 最大 RMS 为 ' + correction.mcBflOnlyP95RmsUm + ' / ' + correction.mcM2ShimP95RmsUm + ' μm（仅 BFL / M2 垫片+BFL）。'
    : '当前工作区未核验 Stage 4 原始结果。';

  return {
    studies: studies.map((study) => study.id === 'study-wf-rc-1000' ? {
      ...study,
      stages: study.stages.map((stage) => stage.stageNumber === 4 ? { ...stage, keyFinding: stage4Note } : stage),
    } : study),
    branches: branches.map((branch) => {
      if (branch.id === 'branch-p2-s2') return {
        ...branch, summary: s2Correction.summary, summaryArtifactId: s2Correction.summaryArtifactId,
        metrics: { ...branch.metrics, ...s2Correction.metrics },
        artifactIds: s2Correction.summaryArtifactId
          ? Array.from(new Set([...branch.artifactIds, s2Correction.summaryArtifactId]))
          : branch.artifactIds,
      };
      if (branch.id === 'branch-p2-s3') return { ...branch, metrics: { ...branch.metrics, ...correction } };
      if (typeof branch.metrics.batchMeanDaoMatchPct === 'number') return {
        ...branch, summary: fitsProxyCaveat + ' 逐帧平均 ' + branch.metrics.batchMeanDaoMatchPct + '%。',
      };
      return branch;
    }),
    executions: executions.map((execution) => {
      if (execution.id === 'exec-p2-s2') return { ...execution, outputs: { ...execution.outputs, ...s2Correction.metrics } };
      if (execution.id === 'exec-p2-s3') return { ...execution, outputs: { ...execution.outputs, ...correction } };
      return execution;
    }),
    notes: notes.map((note) => note.id === 'note-1795009744921-5m0'
      ? { ...note, content: note.content + '\n更正：' + fitsProxyCaveat + ' Stage 3 的 65.4% 使用模拟注入真值作为分母。' }
      : note),
  };
}
