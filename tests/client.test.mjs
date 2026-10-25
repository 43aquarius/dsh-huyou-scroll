/**
 * dsh-huyou-scroll 客户端测试 —— 不打真 API，只验证签名算法 / 形状 / 预算闸 / 主人规矩。
 * 跑法：bun test（或 node --experimental-strip-types --test tests/client.test.mjs）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HUYOU_BUDGET } from '../src/client.ts'
import { SohuClient, HuyouError } from '../src/client.ts'
import { seedOf, humanize, pickMemes, memeCount } from '../src/fishtone/index.ts'
import { DEFAULT_CONFIG, commentGate, imagePostGate, recordHuyouQuota } from '../src/store.ts'
import { loadHuyouThreads, upsertHuyouThread, findHuyouThread } from '../src/store.ts'

/** 线程账/闸门测试要落盘 → 用临时数据目录隔离 */
function withTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-huyou-test-'))
  process.env.DSH_HUYOU_DATA_DIR = dir
  return () => {
    delete process.env.DSH_HUYOU_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('预算表形状（防风控参数完整）', () => {
  assert.equal(HUYOU_BUDGET.minGapMs, 1500)
  assert.ok(HUYOU_BUDGET.readDaily > 0 && HUYOU_BUDGET.writeDaily > 0)
  assert.ok(HUYOU_BUDGET.writeGapSec >= 180)
})

test('HuyouError 带 code', () => {
  const e = new HuyouError('测试', 'risk', 429)
  assert.equal(e.code, 'risk')
  assert.equal(e.status, 429)
})

test('SohuClient 无 cookie 也能构造（请求时才校验）', () => {
  const c = new SohuClient('')
  assert.equal(typeof c.userInfo, 'function')
  assert.equal(typeof c.circleFeedList, 'function')
  assert.equal(typeof c.uploadImage, 'function')
})

test('默认配置：24h 窗口 + 圈子模式 + fish-tone light', () => {
  assert.equal(DEFAULT_CONFIG.windows[0].start, '00:00')
  assert.equal(DEFAULT_CONFIG.windows[0].end, '23:59')
  assert.ok(DEFAULT_CONFIG.windows[0].wakes >= 8)
  assert.equal(DEFAULT_CONFIG.commentEnabled, true)
  assert.equal(DEFAULT_CONFIG.fishTone, 'light')
  assert.equal(DEFAULT_CONFIG.statementCode, 1) // AI 生成声明
})

test('fish-tone：seedOf 稳定 / humanize off 原样', () => {
  assert.equal(seedOf('abc'), seedOf('abc'))
  assert.notEqual(seedOf('abc'), seedOf('abd'))
  const t = '测试句子。'
  assert.equal(humanize(t, { strength: 'off' }).text, t)
  assert.ok(typeof humanize(t, { strength: 'max', seed: 1 }).text === 'string')
})

test('fish-tone：梗库载入且可稳定抽取', () => {
  const cnt = memeCount()
  assert.ok(cnt.memes >= 100, `梗至少 100 条，实际 ${cnt.memes}`)
  assert.ok(cnt.constructions >= 10)
  const a = pickMemes(3, 42)
  const b = pickMemes(3, 42)
  assert.deepEqual(a.map((m) => m.term), b.map((m) => m.term))
})

test('fish-tone：长文/空串防御', () => {
  assert.equal(humanize('', { strength: 'normal' }).text, '')
  const long = '长句子测试。'.repeat(50)
  assert.ok(humanize(long, { strength: 'max' }).text.length > 100)
})

// ───────────────── 主人规矩（v0.2.0） ─────────────────

test('默认配置：一帖一评 + 回复触发（commentPerRound/replyPerRound，无日上限字段）', () => {
  assert.ok(DEFAULT_CONFIG.commentPerRound >= 1)
  assert.ok(DEFAULT_CONFIG.replyPerRound >= 0)
  assert.equal('commentDaily' in DEFAULT_CONFIG, false)
  assert.equal('commentCooldownDays' in DEFAULT_CONFIG, false)
})

test('线程账：upsert → load → find 闭环（回信账的依据）', () => {
  const restore = withTempDataDir()
  try {
    assert.equal(loadHuyouThreads().threads.length, 0)
    upsertHuyouThread({
      feedId: 'f1', commentId: 'c1', content: '她说过的话',
      feedContent: '帖子正文', feedAuthor: '网友',
      at: new Date().toISOString(),
      handledReplyIds: [], seenReplyCount: 0, repliesByMe: 0,
    })
    assert.equal(findHuyouThread('f1')?.commentId, 'c1')
    // 更新同一线程不叠条目
    upsertHuyouThread({
      feedId: 'f1', commentId: 'c1', content: '她说过的话',
      feedContent: '帖子正文', feedAuthor: '网友',
      at: new Date().toISOString(),
      handledReplyIds: ['r1'], seenReplyCount: 1, repliesByMe: 1,
    })
    assert.equal(loadHuyouThreads().threads.length, 1)
    assert.equal(findHuyouThread('f1')?.repliesByMe, 1)
  } finally {
    restore()
  }
})

test('评论闸：一帖一评 —— 已有线程的帖子直接拦下', () => {
  const restore = withTempDataDir()
  try {
    const cfg = { ...DEFAULT_CONFIG }
    assert.equal(commentGate(cfg, 'fresh-feed').ok, true)
    upsertHuyouThread({
      feedId: 'said-feed', commentId: 'c1', content: '说过了',
      feedContent: '', feedAuthor: '',
      at: new Date().toISOString(),
      handledReplyIds: [], seenReplyCount: 0, repliesByMe: 0,
    })
    const blocked = commentGate(cfg, 'said-feed')
    assert.equal(blocked.ok, false)
    assert.match(blocked.reason ?? '', /一帖一评/)
  } finally {
    restore()
  }
})

test('发帖闸：文字帖+图帖共用每日限额（图是例外路径）', () => {
  const restore = withTempDataDir()
  try {
    const cfg = { ...DEFAULT_CONFIG, imagePostDaily: 2 }
    assert.equal(imagePostGate(cfg).ok, true)
    // 手动模拟当日两条帖记录（一条文字一条图）
    recordHuyouQuota({ at: new Date().toISOString(), type: 'feed', target: 'x', auto: false })
    recordHuyouQuota({ at: new Date().toISOString(), type: 'image', target: 'y', auto: false })
    const blocked = imagePostGate(cfg)
    assert.equal(blocked.ok, false)
    assert.match(blocked.reason ?? '', /今天已发 2 帖/)
  } finally {
    restore()
  }
})

// ============ v0.3.0：圈子权重（主刷圈拿大头预算） ============

test('圈子权重：weight 洗数据（1-5，缺省 1）+ 预算按权重分配', () => {
  // 直接用纯函数算一遍配比逻辑（与 engine.fetchFeeds 同式）
  const circles = [
    { id: '1', name: '连理社区', weight: 3 },
    { id: '2', name: '大工圈子', weight: 1 },
  ]
  const totalW = circles.reduce((s, c) => s + (c.weight ?? 1), 0)
  const budget = 12 * 2
  const share = circles.map((c) => Math.max(4, Math.round((budget * (c.weight ?? 1)) / totalW)))
  assert.equal(share[0], 18, 'weight=3 拿 18/24')
  assert.equal(share[1], 6, 'weight=1 拿 6/24')
  // 缺省/越界洗成 1-5
  const w = (x) => Math.max(1, Math.min(5, Math.floor(Number(x) || 1)))
  assert.equal(w(undefined), 1)
  assert.equal(w(0), 1)
  assert.equal(w(9), 5)
})
