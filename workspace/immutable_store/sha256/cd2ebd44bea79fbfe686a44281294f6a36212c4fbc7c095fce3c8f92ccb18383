// 独立光学像差诊断插件：分析已保存的 rawArtifacts 产物，判断球差与色差谁占主导，并给出 Airy 衍射极限参考
export function analyze(rawArtifacts, spec, params) {
  const required = ['rmsSpotRadiusUm', 'axialChromaticShiftMm', 'longitudinalSphericalAberrationMm', 'fNumber'];
  const missing = required.filter((k) => typeof rawArtifacts?.[k] !== 'number');
  if (missing.length > 0) {
    return {
      status: 'insufficient_artifacts',
      summary: '原始产物缺少像差诊断所需字段，拒绝推测：' + missing.join(', '),
      missingArtifacts: missing,
    };
  }

  const refWlUm = Number(params.referenceWavelengthUm ?? 0.58756);
  const airyRadiusUm = Number((1.22 * refWlUm * rawArtifacts.fNumber).toFixed(3));
  const diffractionRatio = Number((rawArtifacts.rmsSpotRadiusUm / Math.max(0.1, airyRadiusUm)).toFixed(2));
  const absLsa = Math.abs(rawArtifacts.longitudinalSphericalAberrationMm);
  const absChrom = Math.abs(rawArtifacts.axialChromaticShiftMm);

  let dominantAberration = 'balanced';
  if (absChrom > absLsa * 0.7 && absChrom > 0.45) {
    dominantAberration = 'axial_chromatic_dominant';
  } else if (absLsa >= absChrom) {
    dominantAberration = 'spherical_dominant';
  }

  return {
    status: 'completed',
    airyRadiusUm,
    rmsToAiryRatio: diffractionRatio,
    diffractionLimited: diffractionRatio <= 1.2,
    absLsaMm: Number(absLsa.toFixed(4)),
    absChromaticShiftMm: Number(absChrom.toFixed(4)),
    dominantAberration,
    summary:
      dominantAberration === 'axial_chromatic_dominant'
        ? `色差主导（F-C=${absChrom.toFixed(3)} mm），光斑为 Airy 盘 ${diffractionRatio}x，建议改用双胶合消色差结构。`
        : `球差主导（LSA=${absLsa.toFixed(3)} mm），光斑为 Airy 盘 ${diffractionRatio}x（Airy=${airyRadiusUm} μm）。`,
  };
}

export function selfCheck(params) {
  const out = analyze(
    {
      rmsSpotRadiusUm: 50,
      axialChromaticShiftMm: 1.4,
      longitudinalSphericalAberrationMm: -1.7,
      fNumber: 4.0,
    },
    {},
    params,
  );
  const missingOut = analyze({ fNumber: 4.0 }, {}, params);
  const ok = out.status === 'completed' && out.airyRadiusUm > 2 && missingOut.status === 'insufficient_artifacts';
  return {
    passed: ok,
    summary: ok
      ? `自检通过：F/4 Airy 半径=${out.airyRadiusUm} μm，且缺失字段正确返回 insufficient_artifacts`
      : '自检失败：像差诊断逻辑异常',
  };
}
