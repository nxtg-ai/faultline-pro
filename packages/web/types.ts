
export type ClaimType = 'fact' | 'opinion' | 'interpretation';

export type ClaimStatus = 'supported' | 'contradicted' | 'mixed' | 'unverified' | 'loading' | 'skipped';

export interface Claim {
  id: string;
  text: string;
  type: ClaimType;
  importance: number; // 1 to 5
  // P-08b NOTE (TQ-003): Add `dependencies?: string[]` — array of claim IDs that this
  // claim logically depends on being true. Required for true weakest-chain traversal and
  // full claim-graph visualization. Deferred from Kaggle branch to avoid complicating
  // the stash/merge decision. Extraction prompts for all three providers will need updating
  // to identify logical dependencies when this is added.
}

export interface VerificationResult {
  claimId: string;
  status: ClaimStatus;
  explanation: string;
  sources: Array<{ title: string; uri: string }>;
}

export interface AnalysisState {
  claims: Claim[];
  verifications: Record<string, VerificationResult>;
  isProcessing: boolean;
  progressMessage: string;
  step: 'idle' | 'extracting' | 'verifying' | 'complete';
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  critique?: string;
  improvedPrompt?: string;
}
