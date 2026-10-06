<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { TrialRole } from '~/types/trial';
import { stratumKeyOf } from '~/utils/randomization';

const { t } = useI18n();
const trial = useTrialStore();
const { schemes, currentRevision, ledger, cards, batches, cases, lastReport, audits } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');

const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({
  validationSchema: schema,
  initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '协调员王敏' }
});
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

const held = ref(false);
const lastValues = ref<Record<string, string>>({});
const submit = handleSubmit((values) => {
  const acquired = trial.acquireSlot(values);
  if (!acquired.ok) {
    ElMessage.error(acquired.message);
    return;
  }
  lastValues.value = values;
  held.value = true;
  ElMessage.success(acquired.message);
});
const confirmIssue = () => {
  const result = trial.confirmSlot(lastValues.value as any);
  if (!result.ok) { ElMessage.error(result.message); return; }
  held.value = false;
  ElMessage.success(result.message);
  const v = lastValues.value;
  resetForm({ values: { participantNo: '', identityKey: '', site: v.site, ageBand: v.ageBand as any, actor: v.actor } });
};
const cancelIssue = () => {
  trial.cancelSlot(lastValues.value as any);
  held.value = false;
  ElMessage.info('已放弃名额占用');
};

// —— 并发演练：两名协调员同时提交同一分层名额 ——
const raceSeq = ref(100);
const raceResult = ref<{ first: string; second: string; then: string } | null>(null);
const fireRace = () => {
  const seq = ++raceSeq.value;
  const base = { site: site.value!, ageBand: ageBand.value! };
  raceResult.value = trial.raceSubmit(
    { ...base, participantNo: `S01-R${seq}A`, identityKey: `race-${seq}-a`, actor: '协调员王敏' },
    { ...base, participantNo: `S01-R${seq}B`, identityKey: `race-${seq}-b`, actor: '协调员李哲' }
  );
};

// —— 纸卡印制 ——
const printCount = ref(2);
const printSite = ref('上海中心');
const printAge = ref<'18-44' | '45-64' | '65+'>('45-64');
const doPrint = () => {
  const result = trial.printCards({ site: printSite.value, ageBand: printAge.value }, printCount.value, actor.value!);
  if (result.ok) ElMessage.success(result.message); else ElMessage.error(result.message);
};

// —— 离线批次 ——
const openCoordinator = ref('协调员王敏');
const openBatch = () => {
  const batch = trial.openBatch(openCoordinator.value);
  issueBatchId.value = batch.id;
  ElMessage.success(`已开启离线批次 ${batch.id.slice(0, 8)}`);
};
const issueBatchId = ref('');
const issueCardNo = ref('');
const issueParticipantNo = ref('');
const issueIdentityKey = ref('');
const issueSite = ref('上海中心');
const issueAge = ref<'18-44' | '45-64' | '65+'>('45-64');
const issueActor = ref('协调员王敏');
const transcribeError = ref(false);

const availableCards = computed(() => cards.value
  .filter((card) => !card.used && card.site === issueSite.value && card.ageBand === issueAge.value));
const issueSeq = ref(200);

const doIssue = () => {
  if (!issueBatchId.value) { ElMessage.error('请先选择未完成批次'); return; }
  if (!issueCardNo.value) { ElMessage.error('请选择备用纸卡'); return; }
  const seq = ++issueSeq.value;
  const result = trial.issuePaper(
    issueBatchId.value,
    { participantNo: issueParticipantNo.value || `S01-O${seq}`, identityKey: issueIdentityKey.value || `offline-${seq}`, site: issueSite.value, ageBand: issueAge.value, actor: issueActor.value },
    issueCardNo.value,
    transcribeError.value
  );
  if (result.ok) {
    ElMessage.success(result.message);
    issueParticipantNo.value = '';
    issueIdentityKey.value = '';
    issueCardNo.value = '';
    transcribeError.value = false;
  } else {
    ElMessage.error(result.message);
  }
};

const doMerge = (id: string) => {
  const result = trial.mergeBatch(id, '协调员王敏');
  if (result.ok) ElMessage.success(result.message); else ElMessage.error(result.message);
};
const doRetry = (id: string) => {
  trial.retryBatch(id, '协调员王敏');
  ElMessage.success('已重新排队并入，原台账与批次保留');
};

// —— 对账 ——
const doReconcile = () => {
  const report = trial.reconcile(role.value === 'monitor' ? '监查员赵衡' : '协调员王敏');
  if (report.ok) ElMessage.success(`核对 ${report.totalChecked} 例全部一致`);
  else ElMessage.error('发现不符，已标出第一个对不上的位置');
};
const kindText: Record<string, string> = {
  'random-no': '随机号不符',
  arm: '组别不符',
  gap: '序列位置空缺/错位',
  'revision-missing': '方案版本缺失'
};

// —— 换种子 ——
const newSeed = ref('');
const newBlock = ref(4);
const reviseNote = ref('');
const doRevise = async () => {
  const result = trial.reviseSeed({ seed: newSeed.value, blockSize: newBlock.value, note: reviseNote.value, actor: actor.value! });
  if (!result.ok) { ElMessage.error(result.message); return; }
  ElMessage.success(result.message);
  newSeed.value = '';
  reviseNote.value = '';
};

// —— 紧急揭盲 ——
const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认并审计'
    });
    trial.emergencyUnblind(id, value, actor.value!);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

// —— 监查员裁决 ——
const adjudicate = async (caseId: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 的两版差异填写裁决依据`, '监查员裁决', {
      inputType: 'textarea',
      inputValidator: (v) => Boolean(v?.trim()) || '裁决依据不能为空',
      confirmButtonText: '确认裁决'
    });
    const resolution = await ElMessageBox.confirm('采用哪一版？确定=方案重建版，取消=纸卡版', '选择组别版本', {
      distinguishCancelAndClose: true,
      confirmButtonText: '方案重建版',
      cancelButtonText: '纸卡版'
    }).then(() => 'rebuilt' as const).catch((action: string) => action === 'cancel' ? 'paper' as const : null);
    if (!resolution) return;
    trial.adjudicate(caseId, resolution, value, '监查员赵衡');
    ElMessage.success('裁决已记录');
  } catch {}
};

const visibleArm = (row: { arm?: string; status?: string }) => {
  if (row.status === 'conflicted') return '冲突待裁决';
  if (role.value === 'pharmacist') return row.arm ?? '待分配';
  if (role.value === 'monitor' && row.status === 'unblinded') return row.arm;
  return '已隐藏';
};

const counts = computed(() => ({
  total: ledger.value.length,
  unblinded: ledger.value.filter((item) => item.status === 'unblinded').length,
  batches: trial.activeBatches.length,
  cases: trial.pendingCases.length,
  cards: cards.value.filter((item) => !item.used).length
}));

const stratumLabel = (site: string, ageBand: string) => stratumKeyOf({ site, ageBand: ageBand as '18-44' });
</script>

<template>
  <main class="page">
    <header class="hero">
      <div>
        <el-tag type="success">GCP 本地原型 · 可回放随机</el-tag>
        <h1>{{ t('title') }}</h1>
        <p>{{ t('subtitle') }}</p>
      </div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监查员', value: 'monitor' }]" />
    </header>

    <section class="stat-row">
      <div class="stat"><span>已发出随机号</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>未并入批次</span><b>{{ counts.batches }}</b></div>
      <div class="stat"><span>待裁决冲突</span><b :class="{ hot: counts.cases > 0 }">{{ counts.cases }}</b></div>
      <div class="stat"><span>空白纸卡</span><b>{{ counts.cards }}</b></div>
    </section>

    <el-tabs type="border-card">
      <!-- 在线随机 + 并发演练 -->
      <el-tab-pane label="在线随机" name="online">
        <div class="grid">
          <el-card shadow="never">
            <template #header><b>执行分层区组随机</b><el-tag size="small" style="float:right">现行方案 r{{ currentRevision }}</el-tag></template>
            <el-form label-position="top" @submit.prevent="submit">
              <el-form-item label="研究中心" :error="errors.site">
                <el-select v-model="site" style="width:100%">
                  <el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" />
                </el-select>
              </el-form-item>
              <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
              <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
              <el-form-item label="年龄分层" :error="errors.ageBand">
                <el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group>
              </el-form-item>
              <el-form-item label="协调员" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
              <template v-if="!held">
                <el-button type="primary" native-type="submit" style="width:100%">占用该分层下一名额</el-button>
              </template>
              <template v-else>
                <el-alert type="warning" :closable="false" style="margin-bottom:10px" title="名额已占用，第二名协调员此刻会被驳回；核对信息后确认发号。" />
                <div style="display:flex;gap:8px">
                  <el-button type="primary" style="flex:1" @click="confirmIssue">确认发号</el-button>
                  <el-button style="flex:1" @click="cancelIssue">取消占用</el-button>
                </div>
              </template>
            </el-form>
          </el-card>

          <el-card shadow="never">
            <template #header><b>并发提交演练</b></template>
            <p class="hint">王敏与李哲同时向「{{ site }} / {{ ageBand }}」的下一个名额提交。同分层名额只有一条，第一条放行、第二条被驳回并留审计。</p>
            <el-button type="warning" plain style="width:100%" @click="fireRace">两人同时提交同一分层名额</el-button>
            <el-alert v-if="raceResult" type="info" :closable="false" style="margin-top:12px">
              <div><el-tag size="small" type="success">放行</el-tag> {{ raceResult.first }}</div>
              <div style="margin-top:8px"><el-tag size="small" type="danger">驳回</el-tag> {{ raceResult.second }}</div>
              <div style="margin-top:8px"><el-tag size="small">随后</el-tag> {{ raceResult.then }}</div>
            </el-alert>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- 离线纸卡 -->
      <el-tab-pane label="离线纸卡与并入" name="offline">
        <div class="grid">
          <el-card shadow="never">
            <template #header><b>① 按现行方案预制备用纸卡</b></template>
            <el-form label-position="top">
              <el-form-item label="研究中心"><el-select v-model="printSite" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
              <el-form-item label="年龄分层"><el-radio-group v-model="printAge"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
              <el-form-item label="印制数量"><el-input-number v-model="printCount" :min="1" :max="20" /></el-form-item>
              <el-button type="primary" @click="doPrint">印制纸卡（随机号与组别按方案序列生成）</el-button>
            </el-form>
            <el-table :data="cards" max-height="240" size="small" style="margin-top:12px">
              <el-table-column prop="cardNo" label="纸卡号" min-width="120" />
              <el-table-column prop="stratumKey" label="分层" min-width="150" />
              <el-table-column prop="position" label="位置" width="70" />
              <el-table-column prop="randomNo" label="随机号" min-width="120" />
              <el-table-column label="组别" width="70"><template #default="{ row }">{{ row.arm }}</template></el-table-column>
              <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.used ? 'info' : 'success'" size="small">{{ row.used ? '已用' : '空白' }}</el-tag></template></el-table-column>
            </el-table>
          </el-card>

          <el-card shadow="never">
            <template #header><b>② 断网期间开批次、凭纸卡发号</b></template>
            <div style="display:flex;gap:8px;align-items:center">
              <el-input v-model="openCoordinator" placeholder="负责协调员" style="width:180px" />
              <el-button type="primary" @click="openBatch">开启离线批次</el-button>
            </div>
            <el-divider />
            <el-form label-position="top">
              <el-form-item label="并入目标批次">
                <el-select v-model="issueBatchId" style="width:100%" placeholder="选择未完成批次">
                  <el-option v-for="b in trial.activeBatches" :key="b.id" :label="`${b.id.slice(0,8)} · ${b.coordinator} · ${b.issues.length} 例`" :value="b.id" />
                </el-select>
              </el-form-item>
              <el-form-item label="研究中心"><el-select v-model="issueSite" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
              <el-form-item label="年龄分层"><el-radio-group v-model="issueAge"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
              <el-form-item label="空白纸卡">
                <el-select v-model="issueCardNo" style="width:100%" :placeholder="availableCards.length ? '选择纸卡' : '该分层暂无空白纸卡'">
                  <el-option v-for="c in availableCards" :key="c.cardNo" :label="`${c.cardNo}（位置 ${c.position}，随机号 ${c.randomNo}）`" :value="c.cardNo" />
                </el-select>
              </el-form-item>
              <el-form-item label="受试者编号（留空自动生成）"><el-input v-model="issueParticipantNo" placeholder="S01-004" /></el-form-item>
              <el-form-item label="身份核验标识（留空自动生成）"><el-input v-model="issueIdentityKey" /></el-form-item>
              <el-form-item label="发号协调员"><el-input v-model="issueActor" /></el-form-item>
              <el-form-item><el-checkbox v-model="transcribeError" border>模拟纸卡组别抄写错误（用于演练两版裁决）</el-checkbox></el-form-item>
              <el-button type="primary" @click="doIssue">凭纸卡发出随机号</el-button>
            </el-form>
          </el-card>
        </div>

        <el-card shadow="never" style="margin-top:20px">
          <template #header><b>③ 网络恢复后并入台账</b><span class="hint">按同一份方案逐例重建序列核对；硬错误整批失败不动台账，可重试；组别冲突留两版交监查员。</span></template>
          <el-table :data="batches">
            <el-table-column label="批次" min-width="100"><template #default="{ row }">{{ row.id.slice(0, 8) }}</template></el-table-column>
            <el-table-column prop="coordinator" label="协调员" width="120" />
            <el-table-column label="例数" width="70"><template #default="{ row }">{{ row.issues.length }}</template></el-table-column>
            <el-table-column label="纸卡号（受试者）" min-width="220">
              <template #default="{ row }">{{ row.issues.map((i: any) => `${i.cardNo}↦${i.participantNo}/${i.recordedArm}`).join('，') }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><el-tag :type="row.status === 'merged' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'" size="small">{{ row.status === 'merged' ? '已并入' : row.status === 'failed' ? '失败可重试' : '待并入' }}</el-tag></template>
            </el-table-column>
            <el-table-column label="错误 / 操作" min-width="240">
              <template #default="{ row }">
                <template v-if="row.errors">
                  <div v-for="(e, i) in row.errors" :key="i" class="err">✕ {{ e }}</div>
                </template>
                <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="doMerge(row.id)">核对并并入</el-button>
                <el-button v-if="row.status === 'failed'" size="small" type="warning" @click="doRetry(row.id)">重试（保留原台账与批次）</el-button>
                <el-tag v-if="row.status === 'merged'" size="small" type="success">并入于 {{ new Date(row.mergedAt).toLocaleTimeString() }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 分配方案与对账 -->
      <el-tab-pane label="分配方案与飞行检查" name="scheme">
        <div class="grid">
          <el-card shadow="never">
            <template #header><b>可回放分配方案</b><el-tag size="small" type="success" style="float:right">现行 r{{ currentRevision }}</el-tag></template>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="方案版本">r{{ trial.currentScheme.revision }}（{{ trial.currentScheme.note }}）</el-descriptions-item>
              <el-descriptions-item label="随机种子"><code>{{ trial.currentScheme.seed }}</code></el-descriptions-item>
              <el-descriptions-item label="区组长度">{{ trial.currentScheme.blockSize }}（每区组 A/B 平衡，确定性洗牌）</el-descriptions-item>
              <el-descriptions-item label="分层因素">{{ trial.currentScheme.strata.length }} 个：研究中心 × 年龄段</el-descriptions-item>
              <el-descriptions-item label="生效时间">{{ new Date(trial.currentScheme.createdAt).toLocaleString() }}（{{ trial.currentScheme.createdBy }}）</el-descriptions-item>
            </el-descriptions>
            <el-divider>版本沿革</el-divider>
            <el-timeline>
              <el-timeline-item v-for="s in [...schemes].reverse()" :key="s.revision" :timestamp="`r${s.revision} · ${new Date(s.createdAt).toLocaleString()}`" :type="s.revision === currentRevision ? 'success' : 'info'">
                种子 <code>{{ s.seed }}</code>，区组 {{ s.blockSize }} —— {{ s.note }}
              </el-timeline-item>
            </el-timeline>
          </el-card>

          <el-card shadow="never">
            <template #header><b>换种子（仅对之后入组生效）</b></template>
            <el-alert type="warning" :closable="false" title="已发出的随机号不重算，永远按发出时的方案版本重建核验；新版本只决定之后的序列。" style="margin-bottom:12px" />
            <el-form label-position="top">
              <el-form-item label="新随机种子"><el-input v-model="newSeed" placeholder="例如 GCP-2026-AMEND-9K2Q" /></el-form-item>
              <el-form-item label="区组长度（偶数）"><el-input-number v-model="newBlock" :min="2" :max="12" :step="2" /></el-form-item>
              <el-form-item label="换版说明"><el-input v-model="reviseNote" type="textarea" :rows="2" placeholder="方案修正案编号 / 原因" /></el-form-item>
              <el-button type="primary" @click="doRevise">发布新版本方案</el-button>
            </el-form>
            <el-divider />
            <el-button type="success" size="large" style="width:100%" @click="doReconcile">按方案重建整段序列 · 逐例飞行检查</el-button>
            <div v-if="lastReport" style="margin-top:14px">
              <el-alert :type="lastReport.ok ? 'success' : 'error'" :closable="false" style="margin-bottom:10px">
                <template #title>{{ new Date(lastReport.ranAt).toLocaleString() }} · {{ lastReport.ranBy }} · 共核对 {{ lastReport.totalChecked }} 例：{{ lastReport.ok ? '随机号与组别逐例一致' : '发现不符' }}</template>
              </el-alert>
              <el-alert v-if="lastReport.firstMismatch" type="error" :closable="false" style="margin-bottom:10px">
                <template #title>
                  第一个对不上的位置：{{ lastReport.firstMismatch.stratumKey }} 第 {{ lastReport.firstMismatch.position }} 号位置 · 受试者 {{ lastReport.firstMismatch.participantNo }} · {{ kindText[lastReport.firstMismatch.kind] }}
                </template>
                <div v-if="lastReport.firstMismatch.kind === 'random-no'">实发随机号 {{ lastReport.firstMismatch.randomNo }}，重建应为 {{ lastReport.firstMismatch.expectedRandomNo }}</div>
                <div v-else-if="lastReport.firstMismatch.kind === 'arm'">实发组别 {{ lastReport.firstMismatch.actualArm }}，重建应为 {{ lastReport.firstMismatch.expectedArm }}</div>
              </el-alert>
              <el-table :data="lastReport.strata" size="small" max-height="260">
                <el-table-column prop="stratumKey" label="分层" min-width="170" />
                <el-table-column prop="checked" label="已核对" width="80" />
                <el-table-column label="不符" width="70">
                  <template #default="{ row }"><el-tag :type="row.mismatches.length ? 'danger' : 'success'" size="small">{{ row.mismatches.length }}</el-tag></template>
                </el-table-column>
                <el-table-column label="明细" min-width="260">
                  <template #default="{ row }">
                    <div v-for="m in row.mismatches" :key="m.entryId + m.kind" class="err">
                      位置 {{ m.position }} · {{ kindText[m.kind] }} · {{ m.participantNo }}
                      <template v-if="m.kind === 'random-no'">（{{ m.randomNo }} → 应为 {{ m.expectedRandomNo }}）</template>
                      <template v-else-if="m.kind === 'arm'">（{{ m.actualArm }} → 应为 {{ m.expectedArm }}）</template>
                    </div>
                    <span v-if="!row.mismatches.length" class="hint">一致</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- 台账与裁决 -->
      <el-tab-pane label="分配台账与裁决" name="ledger">
        <el-card v-if="trial.pendingCases.length" shadow="never" style="margin-bottom:20px">
          <template #header><b><el-tag type="danger">待监查员裁决（两版并存）</el-tag></b></template>
          <el-table :data="trial.pendingCases">
            <el-table-column prop="participantNo" label="受试者" width="110" />
            <el-table-column prop="stratumKey" label="分层" min-width="160" />
            <el-table-column prop="position" label="位置" width="70" />
            <el-table-column prop="randomNo" label="随机号" min-width="120" />
            <el-table-column label="方案重建版" width="110"><template #default="{ row }"><el-tag type="primary">{{ row.rebuiltArm }}</el-tag></template></el-table-column>
            <el-table-column label="纸卡实发版" width="110"><template #default="{ row }"><el-tag type="warning">{{ row.paperArm }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="130">
              <template #default="{ row }"><el-button size="small" type="danger" plain :disabled="role !== 'monitor'" @click="adjudicate(row.id, row.participantNo)">{{ role === 'monitor' ? '监查员裁决' : '切监查员角色' }}</el-button></template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never">
          <template #header><b>分配台账（中心本地留存）</b><el-tag style="float:right" size="small">{{ role }}</el-tag></template>
          <el-table :data="trial.ledgerByTime" max-height="560">
            <el-table-column prop="participantNo" label="受试者" width="105" />
            <el-table-column label="分层" min-width="160"><template #default="{ row }">{{ stratumLabel(row.site, row.ageBand) }}</template></el-table-column>
            <el-table-column prop="position" label="层内位置" width="85" />
            <el-table-column prop="randomNo" label="随机号" min-width="120" />
            <el-table-column label="治疗组" width="100">
              <template #default="{ row }"><el-tag :type="row.status === 'conflicted' ? 'danger' : row.status === 'unblinded' ? 'warning' : 'info'">{{ visibleArm(row as { arm?: string; status?: string }) }}</el-tag></template>
            </el-table-column>
            <el-table-column label="来源 / 版本" min-width="130">
              <template #default="{ row }">
                <el-tag size="small" :type="row.source === 'paper' ? 'warning' : 'success'">{{ row.source === 'paper' ? `纸卡 ${row.paperCardNo}` : '在线' }}</el-tag>
                <el-tag size="small" effect="plain">r{{ row.schemeRevision }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100">
              <template #default="{ row }"><el-button v-if="role === 'investigator' && row.status !== 'conflicted'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button></template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 审计 -->
      <el-tab-pane label="安全审计" name="audit">
        <el-card shadow="never">
          <template #header><b>审计流水</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
          <el-timeline>
            <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="entry.action === 'unblinded' || entry.action === 'batch-conflict' ? 'danger' : entry.action === 'duplicate-blocked' || entry.action === 'slot-rejected' || entry.action === 'batch-failed' ? 'warning' : 'primary'">
              <b>{{ entry.actor }} · {{ entry.action }}</b>
              <div>{{ entry.detail }}</div>
            </el-timeline-item>
          </el-timeline>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </main>
</template>

<style scoped>
.hint { color: #8499a8; font-size: 12px; margin: 0 0 10px; }
.err { color: #c45656; font-size: 12px; line-height: 1.7; }
.hot { color: #c45656; }
@media (max-width: 900px) { .stat-row { grid-template-columns: 1fr 1fr !important; } .hero { align-items: flex-start; flex-direction: column; } }
</style>
