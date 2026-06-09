export { MainAgent } from './main-agent';
export { seedMemoryHygiene } from './memory-hygiene-seed';
export type { MemoryHygieneSeedResult } from './memory-hygiene-seed';
export { detectFormatCompliance, MAX_COMPLIANCE_INPUT } from './dispatch-pipeline';
export { loadSkills, DEFAULT_KEYWORDS, resolveSkillExists, resolveSkill } from './skill-loader';
export type { LoadSkillsResult, DroppedSkill } from './skill-loader';
export { SkillCounterTracker } from './skill-counters';
export type { MainAgentConfig } from './main-agent';
export { WorkerAgent } from './worker-agent';
export type { TaskCompleteCallback } from './worker-agent';
export { AgentRegistry } from './agent-registry';
export type { FindBestMatchOptions } from './agent-registry';
export { TaskDispatcher } from './task-dispatcher';
export {
  createProvider,
  createProviderForAgent,
  resolveAgentProvider,
  KEY_REQUIRING_PROVIDERS,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  QuotaExhaustedException,
  PROVIDER_PLACEHOLDER_RE,
} from './llm-client';
export type { ILLMProvider, LLMGenerateOptions } from './llm-client';
export { recordAuthFailure, clearAuthFailure, readRecentAuthFailures } from './auth-state';
export type { AuthFailure } from './auth-state';
export * from './types';
export * from './consensus-types';
export type { ImplSignal, MetaSignal, PerformanceSignal } from './consensus-types';
export { SkillCatalog } from './skill-catalog';
export type { CatalogEntry } from './skill-catalog';
export { SkillGapTracker, SKILL_FRESHNESS_MS } from './skill-gap-tracker';
export type { GapSuggestion, GapResolution, GapEntry, GapData } from './skill-gap-tracker';
export { SkillIndex } from './skill-index';
export type { SkillSlot, SkillIndexData } from './skill-index';
export {
  seedPermanentDefaults,
  GLOBAL_PERMANENT_DEFAULTS,
  IMPLEMENTER_PERMANENT_DEFAULTS,
  RESEARCHER_REVIEWER_PERMANENT_DEFAULTS,
} from './permanent-defaults';
export { assemblePrompt, assembleUtilityPrompt, MAX_ASSEMBLED_PROMPT_CHARS, extractSpecReferences, buildSpecReviewEnrichment, parseSpecFrontMatter, CONSENSUS_OUTPUT_FORMAT, FINDING_TAG_SCHEMA, UTILITY_DATA_ONLY_PREAMBLE, buildUtilityAgentPrompt } from './prompt-assembler';
export type { SpecStatus } from './prompt-assembler';
export { parseAgentFindingsStrict, PARSE_FINDINGS_LIMITS } from './parse-findings';
export type { ParsedFinding, ParseFindingsResult, ParseFindingsOptions, FindingType, Severity, ParseDiagnostic } from './parse-findings';
export { computeDedupeKey, DEDUPE_KEY_INTERNALS } from './dedupe-key';
export type { DedupeKeyInput } from './dedupe-key';
export { AgentMemoryReader } from './agent-memory';
export { MemoryWriter } from './memory-writer';
export type { SessionArtifacts } from './memory-writer';
export { refreshMemoryIndex, applyStatusTags } from './memory-index';
export type { RefreshResult, MemoryStatus } from './memory-index';
export {
  loadIndex,
  rebuildIndex,
  rebuildMemoryMd,
  regenerateMemoryMd,
  buildFullIndex,
  parseMemoryFrontmatter,
  tokenize,
  sidecarPath,
  corpusDir,
  tryAcquireLockOnce,
} from './memory-index-sidecar';
export type { MemoryIndex, MemoryIndexDoc, MemoryFrontmatter } from './memory-index-sidecar';
export { bm25Score, rankDocuments } from './memory-index-bm25';
export type { BM25Options } from './memory-index-bm25';
export { MemoryCompactor } from './memory-compactor';
export { TaskGraph } from './task-graph';
export { TaskGraphSync } from './task-graph-sync';
export type { SyncMigrationConfig } from './task-graph-sync';
export { GossipPublisher } from './gossip-publisher';
export { DispatchPipeline } from './dispatch-pipeline';
export type { DispatchPipelineConfig, ToolServerCallbacks, SkillGapSuggestionResult, FormatComplianceResult } from './dispatch-pipeline';
export { ScopeTracker } from './scope-tracker';
export { RateLimiter } from './rate-limiter';
export { createHttpBridgeServer, BridgeConfigError } from './http-bridge-server';
export type { HttpBridgeServer, HttpBridgeServerOptions } from './http-bridge-server';
export { WorktreeManager } from './worktree-manager';
export { BootstrapGenerator } from './bootstrap';
export {
  checkDistMcpStaleness,
  resetStalenessCache,
  formatStalenessWarning,
  logStalenessToMcpLog,
  renderStalenessBanner,
} from './dist-mcp-staleness';
export type { StalenessResult } from './dist-mcp-staleness';
export type { BootstrapResult } from './bootstrap';
export { findBundledRules, ensureRulesFile, readRulesContent } from './rules-loader';
export { installWorktreeSandboxHook, findBundledHook, writeOrchestratorRoleMarker, installDisciplineHooks, installBootstrapHook, BOOTSTRAP_HOOK_COMMAND } from './hook-installer';
export type { HookInstallResult, DisciplineHookInstallResult, BootstrapHookInstallResult } from './hook-installer';
export { OverlapDetector } from './overlap-detector';
export { LensGenerator } from './lens-generator';
export { PerformanceWriter, rotateJsonlIfNeeded, MAX_TELEMETRY_BYTES } from './performance-writer';
export { PerformanceReader, readJsonlWithRotated } from './performance-reader';
export {
  loadOrRebuildAggregateIndex,
  rebuildAggregateIndex,
  readAggregateIndex,
  readCountersSince as readAggregateCountersSince,
  sidecarIsStale,
  SIDECAR_VERSION,
  SIDECAR_FILENAME,
} from './signal-aggregate-index';
export type { SignalAggregateIndexData, SignalAggregateBucket } from './signal-aggregate-index';
export type { AgentScore } from './performance-reader';
export { ConsensusEngine } from './consensus-engine';
export type { ConsensusEngineConfig } from './consensus-engine';
export { validateResolutionRoot, parseWorktreePorcelain, listWorktreePaths, gitCommonDir, hashPath } from './validate-resolution-root';
export type { ValidationResult } from './validate-resolution-root';
export { discoverGitWorktrees } from './discover-git-worktrees';
export type { DiscoverResult } from './discover-git-worktrees';
export {
  parseNextSessionBullets,
  findOpenSectionLine,
  readLedgerIndex,
  writeLedgerIndex,
  runLedgerVerification,
  defaultVerifierFactory,
  triggerBackgroundVerification,
  annotateLedgerText,
  annotationPrefix,
  hashContent,
  ledgerIndexPath,
  ledgerMtime,
  LEDGER_INDEX_FILENAME,
} from './verify-ledger-background';
export type {
  ParsedBullet,
  LedgerIndex,
  LedgerIndexEntry,
  LedgerVerdict,
  BulletVerifier,
  ParseNextSessionOptions,
} from './verify-ledger-background';
export {
  buildProseResolverIndex,
  resolveProseBullet,
  extractTokens,
  proseResolverPath,
  discoverAgentIdsForRoot,
  isProseResolverIndex,
  PROSE_RESOLVER_FILENAME,
  PROSE_RESOLVER_VERSION,
  JACCARD_THRESHOLD,
  MIN_TOKEN_MATCHES,
  AMBIGUITY_WINDOW,
  FRONTMATTER_READ_LIMIT,
  SIDECAR_READ_LIMIT,
  DISCOVER_AGENT_CAP,
} from './prose-bullet-resolver';
export type { ProseResolverIndex, ProseResolveResult } from './prose-bullet-resolver';
export { ToolRouter, ToolExecutor } from './tool-router';
export type { ToolExecutorConfig } from './tool-router';
export { buildToolSystemPrompt, TOOL_SCHEMAS, PLAN_CHOICES, PENDING_PLAN_CHOICES } from './tool-definitions';
export { ArchetypeCatalog } from './archetype-catalog';
export { ProjectInitializer } from './project-initializer';
export type { ProjectInitializerConfig } from './project-initializer';
export { TeamManager } from './team-manager';
export type { TeamManagerConfig } from './team-manager';
export { normalizeSkillName } from './skill-name';
export { parseSkillFrontmatter } from './skill-parser';
export type { SkillFrontmatter, SkillScope } from './skill-parser';
export { extractCategories, isValidCategory, VALID_CATEGORIES } from './category-extractor';
export { logUncategorizedFinding, getUncategorizedStatusLine } from './uncategorized-logger';
export type { UncategorizedFindingContext, UncategorizedFindingRecord } from './uncategorized-logger';
export { selectCrossReviewers } from './cross-reviewer-selection';
export type { FindingForSelection, AgentCandidate } from './cross-reviewer-selection';
export { DispatchDifferentiator } from './dispatch-differentiator';
export { shouldSkipConsensus } from './dispatch-pipeline';
export { SkillEngine } from './skill-engine';
export { readSkillFreshness, computeCooldown, formatCooldownMessage } from './skill-freshness';
export type { SkillFreshnessResult, CooldownDecision } from './skill-freshness';
export { MemorySearcher } from './memory-searcher';
export type { SearchResult } from './memory-searcher';
export { oneSidedZTest, resolveVerdict, MIN_EVIDENCE, ALPHA, Z_CRITICAL, TIMEOUT_DAYS, TIMEOUT_MS } from './check-effectiveness';
export type { VerdictStatus, SkillSnapshot, CategoryCounters, VerdictResult } from './check-effectiveness';
export { emitCompletionSignals, emitCitationFabricatedSignal } from './completion-signals';
export type { CompletionSignalInput, CitationFabricatedInput } from './completion-signals';
export {
  emitConsensusSignals,
  emitSandboxSignals,
  emitImplSignals,
  emitScoringAdjustmentSignals,
  emitPipelineSignals,
} from './signal-helpers';
export {
  shouldRewriteToTransportFailure,
  appendTransportRewrite,
  lookupRoundResolutionRoots,
  extractConsensusId,
  maybeRewriteHallucinationToTransportFailure,
  TRANSPORT_FAILURE_PATTERN,
} from './transport-failure-detector';
export type {
  TransportFailureContext,
  TransportRewriteAudit,
} from './transport-failure-detector';
export { COMPLETION_SIGNAL_ALLOWLIST, EMISSION_PATHS } from './completion-signals.allowlist';
export type { EmissionPath } from './completion-signals.allowlist';
export { PipelineDriftDetector } from './pipeline-drift-detector';
export type { DriftDetectionResult, DriftOffender, PipelineDriftDetectorOptions } from './pipeline-drift-detector';
export { loadMemoryConfig } from './memory-config';
export type { MemoryConfig } from './memory-config';
export { parseClaimBlock } from './claim-types';
export type {
  Claim,
  ClaimBlock,
  ClaimVerdict,
  Modality,
  Relation,
  CallsiteCountClaim,
  FileLineClaim,
  AbsenceOfSymbolClaim,
  PresenceOfSymbolClaim,
  CountRelationClaim,
  ParseClaimBlockResult,
  ParseError,
} from './claim-types';
export { verifyClaims, MAX_CLAIMS_PER_BLOCK, PER_BLOCK_DEADLINE_MS } from './claim-verifier';
export { sanitizeForLog } from './_sanitize';
export { bump as bumpRoundCounter, get as getRoundCounter, reset as resetRoundCounter, deriveConsensusId } from './round-counter';
export { withResolverLock, RESOLVER_LOCK_INTERNALS } from './file-lock';
export {
  appendChainedEntry,
  computeEntryHash,
  verifyChain,
  stableStringify,
  ZERO_HASH,
  AUDIT_LOG_FILENAME,
} from './audit-log-chain';
export type { AuditEntry, AuditEntryInput } from './audit-log-chain';
export {
  resolveFindings,
  parseCites,
  validatePath,
  isAutoMemoryPath,
  inferLeadIdentifier,
  stripJsTsComments,
  containsToken,
  classifyPresence,
  FINDING_RESOLVER_INTERNALS,
} from './finding-resolver';
export type { ResolveOptions, ResolveResult, ResolveSkipped, SymbolPresence } from './finding-resolver';
export { TaskStreamEventType } from './task-stream';
export type { TaskStreamEvent } from './task-stream';
export {
  getRuntimeFlag,
  getRuntimeFlagBool,
  getRuntimeFlagInt,
  setRuntimeFlag,
  unsetRuntimeFlag,
  listRuntimeFlags,
  reloadRuntimeFlags,
} from './runtime-config';
export type { RuntimeFlagEntry, RuntimeFlagRegistry } from './runtime-config';
export { RUNTIME_FLAG_REGISTRY } from './runtime-config-schema';
export type { RuntimeFlagKey, RuntimeFlagSpec } from './runtime-config-schema';
export { ChatbotAgent } from './chatbot-agent';
export type { ChatbotTool, ChatbotAgentConfig, ChatStreamEvent } from './chatbot-agent';
