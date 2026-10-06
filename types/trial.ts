export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'duplicate-blocked'
  | 'conflict-blocked'
  | 'plan-created'
  | 'plan-superseded'
  | 'reconciled'
  | 'reconcile-failed'
  | 'paper-issued'
  | 'paper-merged'
  | 'paper-disputed'
  | 'paper-adjudicated'
  | 'merge-failed';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm: Arm;
  /** 入组时依据的分配方案版本 */
  planId: string;
  /** 分层键，如「上海中心|45-64」 */
  stratumKey: string;
  /** 是否由备用纸卡并入 */
  viaPaper?: boolean;
  unblindedAt?: string;
}

/** 分配方案：种子 + 区组长度 + 分层因素，确定可回放的整段序列 */
export interface AllocationPlan {
  id: string;
  version: number;
  /** 随机种子，序列回放的唯一依据 */
  seed: number;
  /** 区组长度，如 [4, 6]，每个区组随机取一个长度 */
  blockLengths: number[];
  /** 分层因素，如 ['site', 'ageBand'] */
  strataFactors: string[];
  createdAt: string;
  /** 从此随机号起生效，之前的号码仍按原方案核验 */
  effectiveFrom: number;
  status: 'active' | 'superseded';
  note?: string;
}

/** 备用纸卡：断网时按预印组别发出，联网后并入台账 */
export interface PaperCard {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  /** 纸卡上预印的组别 */
  paperArm: Arm;
  /** 纸卡上预印的随机号 */
  paperSequence: number;
  stratumKey: string;
  /** 印卡时依据的方案 */
  planId: string;
  /** 印卡时该分层在方案内的位置 */
  position: number;
  issuedAt: string;
  status: 'pending' | 'merged' | 'disputed' | 'adjudicated';
  /** 重建组别（与纸卡冲突时保留） */
  rebuiltArm?: Arm;
  rebuiltPlanId?: string;
  /** 监查员裁决组别 */
  adjudicatedArm?: Arm;
}

export interface ReconcileMismatch {
  participantNo: string;
  sequence: number;
  expectedArm: Arm;
  actualArm: Arm;
  planVersion: number;
}

export interface ReconcileResult {
  ok: boolean;
  checked: number;
  firstMismatch?: ReconcileMismatch;
  message: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  actor: string;
}
