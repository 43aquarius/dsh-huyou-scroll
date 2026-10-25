/**
 * dsh-huyou-scroll 数据层 —— 数据目录（默认 ./data/huyou，可 env DSH_HUYOU_DATA_DIR 覆盖）
 *   config.json   设置（cookie / 人格 / 圈子 / 评论闸 / 发帖 / 生物钟 / 人味档）
 *   seen.json     判重表（刷过的 feedId，防重复评论）
 *   threads.json  回信账（她评过的每条帖子 + 已处理过的回复 —— 「一帖一评，有人回才接着说」的依据）
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
  /** 每轮最多发几条新评论（每天没有硬性上限 —— 真正的闸是「一帖一评」+ 写预算风控） */
  commentPerRound: number
  /** 每轮最多回几条回信（有人回复她的评论才接着说） */
  replyPerRound: number
  /** 发帖总开关（开启后她偶尔自己发帖；默认纯文字帖，图需验图文相符） */
  imagePostEnabled: boolean
  /** 每日发帖上限（文字帖+图帖共用） */
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
  commentPerRound: 2,
  replyPerRound: 2,
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
  cfg.commentPerRound = Math.max(1, Math.min(5, Math.floor(Number(cfg.commentPerRound) || 2)))
  cfg.replyPerRound = Math.max(0, Math.min(5, Math.floor(Number(cfg.replyPerRound) || 2)))
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
  type: 'comment' | 'reply' | 'feed' | 'image'
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

/** 评论闸：一帖一评（主人规矩 —— 有人回复了她的评论才会接着说，见 threads） */
export function commentGate(_cfg: HuyouConfig, feedId: string): { ok: boolean; reason?: string } {
  void _cfg
  const { threads } = loadHuyouThreads()
  if (threads.some((t) => t.feedId === feedId))
    return { ok: false, reason: '这条帖子已经说过了（一帖一评；有人回她才会接着说）' }
  const q = loadHuyouQuota()
  const legacy = q.log.find((x) => (x.type === 'comment' || x.type === 'reply') && x.feedId === feedId)
  if (legacy)
    return { ok: false, reason: `旧账里也记着评过（${String(legacy.at).slice(0, 10)}）—— 不翻旧帖` }
  return { ok: true }
}

// ───────────────────── 回信账（threads） ─────────────────────

/** 她在某条帖子下的「对话线程」：评过什么 + 处理过哪些回复 */
export interface HuyouThread {
  feedId: string
  /** 她那条评论的 commentId（replylist 挂在这上面） */
  commentId: string
  /** 她当时说的话（回信时要记住自己说过什么） */
  content: string
  /** 帖子正文快照（回信时的上下文） */
  feedContent: string
  /** 帖子作者（快照） */
  feedAuthor: string
  at: string
  /** 已处理过的回复 commentId（回过 / 看过决定不回的都算） */
  handledReplyIds: string[]
  /** 最近一次看到的回复总数 */
  seenReplyCount: number
  /** 她在这条线程里追回过几句 */
  repliesByMe: number
  lastCheckedAt?: string
}

const THREAD_TTL_MS = 30 * 86_400_000
const threadsFile = () => path.join(dataDir(), 'threads.json')

export function loadHuyouThreads(): { threads: HuyouThread[] } {
  const d = readJson<{ threads: HuyouThread[] }>(threadsFile(), { threads: [] })
  const list = (Array.isArray(d.threads) ? d.threads : [])
    .filter((t) => t && typeof t.feedId === 'string' && typeof t.commentId === 'string')
    .map((t) => ({
      feedId: String(t.feedId),
      commentId: String(t.commentId),
      content: String(t.content ?? ''),
      feedContent: String(t.feedContent ?? ''),
      feedAuthor: String(t.feedAuthor ?? ''),
      at: String(t.at ?? new Date().toISOString()),
      handledReplyIds: Array.isArray(t.handledReplyIds) ? t.handledReplyIds.map(String) : [],
      seenReplyCount: Math.max(0, Number(t.seenReplyCount) || 0),
      repliesByMe: Math.max(0, Number(t.repliesByMe) || 0),
      lastCheckedAt: t.lastCheckedAt ? String(t.lastCheckedAt) : undefined,
    }))
  // 30 天的老线程退休（帖子早沉了，不会再有人回）
  return { threads: list.filter((t) => Date.now() - Date.parse(t.at) < THREAD_TTL_MS) }
}

export function upsertHuyouThread(t: HuyouThread) {
  const { threads } = loadHuyouThreads()
  const i = threads.findIndex((x) => x.feedId === t.feedId)
  if (i >= 0) threads[i] = t
  else threads.push(t)
  writeJson(threadsFile(), { threads })
}

export function findHuyouThread(feedId: string): HuyouThread | undefined {
  return loadHuyouThreads().threads.find((t) => t.feedId === feedId)
}

/** 发帖闸（文字帖+图帖都算，按天限额）：主人规矩「没配图必要就不配图」→ 图是例外路径 */
export function imagePostGate(cfg: HuyouConfig): { ok: boolean; reason?: string } {
  const q = loadHuyouQuota()
  const today = q.log.filter(
    (x) => (x.type === 'image' || x.type === 'feed') && dayKeyLocal(new Date(x.at)) === dayKeyLocal(),
  )
  if (today.length >= cfg.imagePostDaily)
    return { ok: false, reason: `今天已发 ${today.length} 帖（上限 ${cfg.imagePostDaily}）` }
  return { ok: true }
}

// ───────────────────────── 事件流 / 日记 ─────────────────────────

export interface HuyouEvent {
  at: string
  kind: 'scroll' | 'skip' | 'light' | 'deep' | 'comment' | 'reply' | 'feed' | 'diary' | 'error'
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
