/**
 * dsh-huyou 客户端测试 —— 不打真 API，只验证签名算法 / 形状 / 预算闸。
 * 跑法：node --test tests/client.test.mjs（或 bun test tests/client.test.mjs）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HUYOU_BUDGET } from '../src/client.ts'
import { SohuClient, HuyouError } from '../src/client.ts'
import { seedOf, humanize, pickMemes, memeCount } from '../src/fishtone/index.ts'
import { DEFAULT_CONFIG } from '../src/store.ts'

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
