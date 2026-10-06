import { defineStore } from 'pinia';
import type {
  AllocationPlan,
  Arm,
  AuditEntry,
  PaperCard,
  Participant,
  RandomizeInput,
  ReconcileResult
} from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';
import { generateBlockArms, stratumKeyOf } from '~/utils/sequence';

const STORAGE_KEY = 'trial-randomization-v2';

/* ------------------------------------------------------------------ */
/* 种子数据：方案 v1 + 两例与方案一致的受试者                            */
/* ------------------------------------------------------------------ */

const seedPlan: AllocationPlan = {
  id: 'plan-seed',
  version: 1,
  seed: 20261006,
  blockLengths: [4, 6],
  strataFactors: ['site', 'ageBand'],
  createdAt: new Date(Date.now() - 86400_000).toISOString(),
  effectiveFrom: 1001,
  status: 'active',
  note: '初始方案',
};

const seed: {
  participants: Participant[];
  audits: AuditEntry[];
  plans: AllocationPlan[];
  paperCards: PaperCard[];
  stratumVersions: Record<string, number>;
  lastReconcile: ReconcileResult | null;
} = {
  participants: [
    {
      id: 'p-1',
      participantNo: 'S01-001',
      identityKey: 'demo-a',
      site: '上海中心',
      ageBand: '45-64',
      status: 'randomized',
      sequence: 1001,
      arm: 'B',
      planId: 'plan-seed',
      stratumKey: '上海中心|45-64',
    },
    {
      id: 'p-2',
      participantNo: 'S01-002',
      identityKey: 'demo-b',
      site: '上海中心',
      ageBand: '45-64',
      status: 'randomized',
      sequence: 1002,
      arm: 'B',
      planId: 'plan-seed',
      stratumKey: '上海中心|45-64',
    },
  ],
  audits: [
    {
      id: 'a-1',
      at: new Date(Date.now() - 3600_000).toISOString(),
      actor: '系统',
      action: 'randomized',
      detail: 'S01-002 完成分层随机，中央随机号 1002，组别 B（方案 v1）',
      participantNo: 'S01-002',
    },
  ],
  plans: [seedPlan],
  paperCards: [],
  stratumVersions: { 'plan-seed|上海中心|45-64': 2 },
  lastReconcile: null,
};

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    activePlan: (state): AllocationPlan => {
      const active = state.plans.find((p) => p.status === 'active');
      if (active) return active;
      return state.plans[state.plans.length - 1];
    },
    bySite: (state) =>
      state.participants.reduce<Record<string, number>>((result, participant) => {
        result[participant.site] = (result[participant.site] ?? 0) + 1;
        return result;
      }, {}),
    pendingPaperCount: (state) => state.paperCards.filter((c) => c.status === 'pending').length,
    disputedCount: (state) => state.paperCards.filter((c) => c.status === 'disputed').length,
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        plans: this.plans,
        paperCards: this.paperCards,
        stratumVersions: this.stratumVersions,
        lastReconcile: this.lastReconcile,
      });
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
    },

    /** 某方案某分层的下一个组别（回放序列） */
    nextArmFor(plan: AllocationPlan, stratumKey: string, position: number): Arm {
      return generateBlockArms(plan, stratumKey, position + 1)[position];
    },

    /* -------------------------------------------------------------- */
    /* 入组随机（含并发乐观锁）                                         */
    /* -------------------------------------------------------------- */
    async randomize(
      input: RandomizeInput,
      offline = false,
    ): Promise<{ ok: boolean; message: string; arm?: Arm; conflict?: boolean }> {
      if (offline) {
        this.issuePaperCard(input);
        return { ok: true, message: '已用备用纸卡发出，联网后并入台账' };
      }

      const plan = this.activePlan;
      const sk = stratumKeyOf(input.site, input.ageBand);
      const versionKey = `${plan.id}|${sk}`;
      const expectedVersion = this.stratumVersions[versionKey] ?? 0;

      // 模拟网络往返：两个协调员会同时读到同一个分层版本
      await new Promise((resolve) => setTimeout(resolve, 350 + Math.random() * 450));

      // 提交前复核：分层名额是否已被其他协调员抢先占用
      if ((this.stratumVersions[versionKey] ?? 0) !== expectedVersion) {
        this.addAudit(
          'conflict-blocked',
          `同一分层名额已被其他协调员抢先提交，已阻止重复放行：${input.participantNo}（${sk}）`,
          input.actor,
          input.participantNo,
        );
        this.persist();
        return { ok: false, conflict: true, message: '同一分层名额已被其他协调员抢先提交，请重试' };
      }
      // 提交前复核：重复入组
      if (this.participants.some((p) => p.identityKey === input.identityKey || p.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        this.persist();
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }

      // 原子提交：版本号即层内位置，序列在提交瞬间按当前台账长度生成
      const position = expectedVersion;
      const arm = this.nextArmFor(plan, sk, position);
      const sequence = 1000 + this.participants.length + 1;
      const participant: Participant = {
        id: crypto.randomUUID(),
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        status: 'randomized',
        sequence,
        arm,
        planId: plan.id,
        stratumKey: sk,
      };
      this.participants.unshift(participant);
      this.stratumVersions[versionKey] = expectedVersion + 1;
      this.addAudit(
        'randomized',
        `${input.participantNo} 完成分层随机，中央随机号 ${sequence}，组别 ${arm}（方案 v${plan.version}）`,
        input.actor,
        input.participantNo,
      );
      this.persist();
      return { ok: true, message: `随机成功，中央随机号 ${sequence}`, arm };
    },

    /* -------------------------------------------------------------- */
    /* 方案换版：只对之后入组生效                                       */
    /* -------------------------------------------------------------- */
    createPlan(seed: number, blockLengths: number[], note: string, actor: string) {
      const current = this.activePlan;
      const nextVersion = this.plans.length + 1;
      const effectiveFrom = 1000 + this.participants.length + 1;
      const plan: AllocationPlan = {
        id: `plan-${crypto.randomUUID()}`,
        version: nextVersion,
        seed,
        blockLengths,
        strataFactors: ['site', 'ageBand'],
        createdAt: new Date().toISOString(),
        effectiveFrom,
        status: 'active',
        note: note || undefined,
      };
      if (current) {
        current.status = 'superseded';
        this.addAudit('plan-superseded', `分配方案 v${current.version} 已停用，仅用于核验历史号码`, actor);
      }
      this.plans.push(plan);
      this.addAudit(
        'plan-created',
        `启用分配方案 v${plan.version}（种子 ${seed}，区组长度 ${blockLengths.join('/')}），自随机号 ${effectiveFrom} 起生效，之前号码仍按原方案核验`,
        actor,
      );
      this.persist();
    },

    /* -------------------------------------------------------------- */
    /* 飞行检查：按方案重建整段序列，逐例核对随机号与组别               */
    /* -------------------------------------------------------------- */
    reconcile(): ReconcileResult {
      try {
        const sorted = [...this.participants].sort((a, b) => a.sequence - b.sequence);
        const counters: Record<string, number> = {};
        let checked = 0;
        for (const p of sorted) {
          const plan = this.plans.find((pl) => pl.id === p.planId);
          if (!plan) throw new Error(`找不到分配方案 ${p.planId}`);
          const key = `${plan.id}|${p.stratumKey}`;
          const pos = counters[key] ?? 0;
          const expected = this.nextArmFor(plan, p.stratumKey, pos);
          counters[key] = pos + 1;
          checked++;
          if (expected !== p.arm) {
            const result: ReconcileResult = {
              ok: false,
              checked,
              firstMismatch: {
                participantNo: p.participantNo,
                sequence: p.sequence,
                expectedArm: expected,
                actualArm: p.arm,
                planVersion: plan.version,
              },
              message: `首个不一致位置：随机号 ${p.sequence}（${p.participantNo}），方案 v${plan.version} 重建组别为 ${expected}，台账记录为 ${p.arm}`,
              at: new Date().toISOString(),
            };
            this.lastReconcile = result;
            this.addAudit('reconcile-failed', result.message, '系统', p.participantNo);
            this.persist();
            return result;
          }
        }
        const result: ReconcileResult = {
          ok: true,
          checked,
          message: `对账完成，${checked} 例随机号与重建序列全部一致`,
          at: new Date().toISOString(),
        };
        this.lastReconcile = result;
        this.addAudit('reconciled', result.message, '系统');
        this.persist();
        return result;
      } catch (e) {
        // 重建失败：原台账与未完成批次保留，可重试
        const result: ReconcileResult = {
          ok: false,
          checked: 0,
          message: `重建失败：${(e as Error).message}，原台账保留，可重试`,
          at: new Date().toISOString(),
        };
        this.lastReconcile = result;
        this.addAudit('reconcile-failed', result.message, '系统');
        this.persist();
        return result;
      }
    },

    /* -------------------------------------------------------------- */
    /* 备用纸卡：断网时预印组别发出                                     */
    /* -------------------------------------------------------------- */
    issuePaperCard(input: RandomizeInput) {
      const plan = this.activePlan;
      const sk = stratumKeyOf(input.site, input.ageBand);
      const position = this.stratumVersions[`${plan.id}|${sk}`] ?? 0;
      const paperArm = this.nextArmFor(plan, sk, position);
      const pendingOffset = this.paperCards.filter((c) => c.status !== 'merged').length;
      const paperSequence = 1000 + this.participants.length + pendingOffset + 1;
      const card: PaperCard = {
        id: crypto.randomUUID(),
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        paperArm,
        paperSequence,
        stratumKey: sk,
        planId: plan.id,
        position,
        issuedAt: new Date().toISOString(),
        status: 'pending',
      };
      this.paperCards.unshift(card);
      this.addAudit(
        'paper-issued',
        `备用纸卡已发出：${input.participantNo}，纸卡号 ${paperSequence}，组别 ${paperArm}（方案 v${plan.version}）`,
        input.actor,
        input.participantNo,
      );
      this.persist();
    },

    /** 联网后并入台账：重建组别与纸卡核对，冲突则留两版交监查员裁决 */
    async mergePaperCard(id: string, actor: string): Promise<{ ok: boolean; message: string; disputed?: boolean }> {
      const card = this.paperCards.find((c) => c.id === id);
      if (!card || card.status !== 'pending') return { ok: false, message: '纸卡不存在或已处理' };
      try {
        const plan = this.activePlan;
        const versionKey = `${plan.id}|${card.stratumKey}`;
        const position = this.stratumVersions[versionKey] ?? 0;
        const rebuiltArm = this.nextArmFor(plan, card.stratumKey, position);

        if (rebuiltArm !== card.paperArm) {
          // 冲突：保留纸卡与重建两版，交监查员裁决，不动台账
          card.status = 'disputed';
          card.rebuiltArm = rebuiltArm;
          card.rebuiltPlanId = plan.id;
          const paperPlan = this.plans.find((p) => p.id === card.planId);
          this.addAudit(
            'paper-disputed',
            `纸卡与重建组别冲突：${card.participantNo}，纸卡 ${card.paperArm}（方案 v${paperPlan?.version ?? '?'}），重建 ${rebuiltArm}（方案 v${plan.version}），留两版交监查员裁决`,
            actor,
            card.participantNo,
          );
          this.persist();
          return { ok: false, disputed: true, message: `重建组别 ${rebuiltArm} 与纸卡 ${card.paperArm} 冲突，已留两版交监查员裁决` };
        }

        // 一致：并入台账
        const sequence = 1000 + this.participants.length + 1;
        const participant: Participant = {
          id: crypto.randomUUID(),
          participantNo: card.participantNo,
          identityKey: card.identityKey,
          site: card.site,
          ageBand: card.ageBand,
          status: 'randomized',
          sequence,
          arm: rebuiltArm,
          planId: plan.id,
          stratumKey: card.stratumKey,
          viaPaper: true,
        };
        this.participants.unshift(participant);
        this.stratumVersions[versionKey] = position + 1;
        card.status = 'merged';
        this.addAudit(
          'paper-merged',
          `纸卡并入台账：${card.participantNo}，中央随机号 ${sequence}，组别 ${rebuiltArm}`,
          actor,
          card.participantNo,
        );
        this.persist();
        return { ok: true, message: `纸卡已并入，中央随机号 ${sequence}` };
      } catch (e) {
        // 并入失败：纸卡保留为未完成批次，可重试，台账不动
        this.addAudit('merge-failed', `纸卡并入失败，纸卡保留可重试：${card.participantNo}`, actor, card.participantNo);
        this.persist();
        return { ok: false, message: `并入失败：${(e as Error).message}，可重试` };
      }
    },

    /** 监查员对冲突纸卡裁决，选定组别并入台账 */
    adjudicatePaperCard(id: string, arm: Arm, actor: string) {
      const card = this.paperCards.find((c) => c.id === id);
      if (!card || card.status !== 'disputed') return;
      const plan = this.activePlan;
      const versionKey = `${plan.id}|${card.stratumKey}`;
      const position = this.stratumVersions[versionKey] ?? 0;
      const sequence = 1000 + this.participants.length + 1;
      const participant: Participant = {
        id: crypto.randomUUID(),
        participantNo: card.participantNo,
        identityKey: card.identityKey,
        site: card.site,
        ageBand: card.ageBand,
        status: 'randomized',
        sequence,
        arm,
        planId: plan.id,
        stratumKey: card.stratumKey,
        viaPaper: true,
      };
      this.participants.unshift(participant);
      this.stratumVersions[versionKey] = position + 1;
      card.status = 'adjudicated';
      card.adjudicatedArm = arm;
      this.addAudit(
        'paper-adjudicated',
        `监查员裁决：${card.participantNo} 采用组别 ${arm}，中央随机号 ${sequence}`,
        actor,
        card.participantNo,
      );
      this.persist();
    },

    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
      this.persist();
    },
  },
});
