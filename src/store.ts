/**
 * dsh-huyou 数据层 —— 数据目录（默认 ./data/huyou，可 env DSH_HUYOU_DATA_DIR 覆盖）
 *   config.json   设置（cookie / 人格 / 圈子 / 评论闸 / 图帖 / 生物钟 / 人味档）
 *   seen.json     判重表（刷过的 feedId，防重复评论）
 *   quota.json    发言账（审计 + 防重复素材）
 *   events.jsonl  事件流
 *   huyou.log     运行日志
 *
 * 零依赖（node:fs / node:path），敏感的 cookie 只落本机，不进 git。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FishStrength } from './fishtone/index.js'

export interface HuyouCircle {
  id: string
  name: string
}

export interface WakeWindow {
  start: string
  end: string
  wakes: number
}

export interface HuyouConfig {
  enabled: boolean
  cookie: string
  windows: WakeWindow[]
  minGapMin: number
  skipChance: number
  maxFeeds: number
  deepRead: number
  /** 人设正文（人格提示词 —— 插件不绑定具体人格，随便写） */
  persona: string
  likes: string
  dislikes: string
  /** 只刷这些圈子（空 = 全站推荐流） */
  circles: HuyouCircle[]
  circleListType: 1 | 2
  commentEnabled: boolean
  commentMinScore: number
  commentDaily: number
  commentCooldownDays: number
  imagePostEnabled: boolean
  imagePostDaily: number
  statementCode: number
  fishTone: FishStrength
  diaryEnabled: boolean
}

export const DEFAULT_CONFIG: HuyouConfig = {
  enabled: false,
  cookie: '',
  windows: [{ start: '00:00', end: '23:59', wakes: 12 }],
  minGapMin: 60,
  skipChance: 0.1,
  maxFeeds: 8,
  deepRead: 2,
  persona: '',
  likes: '',
  dislikes: '',
  circles: [],
  circleListType: 2,
  commentEnabled: true,
  commentMinScore: 13,
  commentDaily: 6,
  commentCooldownDays: 3,
  imagePostEnabled: true,
  imagePostDaily: 2,
  statementCode: 1,
  fishTone: 'light',
  diaryEnabled: true,
}

export function dataDir(): string {
  const override = process.env.DSH_HUYOU_DATA_DIR
  if (override && override.trim()) return override.trim()
  return path.join(process.cwd(), 'data', 'huyou')
}

export const huyouLog = (msg: string) => {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.appendFileSync(path.join(dataDir(), 'huyou.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf-8')
  } catch {
    /* 不致命 */
  }
}

const configFile = () => path.join(dataDir(), 'config.json')

function readJson<T>(file: string, fallback: T): T {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (typeof data !== 'object' || data === null) return fallback
    return { ...fallback, ...data } as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

export function loadHuyouConfig(): HuyouConfig {
  const cfg = readJson<HuyouConfig>(configFile(), DEFAULT_CONFIG)
  cfg.skipChance = Math.max(0, Math.min(1, Number(cfg.skipChance) || 0.1))
  cfg.commentMinScore = Math.max(0, Math.min(20, Math.floor(cfg.commentMinScore)))
  cfg.commentDaily = Math.max(0, Math.min(10, Math.floor(cfg.commentDaily)))
  cfg.commentCooldownDays = Math.max(0, Math.min(30, Math.floor(cfg.commentCooldownDays)))
  cfg.maxFeeds = Math.max(1, Math.min(15, Math.floor(cfg.maxFeeds)))
  cfg.deepRead = Math.max(1, Math.min(5, Math.floor(cfg.deepRead)))
  cfg.minGapMin = Math.max(5, Math.min(240, Math.floor(cfg.minGapMin)))
  cfg.circles = (Array.isArray(cfg.circles) ? cfg.circles : [])
    .filter((c) => c && typeof c.id === 'string' && c.id.trim())
    .slice(0, 4)
    .map((c) => ({ id: c.id.trim(), name: String(c.name ?? '').trim() || c.id }))
  cfg.circleListType = cfg.circleListType === 1 ? 1 : 2
  cfg.imagePostDaily = Math.max(0, Math.min(6, Math.floor(Number(cfg.imagePostDaily) || 0)))
  cfg.statementCode = [1, 2, 4, 5, 6, 7].includes(Number(cfg.statementCode)) ? Number(cfg.statementCode) : 1
  cfg.fishTone = (['off', 'light', 'normal', 'max'] as const).includes(cfg.fishTone) ? cfg.fishTone : 'light'
  if (typeof cfg.imagePostEnabled !== 'boolean') cfg.imagePostEnabled = DEFAULT_CONFIG.imagePostEnabled
  if (typeof cfg.commentEnabled !== 'boolean') cfg.commentEnabled = DEFAULT_CONFIG.commentEnabled
  if (!Array.isArray(cfg.windows) || !cfg.windows.length) cfg.windows = DEFAULT_CONFIG.windows
  return cfg
}

export function saveHuyouConfig(patch: Partial<HuyouConfig>): HuyouConfig {
  const next = { ...loadHuyouConfig(), ...patch }
  writeJson(configFile(), next)
  return next
}

// ───────────────────────── 判重表 ─────────────────────────

const seenFile = () => path.join(dataDir(), 'seen.json')

export function huyouSeen(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenFile(), 'utf-8')) as string[])
  } catch {
    return new Set()
  }
}

export function appendHuyouSeen(feedIds: string[]) {
  if (!feedIds.length) return
  const cur = [...huyouSeen(), ...feedIds]
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(seenFile(), JSON.stringify([...new Set(cur)].slice(-2000), null, 2))
}

// ───────────────────────── 发言账 ─────────────────────────

export interface HuyouQuotaEntry {
  at: string
  type: 'comment' | 'feed' | 'image'
  target: string
  note?: string
  auto: boolean
  commentId?: string
  feedId?: string
}

const quotaFile = () => path.join(dataDir(), 'quota.json')

const dayKeyLocal = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)

export function loadHuyouQuota(): { log: HuyouQuotaEntry[] } {
  return readJson<{ log: HuyouQuotaEntry[] }>(quotaFile(), { log: [] })
}

export function recordHuyouQuota(entry: HuyouQuotaEntry) {
  const q = loadHuyouQuota()
  q.log.push(entry)
  const cutoff = Date.now() - 60 * 86_400_000
  q.log = q.log.filter((x) => Date.parse(x.at) > cutoff)
  writeJson(quotaFile(), q)
}

export function commentGate(cfg: HuyouConfig, feedId: string): { ok: boolean; reason?: string } {
  const q = loadHuyouQuota()
  const today = q.log.filter((x) => x.type === 'comment' && dayKeyLocal(new Date(x.at)) === dayKeyLocal())
  if (today.length >= cfg.commentDaily)
    return { ok: false, reason: `今天已评论 ${today.length} 条（上限 ${cfg.commentDaily}）` }
  const cooldownMs = cfg.commentCooldownDays * 86_400_000
  const dup = q.log.find(
    (x) => x.type === 'comment' && x.feedId === feedId && Date.now() - Date.parse(x.at) < cooldownMs,
  )
  if (dup)
    return { ok: false, reason: `同一帖子 ${cfg.commentCooldownDays} 天内只评一次（上次 ${String(dup.at).slice(0, 10)}）` }
  return { ok: true }
}

export function imagePostGate(cfg: HuyouConfig): { ok: boolean; reason?: string } {
  const q = loadHuyouQuota()
  const today = q.log.filter((x) => x.type === 'image' && dayKeyLocal(new Date(x.at)) === dayKeyLocal())
  if (today.length >= cfg.imagePostDaily)
    return { ok: false, reason: `今天已发 ${today.length} 张图帖（上限 ${cfg.imagePostDaily}）` }
  return { ok: true }
}

// ───────────────────────── 事件流 / 日记 ─────────────────────────

export interface HuyouEvent {
  at: string
  kind: 'scroll' | 'skip' | 'light' | 'deep' | 'comment' | 'feed' | 'diary' | 'error'
  target?: string
  note?: string
}

export function pushHuyouEvent(ev: HuyouEvent) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.appendFileSync(path.join(dataDir(), 'events.jsonl'), JSON.stringify(ev) + '\n', 'utf-8')
  } catch {
    /* 不致命 */
  }
}

export function recentHuyouEvents(n = 30): HuyouEvent[] {
  try {
    const lines = fs.readFileSync(path.join(dataDir(), 'events.jsonl'), 'utf-8').trim().split('\n').filter(Boolean)
    return lines.slice(-n).map((l) => JSON.parse(l) as HuyouEvent)
  } catch {
    return []
  }
}

export function appendHuyouDiary(md: string) {
  const file = path.join(dataDir(), 'diary.md')
  fs.mkdirSync(dataDir(), { recursive: true })
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  fs.writeFileSync(file, prev + (prev.endsWith('\n') || !prev ? '' : '\n') + md + '\n', 'utf-8')
}

export function readHuyouDiary(): string {
  try {
    return fs.readFileSync(path.join(dataDir(), 'diary.md'), 'utf-8')
  } catch {
    return ''
  }
}
