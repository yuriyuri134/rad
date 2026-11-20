import type { ProvenanceTier } from './types.ts';

export interface ArtifactPort {
  mediaType: string;
  schemaId: string;
  jsonSchema?: Record<string, unknown>;
  description?: string;
}

export interface ArtifactContract {
  protocol: 'openlab-files/v1';
  inputs: Record<string, ArtifactPort>;
  outputs: Record<string, ArtifactPort>;
  parameters?: Record<string, unknown>;
  pythonPackages?: Record<string, string>;
  timeoutMs?: number;
}

export interface ArtifactRecord extends Omit<ArtifactPort, 'jsonSchema' | 'description'> {
  id: string;
  name: string;
  sha256: string;
  byteLength: number;
  provenance: ProvenanceTier | 'user_import';
  studyId: string;
  executionId: string | null;
  outputPort: string | null;
  importedFrom?: string;
  createdAt: string;
}

export interface ComponentSelection {
  componentId: string;
  version: string;
}

export interface ExecutionRequest extends ComponentSelection {
  studyId: string;
  branchId?: string;
  inputs: Record<string, string>;
  parameters: Record<string, unknown>;
}

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ExecutionRecord {
  id: string;
  request: ExecutionRequest;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  rerunOf?: string;
  recipeRunId?: string;
  recipeStepId?: string;
  inputs: Record<string, ArtifactRecord>;
  outputs: Record<string, ArtifactRecord>;
  component: ComponentSelection & {
    contract: ArtifactContract;
    codeHash: string;
    sources: Record<string, string>;
  };
  environment: {
    runtime: 'node' | 'python';
    executable: string;
    version: string;
    packages: Record<string, string | null>;
    platform: string;
  };
}

export type RecipeInput = { artifactId: string } | { stepId: string; outputPort: string };

export interface RecipeStep extends ComponentSelection {
  id: string;
  label: string;
  inputs: Record<string, RecipeInput>;
  parameters: Record<string, unknown>;
}

export interface WorkflowRecipe {
  name: string;
  studyId: string;
  branchId?: string;
  steps: RecipeStep[];
}

export interface RecipeRunRecord {
  id: string;
  recipe: WorkflowRecipe;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  continuedFrom?: string;
  executions: Record<string, string>;
}
