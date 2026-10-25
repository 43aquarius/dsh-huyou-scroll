/**
 * fish-tone 融合层 —— 「双向鱼群拓扑 · 人味掰话」移植自 dsh-fish-tone（MIT）
 *
 * 出处：
 *   - https://github.com/MX3a48c5/dsh-fish-tone （MIT，许可全文见 ./LICENSE.fish-tone）
 *   - 方法来自 B 站 BV1BNnc6nEUa；语料密度实测自 10 万条 B 站公开评论
 *
 * 我们只用它的两个半侧里「确定性掰话」的那半（applyTone）+ 附属包的梗库：
 *   · applyTone(text, { strength, seed }) —— 犹豫半秒 / 句尾挂没用的小尾巴 / 微标记 /
 *     结构腔按真人密度压。不重写，只往人的方向掰一点点。
 *   · 梗库（memes + constructions）—— 鲸鱼娘发狐友评论时的接梗素材。
 *
 * 接入点：狐友评论文案 / 图帖文案（先不过日记 —— 日记是写给主人看的，保留原味）。
 * 宿主装配部分（apply(root)、config.json、DSH 工具注册）没有移植 —— 本项目不是 DSH 宿主，
 * 配置走自己的 HuyouConfig.fishTone 档位。
 */
import { applyTone } from './tone.js'
import memesRaw from './data/memes.json'
import constructionsRaw from './data/constructions.json'

export type FishStrength = 'off' | 'light' | 'normal' | 'max'

export { applyTone }

export interface ToneResult {
  text: string
  stats: Record<string, unknown>
}

/** 字符串 → 稳定数字种子（同一帖子/同一文案重试结果一致） */
export function seedOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 2147483647
}

/**
 * 人味化一段文案（狐友评论/图帖正文用）。
 * off = 原样返回；其余档 = applyTone 掰一遍（light 一点点 / normal 明显 / max 过头）。
 */
export function humanize(
  text: string,
  opts: { strength?: FishStrength; seed?: number } = {},
): ToneResult {
  const strength = opts.strength ?? 'light'
  if (strength === 'off' || !text?.trim()) return { text, stats: {} }
  const r = applyTone(text, {
    strength,
    seed: Number.isFinite(opts.seed) ? (opts.seed as number) : seedOf(text),
    protect: true,
  })
  return { text: r.text, stats: (r.stats ?? {}) as Record<string, unknown> }
}

// ───────────────────────── 梗库（flavor 附属包数据） ─────────────────────────

export interface FishMeme {
  term: string
  gloss: string
  year?: number | string
  vibes?: string[]
  known?: boolean
  tail?: boolean
}

export interface FishConstruction {
  id: string
  name: string
  template: string
  effect: string
  example?: string
  vibes?: string[]
}

const MEMES: FishMeme[] = (() => {
  const raw = memesRaw as { memes?: Record<string, unknown>[] }
  return (raw.memes ?? []).map((m) => ({
    term: String(m.term ?? m.meme ?? ''),
    gloss: String(m.gloss ?? m.meaning ?? ''),
    year: (m.year as number | string) ?? undefined,
    vibes: Array.isArray(m.vibes) ? (m.vibes as string[]) : [],
    known: m.known !== false,
    tail: Boolean(m.tail),
  })).filter((m) => m.term)
})()

const CONSTRUCTIONS: FishConstruction[] = (() => {
  const raw = constructionsRaw as unknown as FishConstruction[]
  return Array.isArray(raw) ? raw.filter((c) => c && c.template) : []
})()

export function memeCount(): { memes: number; constructions: number } {
  return { memes: MEMES.length, constructions: CONSTRUCTIONS.length }
}

/** 抽 n 条梗当接话素材（seedable，同一轮一致） */
export function pickMemes(n: number, seed = Date.now() % 2147483647): FishMeme[] {
  const pool = MEMES.filter((m) => m.known)
  const out: FishMeme[] = []
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483647
    return s / 2147483647
  }
  const used = new Set<string>()
  while (out.length < Math.min(n, pool.length)) {
    const m = pool[Math.floor(rand() * pool.length)]
    if (used.has(m.term)) continue
    used.add(m.term)
    out.push(m)
  }
  return out
}

/** 抽 n 个句式（同上） */
export function pickConstructions(n: number, seed = Date.now() % 2147483647): FishConstruction[] {
  const out: FishConstruction[] = []
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483647
    return s / 2147483647
  }
  const used = new Set<string>()
  while (out.length < Math.min(n, CONSTRUCTIONS.length)) {
    const c = CONSTRUCTIONS[Math.floor(rand() * CONSTRUCTIONS.length)]
    if (used.has(c.id)) continue
    used.add(c.id)
    out.push(c)
  }
  return out
}
