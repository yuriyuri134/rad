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

export const fitsProxyCaveat = '与 SEP 的代理交叉匹配，缺少独立逐星真值。DAO 独有检出尚未判定为误检。';

export function projectScienceCorrections(
  studies: ResearchStudy[], branches: StudyBranch[], executions: WorkflowExecution[],
  notes: EpistemicNote[], stage4?: Stage4,
) {
  const correction = stage4Metrics(stage4);
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
      if (branch.id === 'branch-p2-s3') return { ...branch, metrics: { ...branch.metrics, ...correction } };
      if (typeof branch.metrics.batchMeanDaoMatchPct === 'number') return {
        ...branch, summary: fitsProxyCaveat + ' 逐帧平均 ' + branch.metrics.batchMeanDaoMatchPct + '%。',
      };
      return branch;
    }),
    executions: executions.map((execution) => execution.id === 'exec-p2-s3'
      ? { ...execution, outputs: { ...execution.outputs, ...correction } } : execution),
    notes: notes.map((note) => note.id === 'note-1795009744921-5m0'
      ? { ...note, content: note.content + '\n更正：' + fitsProxyCaveat + ' Stage 3 的 65.4% 使用模拟注入真值作为分母。' }
      : note),
  };
}
