import { defineStore } from 'pinia';
import type {
  AdjudicationCase,
  AllocationScheme,
  Arm,
  AuditEntry,
  LedgerEntry,
  OfflineBatch,
  PaperCard,
  RandomizeInput,
  ReconcileReport,
  Stratum,
  TrialState
} from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';
import { armAt, buildPaperCards, buildSequence, formatRandomNo, stratumKeyOf } from '~/utils/randomization';

const STORAGE_KEY = 'trial-randomization-v2';

/** 同分层名额的占用锁（进程内、不持久化）：两个协调员同时提交时只放行一条。
 *  锁跨越“占用名额 → 确认发号”整段事务，只有确认或取消才释放。 */
interface SlotLock {
  stratumKey: string;
  position: number;
  coordinator: string;
  input: RandomizeInput;
  at: string;
}
const activeSlots: SlotLock[] = [];

const SITES = ['上海中心', '广州中心', '新加坡中心'];
const AGE_BANDS = ['18-44', '45-64', '65+'] as const;
const INITIAL_SEED = 'GCP-2026-MAIN-SEED-7F3A';
const INITIAL_BLOCK = 4;

function allStrata(): Stratum[] {
  return SITES.flatMap((site) => AGE_BANDS.map((ageBand) => ({ site, ageBand })));
}

function initialScheme(createdAt: string): AllocationScheme {
  return {
    revision: 1,
    seed: INITIAL_SEED,
    blockSize: INITIAL_BLOCK,
    strata: allStrata(),
    note: '方案首版：分层因素为研究中心 × 年龄段，区组随机',
    createdAt,
    createdBy: '系统'
  };
}

function seed(): TrialState {
  const scheme = initialScheme(new Date(Date.now() - 86_400_000).toISOString());
  const key = stratumKeyOf({ site: '上海中心', ageBand: '45-64' });
  const arms = buildSequence(scheme, key, 2);
  const now = Date.now() - 3600_000;
  const ledger: LedgerEntry[] = [1, 2].map((position) => ({
    id: `seed-${position}`,
    participantNo: `S01-00${position}`,
    identityKey: `demo-${position}`,
    site: '上海中心',
    ageBand: '45-64',
    stratumKey: key,
    position,
    randomNo: formatRandomNo(key, position),
    arm: arms[position - 1],
    schemeRevision: 1,
    source: 'online' as const,
    coordinator: '研究者张宁',
    issuedAt: new Date(now + position * 60_000).toISOString(),
    status: 'randomized' as const
  }));
  return {
    schemes: [scheme],
    currentRevision: 1,
    ledger,
    cards: [],
    batches: [],
    cases: [],
    audits: [
      { id: crypto.randomUUID(), at: new Date(now + 120_000).toISOString(), actor: '系统', action: 'randomized', detail: `S01-002 完成分层随机，随机号 ${ledger[1].randomNo}，组别 ${ledger[1].arm}`, participantNo: 'S01-002' }
    ]
  };
}

export const useTrialStore = defineStore('trial', {
  state: (): TrialState => readLocal(STORAGE_KEY, seed()),
  getters: {
    currentScheme(state): AllocationScheme {
      return state.schemes.find((item) => item.revision === state.currentRevision) ?? state.schemes[0];
    },
    activeBatches(state): OfflineBatch[] {
      return state.batches.filter((item) => item.status === 'pending');
    },
    pendingCases(state): AdjudicationCase[] {
      return state.cases.filter((item) => item.status === 'pending');
    },
    stratumNextPosition: (state) => (stratumKey: string) =>
      state.ledger.filter((item) => item.stratumKey === stratumKey).length + 1,
    ledgerByTime(state): LedgerEntry[] {
      return [...state.ledger].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
    },
    bySite: (state) => state.ledger.reduce<Record<string, number>>((result, entry) => {
      result[entry.site] = (result[entry.site] ?? 0) + 1;
      return result;
    }, {})
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, {
        schemes: this.schemes,
        currentRevision: this.currentRevision,
        ledger: this.ledger,
        cards: this.cards,
        batches: this.batches,
        cases: this.cases,
        lastReport: this.lastReport,
        audits: this.audits
      });
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    schemeAt(revision: number): AllocationScheme | undefined {
      return this.schemes.find((item) => item.revision === revision);
    },

    // —— 在线随机：名额占用锁，同分层并发只放行一条 ——
    /** 第一步：占用该分层的下一个名额。锁在确认/取消前持续持有。 */
    acquireSlot(input: RandomizeInput): { ok: boolean; message: string } {
      const stratumKey = stratumKeyOf(input);
      if (this.ledger.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      const held = activeSlots.find((lock) => lock.stratumKey === stratumKey);
      if (held) {
        this.addAudit('slot-rejected', `同分层名额已被 ${held.coordinator} 占用（位置 ${held.position}），驳回 ${input.actor} 的并发提交`, input.actor, input.participantNo);
        return { ok: false, message: `该分层下一名额正由 ${held.coordinator} 占用处理，本次只放行一条，请稍后重试` };
      }
      const position = this.stratumNextPosition(stratumKey);
      activeSlots.push({ stratumKey, position, coordinator: input.actor, input, at: new Date().toISOString() });
      return { ok: true, message: `已占用 ${stratumKey} 第 ${position} 个名额，待确认发号` };
    },
    /** 第二步：确认发号，按现行方案在锁定位置回放 A/B 并入账，随后释放锁。 */
    confirmSlot(input: RandomizeInput): { ok: boolean; message: string; arm?: Arm } {
      const lock = activeSlots.find((item) => item.stratumKey === stratumKeyOf(input)
        && item.input.participantNo === input.participantNo && item.input.actor === input.actor);
      if (!lock) return { ok: false, message: '未找到该协调员持有的名额锁，请重新占用名额' };
      if (this.ledger.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.cancelSlot(input);
        this.addAudit('duplicate-blocked', `确认时发现重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      const scheme = this.currentScheme;
      const arm = armAt(scheme, lock.stratumKey, lock.position);
      const entry: LedgerEntry = {
        id: crypto.randomUUID(),
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        stratumKey: lock.stratumKey,
        position: lock.position,
        randomNo: formatRandomNo(lock.stratumKey, lock.position),
        arm,
        schemeRevision: scheme.revision,
        source: 'online',
        coordinator: input.actor,
        issuedAt: new Date().toISOString(),
        status: 'randomized'
      };
      this.ledger.unshift(entry);
      activeSlots.splice(activeSlots.indexOf(lock), 1);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机（方案 r${scheme.revision}），随机号 ${entry.randomNo}，组别 ${arm}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，随机号 ${entry.randomNo}`, arm };
    },
    /** 放弃占用（误填/超时），名额释放给下一位提交者 */
    cancelSlot(input: RandomizeInput) {
      const index = activeSlots.findIndex((lock) => lock.stratumKey === stratumKeyOf(input)
        && lock.input.participantNo === input.participantNo && lock.input.actor === input.actor);
      if (index >= 0) activeSlots.splice(index, 1);
    },
    heldPosition(stratumKey: string, coordinator: string): number | undefined {
      return activeSlots.find((lock) => lock.stratumKey === stratumKey && lock.coordinator === coordinator)?.position;
    },

    /** 两名协调员并发“占用”同一分层名额：第一条放行、第二条驳回（锁持续到第一条确认） */
    raceSubmit(one: RandomizeInput, two: RandomizeInput): { first: string; second: string; then: string } {
      const r1 = this.acquireSlot(one);
      const r2 = this.acquireSlot(two);
      const confirm = this.confirmSlot(one);
      return { first: r1.message, second: r2.message, then: confirm.message };
    },

    // —— 备用纸卡：按现行方案预先印制，序列与线上同源 ——
    printCards(stratum: Stratum, count: number, actor: string): { ok: boolean; message: string } {
      if (!Number.isInteger(count) || count < 1 || count > 20) return { ok: false, message: '每次印制数量需在 1–20 之间' };
      const key = stratumKeyOf(stratum);
      const usedPositions = new Set<number>([
        ...this.ledger.filter((item) => item.stratumKey === key).map((item) => item.position),
        ...this.cards.filter((item) => item.stratumKey === key).map((item) => item.position)
      ]);
      let next = 1;
      while (usedPositions.has(next)) next += 1;
      const fresh = buildPaperCards(this.currentScheme, stratum, next, count)
        .filter((card) => !usedPositions.has(card.position));
      const printedAt = new Date().toISOString();
      const cards: PaperCard[] = fresh.map((card) => ({ ...card, printedAt }));
      this.cards.push(...cards);
      this.addAudit('cards-printed', `按方案 r${this.currentScheme.revision} 印制 ${key} 备用纸卡 ${cards.length} 张：位置 ${next} 起`, actor);
      return { ok: true, message: `已印制 ${cards.length} 张纸卡（${key}，位置 ${next}–${next + cards.length - 1}）` };
    },

    // —— 离线批次：断网发号，网络恢复后并入 ——
    openBatch(coordinator: string): OfflineBatch {
      const batch: OfflineBatch = { id: crypto.randomUUID(), coordinator, createdAt: new Date().toISOString(), status: 'pending', issues: [] };
      this.batches.unshift(batch);
      this.persist();
      return batch;
    },
    issuePaper(batchId: string, input: RandomizeInput, cardNo: string, simulateTranscriptionError = false): { ok: boolean; message: string } {
      const batch = this.batches.find((item) => item.id === batchId && item.status === 'pending');
      if (!batch) return { ok: false, message: '未找到未完成批次' };
      const key = stratumKeyOf(input);
      const card = this.cards.find((item) => item.cardNo === cardNo);
      if (!card) return { ok: false, message: '纸卡号不存在' };
      if (card.used) return { ok: false, message: `纸卡 ${cardNo} 已被使用` };
      if (card.stratumKey !== key) return { ok: false, message: `纸卡属于分层 ${card.stratumKey}，与受试者分层不符` };
      if (this.ledger.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)
        || batch.issues.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `离线发号拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在' };
      }
      const recordedArm: Arm = simulateTranscriptionError ? (card.arm === 'A' ? 'B' : 'A') : card.arm;
      batch.issues.push({ ...input, cardNo, recordedArm });
      card.used = true;
      card.usedByEntryId = `tentative:${batch.id}:${card.position}`;
      this.addAudit('offline-issued',
        `断网期间以纸卡 ${cardNo} 发号：${input.participantNo}，随机号 ${card.randomNo}，纸卡组别 ${recordedArm}${simulateTranscriptionError ? '（模拟抄写错误，用于演练两版裁决）' : ''}`,
        input.actor, input.participantNo);
      this.persist();
      return { ok: true, message: `纸卡 ${cardNo} 已发出，随机号 ${card.randomNo}` };
    },

    /**
     * 网络恢复后并入台账：按同一方案逐例重建序列核对。
     * 硬错误（重号/缺卡/位置错位/随机号不符）整批失败、不动台账、批次保留可重试；
     * 仅组别冲突的，按重建组别入台账并保留纸卡版，生成裁决案交监查员。
     */
    mergeBatch(batchId: string, actor: string): { ok: boolean; message: string; conflicts?: number } {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch || batch.status !== 'pending') return { ok: false, message: '批次不存在或已并入' };
      const errors: string[] = [];
      const planned: { issue: OfflineBatch['issues'][number]; card: PaperCard; expectedPosition: number; expectedArm: Arm }[] = [];
      const positionCounters = new Map<string, number>();

      for (const issue of batch.issues) {
        const key = stratumKeyOf({ site: issue.site, ageBand: issue.ageBand });
        const card = this.cards.find((item) => item.cardNo === issue.cardNo);
        if (!card) { errors.push(`${issue.participantNo}：纸卡 ${issue.cardNo} 不存在`); continue; }
        if (this.ledger.some((item) => item.identityKey === issue.identityKey || item.participantNo === issue.participantNo)) {
          errors.push(`${issue.participantNo}：身份标识或受试者编号与台账重复`);
          continue;
        }
        const expectedPosition = (positionCounters.get(key)
          ?? this.ledger.filter((item) => item.stratumKey === key).length) + 1;
        positionCounters.set(key, expectedPosition);
        if (card.position !== expectedPosition) {
          errors.push(`${issue.participantNo}：纸卡位置 ${card.position} 与重建位置 ${expectedPosition} 不符（随机号将错位）`);
          continue;
        }
        const scheme = this.schemeAt(card.schemeRevision);
        if (!scheme) { errors.push(`${issue.participantNo}：纸卡依据的方案 r${card.schemeRevision} 已不存在，无法核验`); continue; }
        const expectedArm = armAt(scheme, key, expectedPosition);
        const expectedNo = formatRandomNo(key, expectedPosition);
        if (card.randomNo !== expectedNo) {
          errors.push(`${issue.participantNo}：纸卡随机号 ${card.randomNo} 与重建随机号 ${expectedNo} 不符`);
        }
        planned.push({ issue, card, expectedPosition, expectedArm });
      }

      if (errors.length > 0) {
        batch.status = 'failed';
        batch.errors = errors;
        this.addAudit('batch-failed', `批次 ${batch.id.slice(0, 8)} 并入失败，台账未改动，未完成批次保留可重试：${errors.join('；')}`, actor);
        this.persist();
        return { ok: false, message: `并入失败（${errors.length} 处硬错误），台账未改动，可重试` };
      }

      let conflicts = 0;
      const now = new Date().toISOString();
      for (const item of planned) {
        const paperArm = item.issue.recordedArm ?? item.card.arm;
        const conflicted = paperArm !== item.expectedArm;
        const entry: LedgerEntry = {
          id: crypto.randomUUID(),
          participantNo: item.issue.participantNo,
          identityKey: item.issue.identityKey,
          site: item.issue.site,
          ageBand: item.issue.ageBand,
          stratumKey: item.card.stratumKey,
          position: item.expectedPosition,
          randomNo: item.card.randomNo,
          arm: item.expectedArm,
          schemeRevision: item.card.schemeRevision,
          source: 'paper',
          paperCardNo: item.card.cardNo,
          batchId: batch.id,
          coordinator: item.issue.actor,
          issuedAt: now,
          status: conflicted ? 'conflicted' : 'randomized'
        };
        this.ledger.unshift(entry);
        if (conflicted) {
          conflicts += 1;
          this.cases.unshift({
            id: crypto.randomUUID(),
            entryId: entry.id,
            participantNo: entry.participantNo,
            stratumKey: entry.stratumKey,
            position: entry.position,
            randomNo: entry.randomNo,
            rebuiltArm: item.expectedArm,
            paperArm,
            createdAt: now,
            batchId: batch.id,
            status: 'pending'
          });
        }
      }
      batch.status = 'merged';
      batch.mergedAt = now;
      this.addAudit(conflicts > 0 ? 'batch-conflict' : 'batch-merged',
        conflicts > 0
          ? `批次 ${batch.id.slice(0, 8)} 已并入 ${planned.length} 例，其中 ${conflicts} 例重建组别与纸卡冲突，已留两版交监查员裁决`
          : `批次 ${batch.id.slice(0, 8)} 全部 ${planned.length} 例核验一致并并入台账`,
        actor);
      this.persist();
      return { ok: true, message: conflicts > 0 ? `已并入，${conflicts} 例组别冲突待监查员裁决` : '批次全部核验一致，已并入台账', conflicts };
    },
    /** 失败后重试：批次回到待并入；原台账与批次内容都未改动 */
    retryBatch(batchId: string, actor: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch || batch.status !== 'failed') return;
      batch.status = 'pending';
      batch.errors = undefined;
      this.addAudit('batch-failed', `批次 ${batch.id.slice(0, 8)} 重新排队并入（重试），原台账与未完成批次保留`, actor);
      this.persist();
    },

    // —— 监查员裁决：重建版与纸卡版二选一 ——
    adjudicate(caseId: string, resolution: 'rebuilt' | 'paper', reason: string, actor: string) {
      const adjudication = this.cases.find((item) => item.id === caseId && item.status === 'pending');
      if (!adjudication || !reason.trim()) return;
      const entry = this.ledger.find((item) => item.id === adjudication.entryId);
      const chosen = resolution === 'rebuilt' ? adjudication.rebuiltArm : adjudication.paperArm;
      if (entry) {
        entry.arm = chosen;
        entry.status = 'randomized';
        entry.adjudicated = resolution;
      }
      adjudication.status = 'resolved';
      adjudication.resolution = resolution;
      adjudication.resolvedBy = actor;
      adjudication.resolvedAt = new Date().toISOString();
      adjudication.reason = reason.trim();
      this.addAudit('adjudicated',
        `${adjudication.participantNo}（${adjudication.stratumKey} 位置 ${adjudication.position}）裁决采用${resolution === 'rebuilt' ? '方案重建' : '纸卡'}组别 ${chosen}：${reason.trim()}`,
        actor, adjudication.participantNo);
    },

    // —— 换种子：新版本只对之后入组生效；已发号码仍按原序列版本核验 ——
    reviseSeed(input: { seed: string; blockSize: number; note: string; actor: string }): { ok: boolean; message: string } {
      if (!input.seed.trim()) return { ok: false, message: '新种子不能为空' };
      if (!Number.isInteger(input.blockSize) || input.blockSize < 2 || input.blockSize % 2 !== 0) {
        return { ok: false, message: '区组长度须为不小于 2 的偶数' };
      }
      if (input.seed === this.currentScheme.seed && input.blockSize === this.currentScheme.blockSize) {
        return { ok: false, message: '种子与区组长度与现行方案相同，无需换版' };
      }
      const revision = this.currentRevision + 1;
      const scheme: AllocationScheme = {
        revision,
        seed: input.seed.trim(),
        blockSize: input.blockSize,
        strata: allStrata(),
        note: input.note.trim() || `方案第 ${revision} 版`,
        createdAt: new Date().toISOString(),
        createdBy: input.actor
      };
      this.schemes.push(scheme);
      this.currentRevision = revision;
      this.addAudit('scheme-revised', `分配方案换版至 r${revision}（新种子，区组长度 ${input.blockSize}）；已发出号码仍按各自原序列版本核验`, input.actor);
      return { ok: true, message: `方案已换版至 r${revision}，仅对之后入组生效` };
    },

    // —— 飞行检查：按同一份输入重建整段序列，逐例核对已发出的随机号和组别 ——
    reconcile(actor: string): ReconcileReport {
      const strata = new Map(this.currentScheme.strata.map((stratum) => [stratumKeyOf(stratum), stratum]));
      const reports: ReconcileReport['strata'] = [];
      let totalChecked = 0;
      let firstMismatch: ReconcileReport['firstMismatch'];

      for (const [stratumKey, stratum] of [...strata.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const entries = this.ledger
          .filter((item) => item.stratumKey === stratumKey)
          .sort((a, b) => a.position - b.position);
        const mismatches: ReconcileReport['strata'][number]['mismatches'] = [];
        if (entries.length > 0) {
          let expected = 1;
          for (const entry of entries) {
            const scheme = this.schemeAt(entry.schemeRevision);
            if (!scheme) {
              mismatches.push({ position: entry.position, entryId: entry.id, participantNo: entry.participantNo, randomNo: entry.randomNo, expectedRandomNo: '—', actualArm: entry.arm, expectedArm: entry.arm, kind: 'revision-missing' });
            } else {
              if (entry.position !== expected) {
                mismatches.push({ position: expected, entryId: entry.id, participantNo: entry.participantNo, randomNo: entry.randomNo, expectedRandomNo: formatRandomNo(stratumKey, expected), actualArm: entry.arm, expectedArm: armAt(scheme, stratumKey, expected), kind: 'gap' });
              }
              const expectedNo = formatRandomNo(stratumKey, entry.position);
              const expectedArm = armAt(scheme, stratumKey, entry.position);
              if (entry.randomNo !== expectedNo) {
                mismatches.push({ position: entry.position, entryId: entry.id, participantNo: entry.participantNo, randomNo: entry.randomNo, expectedRandomNo: expectedNo, actualArm: entry.arm, expectedArm, kind: 'random-no' });
              }
              if (entry.arm !== expectedArm && entry.adjudicated !== 'paper') {
                mismatches.push({ position: entry.position, entryId: entry.id, participantNo: entry.participantNo, randomNo: entry.randomNo, expectedRandomNo: expectedNo, actualArm: entry.arm, expectedArm, kind: 'arm' });
              }
            }
            expected = entry.position + 1;
            totalChecked += 1;
          }
        }
        reports.push({ stratumKey, site: stratum.site, ageBand: stratum.ageBand, checked: entries.length, mismatches });
        for (const mismatch of mismatches) {
          if (!firstMismatch || mismatch.position < firstMismatch.position
            || (mismatch.position === firstMismatch.position && stratumKey < firstMismatch.stratumKey)) {
            firstMismatch = { ...mismatch, stratumKey };
          }
        }
      }

      const report: ReconcileReport = { ranAt: new Date().toISOString(), ranBy: actor, totalChecked, ok: !firstMismatch, firstMismatch, strata: reports };
      this.lastReport = report;
      this.addAudit('reconciled', firstMismatch
        ? `飞行检查核对 ${totalChecked} 例：首个不符位于 ${firstMismatch.stratumKey} 位置 ${firstMismatch.position}（${firstMismatch.kind === 'random-no' ? `随机号应为 ${firstMismatch.expectedRandomNo}，实发 ${firstMismatch.randomNo}` : firstMismatch.kind === 'arm' ? `组别应为 ${firstMismatch.expectedArm}，实发 ${firstMismatch.actualArm}` : firstMismatch.kind}），受试者 ${firstMismatch.participantNo}`
        : `飞行检查核对 ${totalChecked} 例：随机号与组别逐例与方案重建序列一致`, actor);
      return report;
    },

    emergencyUnblind(id: string, reason: string, actor: string) {
      const entry = this.ledger.find((item) => item.id === id);
      if (!entry || !reason.trim() || entry.status === 'conflicted') return;
      entry.status = 'unblinded';
      entry.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason.trim()}；分配组别 ${entry.arm}`, actor, entry.participantNo);
    }
  }
});
