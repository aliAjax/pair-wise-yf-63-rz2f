export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';

export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'duplicate-blocked'
  | 'slot-rejected'
  | 'cards-printed'
  | 'offline-issued'
  | 'batch-merged'
  | 'batch-conflict'
  | 'batch-failed'
  | 'adjudicated'
  | 'scheme-revised'
  | 'reconciled';

/** 分层因素组合，即区组随机序列的作用域 */
export interface Stratum {
  site: string;
  ageBand: AgeBand;
}

/** 一份能回放的分配方案：种子 + 区组长度 + 分层因素，版本化后只对之后入组生效 */
export interface AllocationScheme {
  revision: number;
  /** 方案定下的随机种子，配合分层键派生出每层独立序列 */
  seed: string;
  /** 区组长度（区组内 A/B 平衡，须为偶数） */
  blockSize: number;
  /** 方案覆盖的分层因素取值组合 */
  strata: Stratum[];
  note: string;
  createdAt: string;
  createdBy: string;
}

export interface RandomizeInput extends Stratum {
  participantNo: string;
  identityKey: string;
  actor: string;
}

export interface LedgerEntry {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  stratumKey: string;
  /** 该分层序列中的第几个位置（1 起），随机号即层内位置号 */
  position: number;
  randomNo: string;
  arm: Arm;
  /** 发放该号时所用的方案版本，核验始终按此版本回放 */
  schemeRevision: number;
  source: 'online' | 'paper';
  paperCardNo?: string;
  batchId?: string;
  coordinator: string;
  issuedAt: string;
  status: 'randomized' | 'unblinded' | 'conflicted';
  unblindedAt?: string;
  /** 监查员裁决结论：存在且为 paper 时，对账组别以裁决为准（随机号仍须与序列一致） */
  adjudicated?: 'rebuilt' | 'paper';
}

export interface PaperCard {
  cardNo: string;
  stratumKey: string;
  site: string;
  ageBand: AgeBand;
  position: number;
  randomNo: string;
  arm: Arm;
  schemeRevision: number;
  printedAt: string;
  used: boolean;
  usedByEntryId?: string;
}

export interface OfflineIssue extends RandomizeInput {
  cardNo: string;
  /** 断网时纸卡上实际记录/抄写的组别，并入时与重建组别比对 */
  recordedArm: Arm;
}

export interface OfflineBatch {
  id: string;
  coordinator: string;
  createdAt: string;
  status: 'pending' | 'merged' | 'failed';
  issues: OfflineIssue[];
  mergedAt?: string;
  errors?: string[];
}

/** 纸卡重建组别与纸卡不一致时，留两版交监查员裁决 */
export interface AdjudicationCase {
  id: string;
  entryId: string;
  participantNo: string;
  stratumKey: string;
  position: number;
  randomNo: string;
  /** 按方案回放重建出的组别 */
  rebuiltArm: Arm;
  /** 纸卡实际发出的组别 */
  paperArm: Arm;
  createdAt: string;
  batchId: string;
  status: 'pending' | 'resolved';
  resolution?: 'rebuilt' | 'paper';
  resolvedBy?: string;
  resolvedAt?: string;
  reason?: string;
}

export interface ReconcileMismatch {
  position: number;
  entryId: string;
  participantNo: string;
  randomNo: string;
  expectedRandomNo: string;
  actualArm: Arm;
  expectedArm: Arm;
  kind: 'random-no' | 'arm' | 'revision-missing' | 'gap';
}

export interface ReconcileStratumReport {
  stratumKey: string;
  site: string;
  ageBand: AgeBand;
  checked: number;
  mismatches: ReconcileMismatch[];
}

export interface ReconcileReport {
  ranAt: string;
  ranBy: string;
  totalChecked: number;
  ok: boolean;
  /** 全表第一个对不上的位置（跨层统一描述） */
  firstMismatch?: ReconcileMismatch & { stratumKey: string };
  strata: ReconcileStratumReport[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export interface TrialState {
  schemes: AllocationScheme[];
  currentRevision: number;
  ledger: LedgerEntry[];
  cards: PaperCard[];
  batches: OfflineBatch[];
  cases: AdjudicationCase[];
  lastReport?: ReconcileReport;
  audits: AuditEntry[];
}
