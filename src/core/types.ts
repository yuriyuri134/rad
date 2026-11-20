export type SourceOrigin =
  | 'user_statement'
  | 'experiment_run'
  | 'evaluator_verdict'
  | 'ai_hypothesis'
  | 'adopted_decision';

export type RuntimeKind =
  | 'local_process_mjs'
  | 'local_process_py'
  | 'builtin_ts_preview'
  | 'builtin_engine';

export interface ContractField {
  name: string;
  type: string;
  unit?: string;
  description: string;
}

export interface ComponentDependency {
  kind: 'component' | 'package' | 'module';
  targetId: string;
  reason: string;
}

export interface ParameterSpec {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  defaultValue: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
  description: string;
}

export type ActorKind = 'human' | 'ai_collaborator' | 'system' | 'migrated_unknown';

export interface ActorAttribution {
  actorId: string;
  displayName: string;
  actorKind: ActorKind;
  modelOrTool?: string;
}

export interface MigrationProvenance {
  isMigrated: boolean;
  sourceRecordIds: string[];
  sourceFields?: string[];
  inferredFields: string[];
  note: string;
}

export type EvidenceGrade =
  | 'preview_computed'
  | 'self_check_passed'
  | 'benchmark_compared'
  | 'lab_measured'
  | 'unverified';

export interface DomainAdapterDescriptor {
  domainId: string;
  name: string;
  artifactTypes: string[];
  evaluatorKinds: string[];
}

export type ComponentVersionLifecycle = 'draft' | 'frozen';
export type ComponentSourceAvailability =
  | 'available_on_disk'
  | 'missing_on_disk'
  | 'historical_hash_drifted';

export interface HistoricalHashDriftRecord {
  runId: string;
  recordedCodeHash: string;
  diskCodeHashAtAudit: string | null;
  note: string;
}

export interface PinnedRelativeDep {
  relativePath: string;
  codeHash: string;
  immutableBlobHash?: string | null;
}

export interface PinnedHostModule {
  targetId: string;
  codeHash: string;
  immutableBlobHash?: string | null;
  casPath?: string | null;
}

export interface ComponentVersionRecord {
  version: string;
  createdAt: string;
  parentVersion: string | null;
  author: 'system' | 'rad' | 'ai_suggested' | 'migrated_unknown';
  changeSummary: string;
  codeHash: string; // Full 64-char SHA-256 hex digest
  params: Record<string, number | string | boolean>;
  codeFile: string;
  approval?: CodeSecurityReviewState | null;
  lifecycle?: ComponentVersionLifecycle;
  frozenAt?: string | null;
  frozenByRunIds?: string[];
  frozenBySnapshotIds?: string[];
  sourceAvailability?: ComponentSourceAvailability;
  immutableBlobHash?: string | null;
  pinnedRelativeDeps?: PinnedRelativeDep[];
  pinnedHostModules?: PinnedHostModule[];
  casIntegrityStatus?: 'valid' | 'missing' | 'corrupted' | 'unpinned';
  casTamperDetected?: boolean;
  casAvailable?: boolean;
  workspaceMatchesFrozenHash?: boolean;
  frozenWorkspaceModified?: boolean;
  relativeDepsWorkspaceModified?: boolean;
  hostModulesWorkspaceModified?: boolean;
  historicalDriftedHashes?: HistoricalHashDriftRecord[];
}

export interface SelfCheckState {
  status: 'passed' | 'failed' | 'unrun' | 'env_unavailable';
  checkedAt: string | null;
  checkedCodeHash: string | null;
  summary: string;
  details?: string;
}

export interface ScientificValidationState {
  status: 'validated_reference' | 'limited_preview' | 'unvalidated';
  basis: string;
  caveats: string[];
}

export interface CodeSecurityReviewState {
  status: 'builtin_reviewed' | 'user_approved_hash' | 'unreviewed_modified';
  approvedHash: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  executionModelNote: string;
}

export interface ComponentDossier {
  id: string;
  name: string;
  kind: string; // Open classification: 'optical_solver' | 'evaluator' | 'optimizer' | 'architecture_map' | 'analysis_plugin' | ...
  runtime: RuntimeKind;
  activeVersion: string;
  summary: string;
  purpose: string;
  capabilityBoundary: string;
  inputs: ContractField[];
  outputs: ContractField[];
  dependencies: ComponentDependency[];
  compatibility: string[];
  assumptions: string[];
  limits: string[];
  editableParts: string[];
  parameters: ParameterSpec[];
  versions: ComponentVersionRecord[];
  selfCheck: SelfCheckState;
  scientificValidation: ScientificValidationState;
  codeSecurityReview: CodeSecurityReviewState;
  diskTamperDetected?: boolean;
  frozenDriftDetected?: boolean;
  hostModuleDriftDetected?: boolean;
  casTamperDetected?: boolean;
  diskActualHash?: string;
  impactScope?: {
    dependentComponentIds: string[];
    usedInRunIds: string[];
  };
}

export type GlassName =
  | 'AIR'
  | 'N-BK7'
  | 'N-SF11'
  | 'N-F2'
  | 'FUSED_SILICA'
  | 'N-LAK9';

export interface OpticalSurface {
  id: string;
  label: string;
  radiusMm: number | null;
  thicknessMm: number;
  semiApertureMm: number;
  glassAfter: GlassName;
  variableRadius?: boolean;
  variableThickness?: boolean;
}

export interface OpticalSystemSpec {
  name: string;
  description: string;
  entrancePupilDiameterMm: number;
  fieldAnglesDeg: number[];
  wavelengthsNm: number[];
  targetEflMm: number;
  focusMode: 'paraxial_d' | 'best_rms' | 'fixed_bfl';
  fixedBflMm?: number;
  surfaces: OpticalSurface[];
}

export interface TracedRayPoint {
  wavelengthNm: number;
  fieldDeg: number;
  pupilNormY: number;
  points: Array<{ z: number; y: number }>;
  imageHitY: number;
  imageHitX: number;
  clipped: boolean;
  tir: boolean;
}

export interface SpotPoint {
  wavelengthNm: number;
  fieldDeg: number;
  xUm: number;
  yUm: number;
}

export interface MtfPoint {
  freqLpMm: number;
  mtfSagittal: number;
  mtfTangential: number;
}

export interface RayTraceResult {
  solverEngine?: 'optiland' | 'ts_preview';
  paraxialEflMm: number;
  paraxialBflMm: number;
  fNumber: number;
  imagePlaneZMm: number;
  totalLengthMm: number;
  rmsSpotRadiusUm: number;
  rmsSpotByWavelengthUm: Record<string, number>;
  longitudinalSphericalAberrationMm: number;
  axialChromaticShiftMm: number;
  mtf30LpMm: number;
  mtf60LpMm: number;
  mtfCurve: MtfPoint[];
  clippedRayCount: number;
  tirRayCount: number;
  totalRayCount: number;
  meridionalRays: TracedRayPoint[];
  spotPoints: SpotPoint[];
  aberrationFan: Array<{ pupilNormY: number; dyUm587: number; dyUm486: number; dyUm656: number }>;
  surfaceVerticesZ: number[];
  availableMetrics?: string[];
}

export interface EvaluationVerdict {
  id: string;
  evaluatorId: string;
  evaluatorName: string;
  evaluatorVersion: string;
  evaluatorCodeHash: string;
  evaluatedAt: string;
  passed: boolean;
  status: 'pass' | 'warning' | 'fail' | 'insufficient_artifacts';
  lossScore: number | null;
  summary: string;
  checks: Array<{
    criterion: string;
    measured: string;
    threshold: string;
    passed: boolean;
  }>;
  uncertainties: string[];
  missingArtifacts?: string[];
}

export interface OptimizationIteration {
  step: number;
  loss: number;
  rmsSpotUm: number;
  eflMm: number;
  chromaticShiftMm: number;
}

export interface RuntimeEnvironmentSnapshot {
  hostMode: 'cloud_preview' | 'local_python_ready';
  nodeVersion: string;
  pythonVersion: string | null;
  pythonOkForOptiland: boolean;
  optilandVersion: string | null;
  numpyVersion: string | null;
  scipyVersion: string | null;
  platform: string;
}

export interface CompositionPartRef {
  slot: string;
  componentId: string;
  componentName: string;
  kind: string;
  version: string;
  codeHash: string;
  paramsSnapshot: Record<string, number | string | boolean>;
}

export interface ResearchObjective {
  id: string;
  title: string;
  description: string;
  priority: 'primary' | 'secondary' | 'constraint';
}

export interface AcceptanceCriterion {
  id: string;
  metricKey: string;
  label: string;
  operator: '<=' | '>=' | '==' | 'range' | 'custom';
  targetValue: number | string;
  unit?: string;
  required: boolean;
}

export interface ResearchObject {
  id: string;
  domainId: string;
  title: string;
  problemStatement: string;
  objectives: ResearchObjective[];
  criteria: AcceptanceCriterion[];
  openQuestions: string[];
  createdAt: string;
  createdBy: ActorAttribution;
  migrationProvenance?: MigrationProvenance;
}

export interface EvaluatorBinding {
  bindingId: string;
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatorCodeHash: string;
  paramsSnapshot: Record<string, number | string | boolean>;
  criterionIds: string[];
  coverageNote: string;
  sourceAvailability?: ComponentSourceAvailability;
}

export interface PinnedComponentRef {
  slot: string;
  componentId: string;
  version: string;
  codeHash: string;
  sourceAvailability: ComponentSourceAvailability;
  driftNote?: string;
}

export interface ResearchSnapshot {
  id: string;
  researchObjectId: string;
  parentSnapshotId: string | null;
  legacyParentRunId?: string | null;
  branchId: string;
  title: string;
  description: string;
  systemSpec: OpticalSystemSpec;
  objectivesSnapshot: ResearchObjective[];
  criteriaSnapshot: AcceptanceCriterion[];
  evaluatorBindings: EvaluatorBinding[];
  pinnedComponents: PinnedComponentRef[];
  architectureSnapshotId?: string | null;
  sourceExperimentRunId?: string | null;
  evidenceGrade: EvidenceGrade;
  createdAt: string;
  createdBy: ActorAttribution;
  migrationProvenance?: MigrationProvenance;
}

export interface ArchitectureSnapshot {
  id: string;
  capturedAt: string;
  reason: string;
  pinnedComponents: PinnedComponentRef[];
  runtimeEnv: RuntimeEnvironmentSnapshot;
  mapDigestSha256?: string;
}

export interface ExperimentSnapshot {
  id: string;
  runId: string;
  baseSnapshotId: string | null;
  candidateSystemSpec: OpticalSystemSpec;
  adoptedAsSnapshotId?: string | null;
  capturedAt: string;
  status: 'completed' | 'failed';
}

export type BranchStatus = 'exploring' | 'paused' | 'converged' | 'abandoned';

export interface Branch {
  id: string;
  researchObjectId: string;
  name: string;
  hypothesis: string;
  status: BranchStatus;
  owner: ActorAttribution;
  baseSnapshotId: string;
  headSnapshotId: string;
  unadoptedRunIds: string[];
  adoptedRunIds: string[];
  createdAt: string;
  updatedAt: string;
  migrationProvenance?: MigrationProvenance;
}

export interface ExperimentOverrideRecord {
  targetScope: 'system_spec' | 'solver' | 'optimizer' | 'evaluator' | 'criteria';
  componentId?: string;
  key: string;
  baseValue?: unknown;
  overrideValue: unknown;
  reason?: string;
}

export interface EvaluationPolicySnapshot {
  researchObjectId: string | null;
  policyVersion: string;
  objectives: ResearchObjective[];
  criteria: AcceptanceCriterion[];
  evaluatorBindings: EvaluatorBinding[];
}

export interface EffectiveExecutionConfig {
  effectiveSystemSpec: OpticalSystemSpec;
  effectiveParts: CompositionPartRef[];
  overrides: ExperimentOverrideRecord[];
  evaluationPolicy: EvaluationPolicySnapshot;
  executor: ActorAttribution;
}

export type RunSupplementKind =
  | 'initial_run_evaluation'
  | 'post_hoc_reevaluation'
  | 'standalone_analysis';

export interface StandaloneAnalysisRecord {
  id: string;
  componentId: string;
  componentName: string;
  version: string;
  codeHash: string;
  ranAt: string;
  paramsSnapshot?: Record<string, number | string | boolean>;
  output: Record<string, unknown>;
  sourceStorage?: 'runs_jsonl' | 'run_supplements_append';
  legacySourceField?: string;
}

export interface RunSupplement {
  id: string;
  runId: string;
  supplementKind: RunSupplementKind;
  createdAt: string;
  createdBy: ActorAttribution;
  sourceStorage: 'run_supplements_append' | 'migrated_from_runs_jsonl';
  legacySourceField?: string;
  legacyOriginalId?: string;
  originalOrder?: number;
  classificationBasis: string;
  verdict?: EvaluationVerdict;
  standaloneAnalysis?: StandaloneAnalysisRecord;
}

export interface ExperimentRun {
  id: string;
  sequenceNumber: number;
  createdAt: string;
  parentRunId: string | null;
  branchLabel: string;
  intent: string;
  mode: 'solve_only' | 'optimize';
  seed: number;
  runtimeEnv: RuntimeEnvironmentSnapshot;
  composition: {
    pattern: string;
    parts: CompositionPartRef[];
  };
  baseSnapshotId?: string | null;
  researchObjectId?: string | null;
  branchId?: string | null;
  effectiveConfig?: EffectiveExecutionConfig;
  candidateStatus?: 'unadopted' | 'adopted' | 'baseline';
  systemBefore: OpticalSystemSpec;
  systemAfter: OpticalSystemSpec;
  rawArtifactsBefore: RayTraceResult;
  rawArtifactsAfter: RayTraceResult;
  optimizationTrace: OptimizationIteration[];
  evaluations: EvaluationVerdict[];
  standaloneAnalyses?: StandaloneAnalysisRecord[];
  inputHash: string;
  rawArtifactsHash: string;
  recordIntegrityHash: string;
  tamperStatus?: 'verified' | 'tampered' | 'legacy_unhashed';
  executionMs: number;
  status: 'completed' | 'failed';
  errorMessage?: string;
}

export interface ThreadEntry {
  id: string;
  createdAt: string;
  origin: SourceOrigin;
  authorLabel: string;
  runId: string | null;
  componentId: string | null;
  title: string;
  content: string;
  metadata?: Record<string, string>;
}

export interface FitsHeaderCard {
  keyword: string;
  value: string;
  comment: string;
}

export interface FitsSourceDetection {
  id: number;
  xCentroid: number;
  yCentroid: number;
  peakAdu: number;
  apertureFlux: number;
  snrEstimate: number;
  fwhmPxEstimate: number;
  raDeg?: number | null;
  decDeg?: number | null;
  fwhmArcsec?: number | null;
  extractor?: 'ts_aperture' | 'photutils_DAOStarFinder' | 'sep_extract';
}

export interface FitsWcsInfo {
  ctype1: string;
  ctype2: string;
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  cdelt1: number;
  cdelt2: number;
  pixelScaleArcsec: number;
  centerRaDeg: number;
  centerDecDeg: number;
}

export interface FitsAnalysisResult {
  fileName: string;
  byteLength: number;
  bitpix: number;
  width: number;
  height: number;
  bscale: number;
  bzero: number;
  objectName: string;
  exposureSec: number | null;
  filterName: string;
  headers: FitsHeaderCard[];
  minValue: number;
  maxValue: number;
  meanValue: number;
  medianSky: number;
  madNoise: number;
  pixels: number[];
  detectedSources: FitsSourceDetection[];
  wcs?: FitsWcsInfo | null;
  extractorUsed?: string;
  tileMeta?: Record<string, unknown>;
}

export type ArchRelationType =
  | 'contains'
  | 'depends_on'
  | 'uses'
  | 'produces'
  | 'derives_from'
  | 'represents';

export type ArchProvenance = 'scanned' | 'observed' | 'declared' | 'manual' | 'inferred';

export type ProvenanceTier =
  | 'historical_migrated'
  | 'external_verified_import'
  | 'workbench_native';

export interface ArchNode {
  id: string;
  label: string;
  kind:
    | 'scope'
    | 'component'
    | 'subpart'
    | 'experiment_run'
    | 'source_module'
    | 'artifact_store'
    | 'research_study'
    | 'branch'
    | 'workflow_execution'
    | 'runtime_host';
  parentId: string | null;
  provenance: ArchProvenance;
  provenanceTier?: ProvenanceTier;
  evidence: string;
  status: 'healthy' | 'warning' | 'error' | 'unmapped' | 'unavailable';
  summary: string;
  codeHash?: string;
  sourceFilePath?: string;
  linkTarget?: {
    tab: 'experiment' | 'components' | 'compare' | 'architecture';
    targetId: string;
  };
}

export interface ArchEdge {
  id: string;
  source: string;
  target: string;
  relation: ArchRelationType;
  provenance: ArchProvenance;
  evidence: string;
  isSelfReference?: boolean;
}

export interface ArchAnomaly {
  severity: 'error' | 'warning' | 'info';
  code:
    | 'disk_hash_mismatch'
    | 'stale_self_check'
    | 'env_unavailable'
    | 'unmapped_directory'
    | 'unobserved_declared_dependency'
    | 'tampered_run_record';
  nodeId: string;
  message: string;
  evidence: string;
}

export interface ArchitectureMapData {
  generatedAt: string;
  rootScopeId: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  anomalies: ArchAnomaly[];
  capabilitiesSummary: {
    realImplemented: string[];
    declaredOrInferred: string[];
  };
}

export interface ArchitectureSnapshotDiff {
  addedNodes: ArchNode[];
  removedNodes: ArchNode[];
  changedNodes: Array<{ id: string; label: string; beforeStatus: string; afterStatus: string; beforeHash?: string; afterHash?: string }>;
  addedEdges: ArchEdge[];
  removedEdges: ArchEdge[];
  addedAnomalies: ArchAnomaly[];
  resolvedAnomalies: ArchAnomaly[];
}

// ============================================================================
// OpenLab Bench v2 — Research Study, Multi-Branch Workflow, Async Jobs & Artifacts
// ============================================================================

export type EpistemicTag = 'fact' | 'judgment' | 'hypothesis' | 'proposal';

export interface StudyStageRecord {
  stageNumber: number;
  title: string;
  status: 'completed' | 'in_progress' | 'open';
  summary: string;
  keyFinding: string;
  primaryArtifactIds: string[];
}

export interface StudyOpenQuestion {
  id: string;
  question: string;
  status: 'open' | 'investigating' | 'resolved';
  createdAt: string;
  resolutionNote?: string;
}

export interface ResearchStudy {
  id: string;
  slug: string;
  title: string;
  domain: string;
  status: 'active' | 'converged' | 'archived';
  provenanceTier: ProvenanceTier;
  problemStatement: string;
  backgroundContext: string;
  objectives: ResearchObjective[];
  criteria: AcceptanceCriterion[];
  openQuestions: StudyOpenQuestion[];
  stages: StudyStageRecord[];
  adoptedBranchId: string | null;
  adoptedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudyBranch {
  id: string;
  studyId: string;
  parentBranchId: string | null;
  name: string;
  shortCode: string;
  hypothesis: string;
  status: 'baseline' | 'exploring' | 'adopted' | 'archived_blocked' | 'rejected';
  provenanceTier: ProvenanceTier;
  summary: string;
  metrics: Record<string, number | string | boolean | null>;
  prescription?: Record<string, unknown>;
  artifactIds: string[];
  executionIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface ArtifactRef {
  id: string;
  studyId: string;
  branchId: string;
  executionId: string | null;
  kind:
    | 'optical_prescription_json'
    | 'tolerance_report_json'
    | 'fits_image'
    | 'astrometry_report_json'
    | 'verification_report_md'
    | 'ray_trace_json'
    | 'execution_log';
  title: string;
  relativePath: string;
  sha256: string;
  byteLength: number | null;
  provenanceTier: ProvenanceTier;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type P2RunnerMode =
  | 'wf_rc_perturb_eval'
  | 'fits_star_extract'
  | 'fits_batch_completeness'
  | 'wf_rc_s4_reopt_probe';

export interface WorkflowExecution {
  id: string;
  studyId: string;
  branchId: string;
  jobId: string | null;
  runnerMode:
    | 'p2_wf_rc_perturb_eval'
    | 'p2_fits_star_extract'
    | 'p2_fits_batch_completeness'
    | 'p2_wf_rc_s4_reopt_probe'
    | 'p1_ts_optical'
    | 'p1_optiland_python'
    | 'external_script_verified_import';
  title: string;
  intent: string;
  status: 'completed' | 'failed' | 'cancelled';
  provenanceTier: ProvenanceTier;
  parameters: Record<string, unknown>;
  outputs: Record<string, unknown>;
  artifactIds: string[];
  pythonExecutable?: string;
  packageVersions?: Record<string, string | null>;
  durationMs: number;
  createdAt: string;
  sha256Digest: string;
}

export interface AsyncJobRecord {
  id: string;
  studyId: string;
  parentBranchId: string;
  runnerMode: P2RunnerMode;
  title: string;
  intent: string;
  branchName: string;
  hypothesis: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  timeoutMs: number;
  parameters: Record<string, unknown>;
  logs: string[];
  resultBranchId: string | null;
  resultExecutionId: string | null;
  resultArtifactIds: string[];
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ProposedExperimentAction {
  label: string;
  studyId: string;
  parentBranchId: string;
  runnerMode: P2RunnerMode;
  branchName: string;
  hypothesis: string;
  intent: string;
  parameters: Record<string, unknown>;
}

export interface EpistemicNote {
  id: string;
  studyId: string;
  branchId: string | null;
  tag: EpistemicTag;
  authorType: 'human' | 'ai_deterministic' | 'ai_llm' | 'system_verifier';
  authorLabel: string;
  title: string;
  content: string;
  evidenceRefs: string[];
  proposedAction?: ProposedExperimentAction | null;
  createdAt: string;
}

export interface FitsCatalogEntry {
  id: string;
  studyId: string;
  systemKey: string;
  fieldDeg: number;
  relativePath: string;
  fileName: string;
  byteLength: number;
  sha256: string;
  summaryMetrics?: {
    skyRmsAdu?: number;
    photutilsCompletenessPct?: number;
    sepCompletenessPct?: number;
    sepAstrometryRmsArcsec?: number | null;
    sepMedianFwhmArcsec?: number | null;
  };
}

export interface ArchitectureAnnotation {
  id: string;
  nodeId: string;
  author: string;
  tag: EpistemicTag;
  note: string;
  createdAt: string;
}

export interface PersistedArchitectureSnapshot {
  id: string;
  capturedAt: string;
  reason: string;
  nodeCount: number;
  edgeCount: number;
  anomalyCount: number;
  mapDigestSha256: string;
  mapData: ArchitectureMapData;
}


