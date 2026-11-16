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

export interface ComponentVersionRecord {
  version: string;
  createdAt: string;
  parentVersion: string | null;
  author: 'system' | 'rad' | 'ai_suggested' | 'migrated_unknown';
  changeSummary: string;
  codeHash: string; // Full 64-char SHA-256 hex digest
  params: Record<string, number | string | boolean>;
  codeFile: string;
  lifecycle?: ComponentVersionLifecycle;
  frozenAt?: string | null;
  frozenByRunIds?: string[];
  frozenBySnapshotIds?: string[];
  sourceAvailability?: ComponentSourceAvailability;
  immutableBlobHash?: string | null;
  pinnedRelativeDeps?: PinnedRelativeDep[];
  casIntegrityStatus?: 'valid' | 'missing' | 'corrupted' | 'unpinned';
  casTamperDetected?: boolean;
  casAvailable?: boolean;
  workspaceMatchesFrozenHash?: boolean;
  frozenWorkspaceModified?: boolean;
  relativeDepsWorkspaceModified?: boolean;
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
}

export type ArchRelationType =
  | 'contains'
  | 'depends_on'
  | 'uses'
  | 'produces'
  | 'derives_from'
  | 'represents';

export type ArchProvenance = 'scanned' | 'observed' | 'declared' | 'manual' | 'inferred';

export interface ArchNode {
  id: string;
  label: string;
  kind: 'scope' | 'component' | 'subpart' | 'experiment_run' | 'source_module' | 'artifact_store';
  parentId: string | null;
  provenance: ArchProvenance;
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

