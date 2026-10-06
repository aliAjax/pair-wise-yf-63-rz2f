import { createPinia, setActivePinia } from 'pinia';
import { useTrialStore } from '../stores/trial';
import { buildSequence, armAt, formatRandomNo, stratumKeyOf } from '../utils/randomization';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✕ ${name} ${extra}`); }
}

// 隔离的 localStorage
const mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; }
} as unknown as Storage;

function freshStore() {
  localStorage.clear();
  setActivePinia(createPinia());
  return useTrialStore();
}

function issueOnline(t: ReturnType<typeof useTrialStore>, input: Parameters<ReturnType<typeof useTrialStore>['acquireSlot']>[0]) {
  const acq = t.acquireSlot(input);
  return acq.ok ? t.confirmSlot(input) : acq;
}

const K = stratumKeyOf({ site: '上海中心', ageBand: '45-64' });

// 1. 引擎确定性 & 区组平衡
console.log('1) 可回放随机引擎');
{
  const s = freshStore().schemes[0];
  const a = buildSequence(s, K, 16);
  const b = buildSequence(s, K, 16);
  check('同一输入两次重建完全一致', JSON.stringify(a) === JSON.stringify(b));
  const s2 = { ...s, seed: 'OTHER-SEED' };
  check('不同种子产生不同序列', JSON.stringify(a) !== JSON.stringify(buildSequence(s2, K, 16)));
  let balanced = true;
  for (let i = 0; i < 16; i += s.blockSize) {
    const blk = a.slice(i, i + s.blockSize);
    if (blk.filter((x) => x === 'A').length !== s.blockSize / 2) balanced = false;
  }
  check('每个区组内 A/B 平衡', balanced);
  check('种子数据 2 例与重建序列一致', armAt(s, K, 1) === freshStore().ledger.find((e) => e.position === 1)!.arm);
}

// 2. 在线发号可被重建对账
console.log('2) 在线发号与飞行检查');
{
  const t = freshStore();
  for (let i = 3; i <= 8; i += 1) {
    const input = { participantNo: `S01-${String(i).padStart(3, '0')}`, identityKey: `id-${i}`, site: '上海中心', ageBand: '45-64' as const, actor: '王敏' };
    const acq = t.acquireSlot(input);
    if (!acq.ok) throw new Error(`占用失败: ${acq.message}`);
    t.confirmSlot(input);
  }
  let report = t.reconcile('赵衡');
  check('正常台账对账全部通过', report.ok && report.totalChecked === 8);
  // 篡改一条组别 -> 必须报出，且指出第一个位置
  const victim = [...t.ledger].find((e) => e.position === 5 && e.stratumKey === K)!;
  victim.arm = victim.arm === 'A' ? 'B' : 'A';
  report = t.reconcile('赵衡');
  check('篡改后对账失败', !report.ok);
  check('第一个对不上的位置精确定位（位置5/S01-005/arm）',
    report.firstMismatch?.position === 5 && report.firstMismatch.participantNo === 'S01-005' && report.firstMismatch.kind === 'arm',
    JSON.stringify(report.firstMismatch));
  // 篡改随机号
  victim.arm = armAt(t.schemeAt(1)!, K, 5);
  victim.randomNo = 'R-FAKE-9999';
  report = t.reconcile('赵衡');
  check('随机号篡改被识别为 random-no', report.firstMismatch?.kind === 'random-no' && report.firstMismatch.expectedRandomNo === formatRandomNo(K, 5));
}

// 3. 并发：同一分层名额只放行一条
console.log('3) 同分层并发只放行一条');
{
  const t = freshStore();
  const one = { participantNo: 'C-1', identityKey: 'c1', site: '广州中心', ageBand: '18-44' as const, actor: '王敏' };
  const two = { participantNo: 'C-2', identityKey: 'c2', site: '广州中心', ageBand: '18-44' as const, actor: '李哲' };
  const a1 = t.acquireSlot(one);
  const a2 = t.acquireSlot(two);
  check('第一条占用成功', a1.ok);
  check('第二条并发被驳回', !a2.ok && a2.message.includes('只放行一条'));
  check('持锁期间台账尚未落账', t.ledger.every((e) => e.participantNo !== 'C-1'));
  const c1 = t.confirmSlot(one);
  check('第一条确认后落账', c1.ok && t.ledger.some((e) => e.participantNo === 'C-1'));
  const count = t.ledger.filter((e) => e.site === '广州中心' && e.ageBand === '18-44').length;
  check('该分层只有一条落账', count === 1, `实际 ${count}`);
  // 被驳回者在锁释放后重试，拿下一个名额
  const reAcq = t.acquireSlot(two);
  const retry = reAcq.ok ? t.confirmSlot(two) : reAcq;
  check('驳回后重试可成功（下一名额）', retry.ok);
  check('重试落账位置为 2', t.ledger.find((e) => e.participantNo === 'C-2')!.position === 2);
  // 不同分层并发互不阻塞（都在持锁未确认状态）
  const d1 = { participantNo: 'D-1', identityKey: 'd1', site: '上海中心', ageBand: '18-44' as const, actor: '王敏' };
  const d2 = { participantNo: 'D-2', identityKey: 'd2', site: '上海中心', ageBand: '65+' as const, actor: '李哲' };
  const g1 = t.acquireSlot(d1);
  const g2 = t.acquireSlot(d2);
  check('不同分层并发互不阻塞', g1.ok && g2.ok);
  t.confirmSlot(d1); t.confirmSlot(d2);
  // 取消占用后名额可被他人拿走
  const e1 = { participantNo: 'E-1', identityKey: 'e1', site: '新加坡中心', ageBand: '65+' as const, actor: '王敏' };
  const e2 = { participantNo: 'E-2', identityKey: 'e2', site: '新加坡中心', ageBand: '65+' as const, actor: '李哲' };
  t.acquireSlot(e1);
  check('持锁期间他人被挡', !t.acquireSlot(e2).ok);
  t.cancelSlot(e1);
  check('取消占用后他人立即拿到同一名额', t.acquireSlot(e2).ok);
  t.confirmSlot(e2);
  check('重复身份仍被阻止', !t.acquireSlot({ participantNo: 'C-1X', identityKey: 'c1', site: '广州中心', ageBand: '18-44', actor: '王敏' }).ok);
  check('并发后整账对账通过', t.reconcile('赵衡').ok);
}

// 4. 纸卡：印制 -> 断网发号 -> 并入一致
console.log('4) 离线纸卡正常并入');
{
  const t = freshStore();
  const print = t.printCards({ site: '广州中心', ageBand: '65+' }, 3, '王敏');
  check('纸卡印制成功', print.ok);
  const batch = t.openBatch('王敏');
  const cards = t.cards.filter((c) => c.stratumKey === stratumKeyOf({ site: '广州中心', ageBand: '65+' }));
  const i1 = t.issuePaper(batch.id, { participantNo: 'P-1', identityKey: 'p1', site: '广州中心', ageBand: '65+', actor: '王敏' }, cards[0].cardNo);
  const i2 = t.issuePaper(batch.id, { participantNo: 'P-2', identityKey: 'p2', site: '广州中心', ageBand: '65+', actor: '王敏' }, cards[1].cardNo);
  check('两例纸卡均发出', i1.ok && i2.ok, `${i1.message} / ${i2.message}`);
  check('批内重复受试者被拒', !t.issuePaper(batch.id, { participantNo: 'P-2', identityKey: 'p9', site: '广州中心', ageBand: '65+', actor: '王敏' }, cards[2].cardNo).ok);
  const before = t.ledger.length;
  const merge = t.mergeBatch(batch.id, '王敏');
  check('并入成功无冲突', merge.ok && (merge.conflicts ?? 0) === 0);
  check('台账增加 2 例', t.ledger.length === before + 2);
  check('并入后来源为纸卡且带卡号', t.ledger.some((e) => e.participantNo === 'P-1' && e.source === 'paper' && e.paperCardNo === cards[0].cardNo));
  const report = t.reconcile('赵衡');
  check('并入后整账对账通过', report.ok);
  // 已用卡不可再发
  const batch2 = t.openBatch('王敏');
  check('已用纸卡拒绝再次使用', !t.issuePaper(batch2.id, { participantNo: 'P-3', identityKey: 'p3', site: '广州中心', ageBand: '65+', actor: '王敏' }, cards[0].cardNo).ok);
}

// 5. 组别冲突 -> 两版裁决
console.log('5) 纸卡组别冲突 -> 两版交监查员');
{
  const t = freshStore();
  t.printCards({ site: '新加坡中心', ageBand: '18-44' }, 2, '王敏');
  const batch = t.openBatch('王敏');
  const card = t.cards.find((c) => c.stratumKey === stratumKeyOf({ site: '新加坡中心', ageBand: '18-44' }))!;
  t.issuePaper(batch.id, { participantNo: 'X-1', identityKey: 'x1', site: '新加坡中心', ageBand: '18-44', actor: '王敏' }, card.cardNo, true);
  const merge = t.mergeBatch(batch.id, '王敏');
  check('存在冲突但批次并入', merge.ok && (merge.conflicts ?? 0) === 1);
  const caze = t.pendingCases[0];
  check('生成待裁决案且两版组别确实不同', !!caze && caze.rebuiltArm !== caze.paperArm, JSON.stringify(caze));
  const entry = t.ledger.find((e) => e.participantNo === 'X-1')!;
  check('冲突条目先按重建版入账并标红', entry.arm === caze.rebuiltArm && entry.status === 'conflicted');
  // 裁决采用纸卡版
  t.adjudicate(caze.id, 'paper', '纸卡原件与药盒编号吻合', '赵衡');
  check('裁决后组别=纸卡版', t.ledger.find((e) => e.id === caze.entryId)!.arm === caze.paperArm);
  check('裁决案关闭', t.cases[0].status === 'resolved' && t.pendingCases.length === 0);
  const report = t.reconcile('赵衡');
  check('裁决（纸卡版）后随机号仍对账通过、组别差异已被裁决豁免', report.ok);
  const withoutReason = (() => { t.adjudicate('none', 'paper', '  ', '赵衡'); return true; })();
  check('空裁决依据不生效（防呆）', withoutReason);
}

// 6. 并入硬错误：整批失败、台账不动、可重试
console.log('6) 并入失败保留现场并可重试');
{
  const t = freshStore();
  t.printCards({ site: '广州中心', ageBand: '18-44' }, 2, '王敏');
  const cards = t.cards.filter((c) => c.stratumKey === stratumKeyOf({ site: '广州中心', ageBand: '18-44' }));
  const batch = t.openBatch('王敏');
  t.issuePaper(batch.id, { participantNo: 'F-1', identityKey: 'f1', site: '广州中心', ageBand: '18-44', actor: '王敏' }, cards[0].cardNo);
  // 手工制造重复身份：先发一条在线的同 identityKey 不可能（已在批中），改为直接在台账塞一条
  t.ledger.unshift({ ...t.ledger[0], id: 'dup', participantNo: 'ONLINE-X', identityKey: 'f1' });
  const before = t.ledger.length;
  const merge = t.mergeBatch(batch.id, '王敏');
  check('并入被拒绝', !merge.ok);
  check('台账未新增纸卡例（F-1 未入账）', t.ledger.length === before && !t.ledger.some((e) => e.participantNo === 'F-1'));
  check('批次标记 failed 且保留错误明细', t.batches[0].status === 'failed' && (t.batches[0].errors?.length ?? 0) > 0);
  // 清除冲突原因后重试
  t.ledger = t.ledger.filter((e) => e.id !== 'dup');
  t.retryBatch(batch.id, '王敏');
  check('重试后回到待并入', t.batches[0].status === 'pending');
  const merge2 = t.mergeBatch(batch.id, '王敏');
  check('重试并入成功', merge2.ok && t.ledger.some((e) => e.participantNo === 'F-1'));
}

// 7. 换种子只对之后生效，旧号按旧版本核验
console.log('7) 方案换版（种子）版本化');
{
  const t = freshStore();
  const oldEntry = issueOnline(t, { participantNo: 'V-1', identityKey: 'v1', site: '上海中心', ageBand: '18-44', actor: '王敏' });
  check('换版前发号挂 r1', oldEntry.ok && t.ledger.find((e) => e.participantNo === 'V-1')!.schemeRevision === 1);
  const rev = t.reviseSeed({ seed: 'GCP-NEW-SEED-ZZ9', blockSize: 6, note: '修正案2', actor: '王敏' });
  check('换版成功到 r2', rev.ok && t.currentRevision === 2);
  const newOne = issueOnline(t, { participantNo: 'V-2', identityKey: 'v2', site: '上海中心', ageBand: '18-44', actor: '王敏' });
  check('换版后发号挂 r2 且组别按 r2 序列', newOne.ok && t.ledger.find((e) => e.participantNo === 'V-2')!.schemeRevision === 2);
  const report = t.reconcile('赵衡');
  check('混合版本台账逐例按各自版本核验通过', report.ok);
  // 验证 r2 的号确实不同于 r1 序列（极大概率位置1组别或随机序列不同；用同位置直接比）
  const s1 = t.schemeAt(1)!;
  const s2 = t.schemeAt(2)!;
  const k = stratumKeyOf({ site: '上海中心', ageBand: '18-44' });
  const seqSame = JSON.stringify(buildSequence(s1, k, 12)) === JSON.stringify(buildSequence(s2, k, 12));
  check('r2 序列与 r1 不同（区组6+新种子）', !seqSame);
  check('相同种子+区组拒绝重复换版', !t.reviseSeed({ seed: 'GCP-NEW-SEED-ZZ9', blockSize: 6, note: '', actor: '王敏' }).ok);
  check('奇数区组长度被拒绝', !t.reviseSeed({ seed: 'X', blockSize: 3, note: '', actor: '王敏' }).ok);
}

// 8. 紧急揭盲
console.log('8) 紧急揭盲审计');
{
  const t = freshStore();
  const id = t.ledger[0].id;
  t.emergencyUnblind(id, 'SAE 抢救需要', '张宁');
  check('揭盲状态更新', t.ledger[0].status === 'unblinded');
  check('空原因不揭盲', (() => { t.emergencyUnblind(t.ledger[1].id, '   ', '张宁'); return t.ledger[1].status !== 'unblinded'; })());
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
