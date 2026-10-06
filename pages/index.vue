<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { Arm, RandomizeInput, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, paperCards, plans, activePlan, lastReconcile } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm, values } = useForm({
  validationSchema: schema,
  initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' }
});
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

const visibleArm = (arm?: Arm, status?: string) => {
  if (role.value === 'pharmacist') return arm ?? '待分配';
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};

const submit = handleSubmit(async (vals) => {
  const result = await trial.randomize(vals, offline.value);
  if (!result.ok) {
    ElMessage({ type: 'warning', message: result.message, duration: 4000 });
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: vals.site, ageBand: vals.ageBand, actor: vals.actor } });
});

/** 模拟两个协调员同时提交同一分层名额：只应放行一条 */
const concurrent = async () => {
  const base = { ...values } as RandomizeInput;
  const stamp = Date.now().toString().slice(-4);
  const results = await Promise.all([
    trial.randomize({ ...base, participantNo: `${base.participantNo || 'S01-000'}-甲${stamp}`, identityKey: `id-甲${stamp}` }),
    trial.randomize({ ...base, participantNo: `${base.participantNo || 'S01-000'}-乙${stamp}`, identityKey: `id-乙${stamp}` })
  ]);
  const okCount = results.filter((r) => r.ok).length;
  results.forEach((r) => ElMessage({ type: r.ok ? 'success' : 'warning', message: r.message, duration: 4000 }));
  if (okCount !== 1) ElMessage.error(`预期只放行一条，实际放行 ${okCount} 条`);
};

const merge = async (id: string) => {
  const result = await trial.mergePaperCard(id, actor.value as string);
  ElMessage({ type: result.ok ? 'success' : 'warning', message: result.message, duration: 4000 });
};

const adjudicate = (id: string, arm: Arm) => {
  trial.adjudicatePaperCard(id, arm, actor.value as string);
  ElMessage.success(`已裁决采用组别 ${arm}`);
};

const changePlanSeed = async () => {
  try {
    const { value } = await ElMessageBox.prompt('输入新的随机种子（换版只对之后入组生效）', '换版分配方案', {
      inputValue: String(activePlan.value.seed + 1),
      inputPattern: /^\d+$/,
      inputErrorMessage: '种子必须为数字',
      confirmButtonText: '启用新方案'
    });
    trial.createPlan(Number(value), activePlan.value.blockLengths, `种子由 ${activePlan.value.seed} 换为 ${value}`, actor.value as string);
    ElMessage.success('新方案已启用，之前号码仍按原方案核验');
  } catch {}
};

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认并审计'
    });
    trial.emergencyUnblind(id, value, actor.value as string);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  paper: trial.pendingPaperCount,
  disputed: trial.disputedCount
}));

const reconcileType = computed(() => {
  if (!lastReconcile.value) return 'info';
  return lastReconcile.value.ok ? 'success' : 'error';
});
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待并入纸卡</span><b>{{ counts.paper }}</b></div>
      <div class="stat"><span>冲突待裁决</span><b>{{ counts.disputed }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线（备用纸卡）" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">{{ offline ? '用备用纸卡发出' : '执行分层区组随机' }}</el-button>
          <el-button style="width:100%;margin-top:8px" @click="concurrent">模拟两个协调员同时提交同一分层</el-button>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><b>分配方案（可回放）</b></template>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="方案版本">
            v{{ activePlan.version }}
            <el-tag size="small" type="success" style="margin-left:6px">生效中</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="随机种子">{{ activePlan.seed }}</el-descriptions-item>
          <el-descriptions-item label="区组长度">{{ activePlan.blockLengths.join(' / ') }}</el-descriptions-item>
          <el-descriptions-item label="分层因素">{{ activePlan.strataFactors.join(' × ') }}</el-descriptions-item>
          <el-descriptions-item label="生效随机号">{{ activePlan.effectiveFrom }} 起</el-descriptions-item>
          <el-descriptions-item v-if="activePlan.note" label="备注">{{ activePlan.note }}</el-descriptions-item>
        </el-descriptions>
        <el-button size="small" style="margin-top:12px" @click="changePlanSeed">换版种子（只对之后入组生效）</el-button>
        <div style="margin-top:8px;color:#909399;font-size:12px">已停用方案 {{ plans.filter((p) => p.status === 'superseded').length }} 个，仅用于核验历史号码</div>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></template>
        <el-table :data="participants" max-height="420">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column prop="sequence" label="随机号" width="90" />
          <el-table-column label="方案" width="70"><template #default="{ row }">v{{ plans.find((p) => p.id === row.planId)?.version ?? '?' }}</template></el-table-column>
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="来源" width="80"><template #default="{ row }"><el-tag v-if="row.viaPaper" size="small" type="warning">纸卡</el-tag><span v-else>系统</span></template></el-table-column>
          <el-table-column label="操作" width="100"><template #default="{ row }"><el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button></template></el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never">
        <template #header><b>备用纸卡记录</b></template>
        <el-empty v-if="paperCards.length === 0" description="暂无纸卡记录（离线时发出）" />
        <el-table v-else :data="paperCards" max-height="420">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="stratumKey" label="分层" min-width="130" />
          <el-table-column label="纸卡组别" width="90"><template #default="{ row }"><el-tag type="info">{{ row.paperArm }}</el-tag></template></el-table-column>
          <el-table-column label="重建组别" width="90">
            <template #default="{ row }">
              <el-tag v-if="row.status === 'disputed'" type="danger">{{ row.rebuiltArm }}</el-tag>
              <span v-else-if="row.status === 'adjudicated'">裁决 {{ row.adjudicatedArm }}</span>
              <span v-else>—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag v-if="row.status === 'pending'" type="warning">待并入</el-tag>
              <el-tag v-else-if="row.status === 'merged'" type="success">已并入</el-tag>
              <el-tag v-else-if="row.status === 'disputed'" type="danger">冲突待裁决</el-tag>
              <el-tag v-else type="success">已裁决</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="180">
            <template #default="{ row }">
              <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="merge(row.id)">并入台账</el-button>
              <template v-else-if="row.status === 'disputed' && role === 'monitor'">
                <el-button size="small" type="success" @click="adjudicate(row.id, 'A')">采用 A</el-button>
                <el-button size="small" type="warning" @click="adjudicate(row.id, 'B')">采用 B</el-button>
              </template>
              <span v-else style="color:#909399;font-size:12px">—</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>飞行检查对账</b></template>
        <el-button type="primary" @click="trial.reconcile()">按方案重建序列并逐例核对</el-button>
        <el-alert
          v-if="lastReconcile"
          :type="reconcileType"
          :title="lastReconcile.message"
          :closable="false"
          style="margin-top:12px"
        >
          <div v-if="lastReconcile.firstMismatch" style="font-size:13px;line-height:1.8">
            <div>首个不一致位置：随机号 <b>{{ lastReconcile.firstMismatch.sequence }}</b>（{{ lastReconcile.firstMismatch.participantNo }}）</div>
            <div>方案 v{{ lastReconcile.firstMismatch.planVersion }} 重建组别：<b>{{ lastReconcile.firstMismatch.expectedArm }}</b>，台账记录：<b>{{ lastReconcile.firstMismatch.actualArm }}</b></div>
            <div style="color:#909399">已核对 {{ lastReconcile.checked }} 例</div>
          </div>
        </el-alert>
        <div style="margin-top:8px;color:#909399;font-size:12px">对账只读原台账，失败可重试，原台账与未完成批次保留</div>
      </el-card>

      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="entry.action === 'unblinded' ? 'danger' : entry.action === 'duplicate-blocked' || entry.action === 'conflict-blocked' || entry.action === 'reconcile-failed' || entry.action === 'paper-disputed' ? 'warning' : 'primary'">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: repeat(2, 1fr) !important; } }
</style>
