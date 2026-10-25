/**
 * dsh-huyou-scroll 生物钟 —— 24 小时自主调度器（单文件实现，零依赖）。
 *
 * 每 60 秒 tick：没计划 → 在窗口内排一个随机时刻（skipChance 掷「今天不想刷」）；
 * 到点 → runScroll 一轮。单例挂 globalThis（热重载不叠定时器）。
 *
 * 窗口例：[{ start: '00:00', end: '23:59', wakes: 12 }] ≈ 每 2 小时醒一鼻子。
 */
import { loadHuyouConfig, huyouLog } from './store.js'
import { runScroll, type HuyouEngineDeps, type ScrollResult } from './engine.js'

const TICK_MS = 60_000

interface PlanState {
  date: string
  action: 'wake' | 'skip' | 'done'
  atMs?: number
  atText?: string
  window?: string
  withinWindow?: string
  fired?: boolean
  woke?: boolean
  wokeAt?: string
  wakes: number
}

const dayOf = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

function hhmm2min(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return -1
  return Number(m[1]) * 60 + Number(m[2])
}

const g = globalThis as unknown as {
  __huyouScheduler?: { timer?: NodeJS.Timeout; busy: boolean; lastResult?: string; deps?: HuyouEngineDeps }
}

function ensureScheduler() {
  if (!g.__huyouScheduler) g.__huyouScheduler = { busy: false }
  return g.__huyouScheduler
}

/** 今天还剩几次机会 + 还在不在窗口里 */
function planNext(cfg: ReturnType<typeof loadHuyouConfig>, state: PlanState | null): PlanState {
  const today = dayOf()
  if (state && state.date !== today) state = null
  const wakes = state?.wakes ?? 0

  const now = new Date(Date.now() + 8 * 3600_000)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const left = cfg.windows
    .map((w) => ({ w, s: hhmm2min(w.start), e: hhmm2min(w.end) }))
    .filter(({ s, e }) => s >= 0 && e >= 0 && nowMin < e)
    .sort((a, b) => a.s - b.s)

  if (!left.length) return { date: today, action: 'done', wakes, woke: true, wokeAt: new Date().toISOString() }
  const win = left[0]
  const from = Math.max(nowMin + 2, win.s)
  const at = from + Math.floor(Math.random() * Math.max(1, win.e - from))
  const atMs = Date.now() + (at - nowMin) * 60_000 + Math.floor(Math.random() * 60_000)
  const skip = Math.random() < cfg.skipChance
  return {
    date: today,
    action: skip ? 'skip' : 'wake',
    atMs,
    atText: `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`,
    window: `${win.w.start}-${win.w.end}`,
    wakes: wakes + 1,
  }
}

function completePlan(state: PlanState | null): PlanState {
  if (!state) return { date: dayOf(), action: 'done', wakes: 0 }
  return { ...state, fired: true, woke: true, wokeAt: new Date().toISOString() }
}

function loadPlan(): PlanState | null {
  try {
    return JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.DSH_HUYOU_DATA_DIR || 'data/huyou', 'plan.json'), 'utf-8'))
  } catch {
    return null
  }
}

function savePlan(state: PlanState) {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const dir = process.env.DSH_HUYOU_DATA_DIR || 'data/huyou'
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(state, null, 2))
  } catch {
    /* 不致命 */
  }
}

function isPending(state: PlanState | null, now: Date): boolean {
  if (!state) return false
  if (state.date !== dayOf()) return false
  if (state.action === 'done') {
    // 窗口还有剩余时段且今天轮数没用完 → 继续排
    return false
  }
  return true
}

async function tick() {
  const s = ensureScheduler()
  const cfg = loadHuyouConfig()
  if (!cfg.enabled || !cfg.cookie) return
  if (!s.deps) return
  if (s.busy) return

  let state = loadPlan()
  if (!isPending(state, new Date()) || state?.fired) {
    const next = planNext(cfg, state)
    savePlan(next)
    state = next
    if (next.action === 'done') return
    huyouLog(`[huyou] 排了下一次：${next.atText}（${next.window}）`)
  }

  const now = Date.now()
  if (!state) return
  if (!(state.action === 'wake' || state.action === 'skip')) return
  if (!state.atMs || state.atMs > now || state.fired) return

  s.busy = true
  try {
    const kind = state.action === 'skip' ? 'skip' : 'scroll'
    huyouLog(`[huyou] ⏰ 游过去（${state.atText ?? '?'}）`)
    const result: ScrollResult = await runScroll(s.deps, kind)
    s.lastResult = result.summary
    huyouLog(`[huyou] ✅ 一轮结束：${result.summary}`)
  } catch (e: any) {
    huyouLog(`[huyou] ❌ 一轮失败：${e?.message ?? e}`)
  } finally {
    savePlan(completePlan(loadPlan()))
    s.busy = false
  }
}

/** 启动生物钟（deps 里 chat 必需；generateImage 可选） */
export function startHuyouScheduler(deps: HuyouEngineDeps) {
  const s = ensureScheduler()
  s.deps = deps
  if (s.timer) return s.timer
  const timer = setInterval(() => {
    tick().catch(() => {})
  }, TICK_MS)
  timer.unref?.()
  s.timer = timer
  huyouLog('[huyou] 生物钟已启动（每 60 秒 tick）')
  return timer
}

export function stopHuyouScheduler() {
  const s = ensureScheduler()
  if (s.timer) {
    clearInterval(s.timer)
    s.timer = undefined
    huyouLog('[huyou] 生物钟已停')
  }
}

export function huyouSchedulerStatus() {
  const s = ensureScheduler()
  const cfg = loadHuyouConfig()
  const state = loadPlan()
  return {
    enabled: cfg.enabled,
    running: !!s.timer,
    busy: s.busy,
    lastResult: s.lastResult ?? null,
    plan:
      state && (state.action === 'wake' || state.action === 'skip') && !state.fired
        ? { action: state.action, atText: state.atText ?? null, atMs: state.atMs ?? null, window: state.window ?? null }
        : null,
    todayScrolls: state?.date === dayOf() ? state.wakes : 0,
  }
}
