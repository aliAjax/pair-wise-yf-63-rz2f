import type { AllocationScheme, Arm, Stratum } from '~/types/trial';

/**
 * 可回放的确定性随机引擎。
 * 使用 FNV-1a 将 (方案种子, 分层键, 位置) 派生为固定散列，
 * 再以 mulberry32 生成 [0,1) 伪随机数。同一份方案 + 同一分层 + 同一位置，
 * 任何时间、任何机器重跑结果完全一致，这是飞行检查对账的依据。
 */

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed32: number): () => number {
  let a = seed32 >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stratumKeyOf(stratum: Stratum): string {
  return `${stratum.site}|${stratum.ageBand}`;
}

/** 某分层在某个位置（1 起）的确定性随机数 */
export function unitRandom(scheme: AllocationScheme, key: string, position: number): number {
  const derivedSeed = fnv1a(`${scheme.seed}⟦${scheme.revision}⟧§${key}#${position}`);
  return mulberry32(derivedSeed)();
}

/**
 * 按方案重建某分层前 count 个位置的整段分配序列。
 * 每个区组内做确定性洗牌，保证区组内 A/B 数量相等。
 */
export function buildSequence(scheme: AllocationScheme, key: string, count: number): Arm[] {
  const sequence: Arm[] = [];
  const block = scheme.blockSize;
  for (let start = 0; start < count; start += block) {
    const slots: Arm[] = [];
    for (let k = 0; k < block; k += 1) slots.push(k < block / 2 ? 'A' : 'B');
    // Fisher–Yates，随机源在 (方案, 分层, 区内偏移) 上确定
    for (let k = block - 1; k > 0; k -= 1) {
      const j = Math.floor(unitRandom(scheme, key, start + k + 1) * (k + 1));
      [slots[k], slots[j]] = [slots[j], slots[k]];
    }
    sequence.push(...slots.slice(0, Math.min(block, count - start)));
  }
  return sequence;
}

export function armAt(scheme: AllocationScheme, key: string, position: number): Arm {
  return buildSequence(scheme, key, position)[position - 1];
}

/** 中央随机号：层内位置编码，全球唯一且可从序列重建 */
export function formatRandomNo(key: string, position: number): string {
  const h = fnv1a(key).toString(36).toUpperCase().padStart(4, '0').slice(-4);
  return `R-${h}-${position.toString().padStart(4, '0')}`;
}

/** 生成一个分层从 fromPosition 起连续 count 张备用纸卡（纸卡在印制时即按方案预生成） */
export function buildPaperCards(scheme: AllocationScheme, stratum: Stratum, fromPosition: number, count: number) {
  const key = stratumKeyOf(stratum);
  const arms = buildSequence(scheme, key, fromPosition + count - 1).slice(fromPosition - 1, fromPosition - 1 + count);
  return arms.map((arm, index) => {
    const position = fromPosition + index;
    return {
      cardNo: `C-${fnv1a(key).toString(36).toUpperCase().slice(-4)}-${position.toString().padStart(4, '0')}`,
      stratumKey: key,
      site: stratum.site,
      ageBand: stratum.ageBand,
      position,
      randomNo: formatRandomNo(key, position),
      arm,
      schemeRevision: scheme.revision,
      used: false
    };
  });
}
