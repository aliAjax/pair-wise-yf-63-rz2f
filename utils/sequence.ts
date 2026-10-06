import type { AllocationPlan, Arm } from '~/types/trial';

/**
 * 可回放的分层区组随机序列生成器。
 * 同一份输入（种子 + 区组长度 + 分层键）必然得到同一段组别序列，
 * 是飞行检查重建序列、逐例对账的依据。
 */

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 确定性伪随机数发生器 */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stratumKeyOf(site: string, ageBand: string): string {
  return `${site}|${ageBand}`;
}

/**
 * 按方案重建某分层的区组随机序列。
 * 纯函数：输入相同则输出相同，用于回放对账。
 */
export function generateBlockArms(plan: AllocationPlan, stratumKey: string, count: number): Arm[] {
  const stratumSeed = (plan.seed ^ hashStr(stratumKey)) >>> 0;
  const rng = mulberry32(stratumSeed);
  const arms: Arm[] = [];
  while (arms.length < count) {
    const blockLen = plan.blockLengths[Math.floor(rng() * plan.blockLengths.length)];
    const block: Arm[] = [];
    for (let i = 0; i < blockLen / 2; i++) block.push('A');
    for (let i = 0; i < blockLen / 2; i++) block.push('B');
    // Fisher-Yates 洗牌，随机性来自同一条确定的 RNG 流
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [block[i], block[j]] = [block[j], block[i]];
    }
    arms.push(...block);
  }
  return arms.slice(0, count);
}
