/**
 * dsh-huyou 刷帖引擎 —— 「她在狐友的一晚」：
 *   0. 体检（cookie 登录态）
 *   1. 拉帖子 → 圈子模式（配置了 circles 就只刷这些圈子）或全站推荐流
 *      → 过滤（判重 / 自帖 / 偏好排除）→ 打分排序
 *   2. 轻读 top maxFeeds（一次 LLM 批量）
 *   3. 深读 top deepRead（拉评论 + 评分卡 5×0-4）
 *   4. 接话闸：总分 ≥ 阈值且过闸（日上限 / 同帖冷却）→ 发一条评论（fish-tone 掰话 + emoji）
 *   5. 图帖闸（可选）：有真实灵感才画 → generateImage → 上传 → 发图帖（带 AI 声明）
 *   6. 日记 + 事件流 + 摘要
 * 红线：撞风控（HuyouError code=risk/login）立刻整轮终止上抛，绝不硬顶。
 *
 * 依赖全部可插拔（见 HuyouEngineDeps）：
 *   chat          必需 —— 任何能聊天的函数
 *   generateImage 可选 —— 不给就不发图帖（画帖闸自动跳过）
 *   notify        可选 —— 收到评论/图帖时回调（接微信/Telegram 推送都行）
 */
import { HuyouError, SohuClient, type HuyouFeedItem } from './client.js'
import {
  loadHuyouConfig, huyouSeen, appendHuyouSeen,
  loadHuyouQuota, recordHuyouQuota, commentGate, imagePostGate,
  pushHuyouEvent, appendHuyouDiary, huyouLog,
} from './store.js'
import {
  judgeLight, judgeDeep, draftComment, writeDiary, draftSummary,
  personaLine, draftImagePost, type LlmChat,
} from './llm.js'
import { humanize, seedOf } from './fishtone/index.js'

export interface HuyouEngineDeps {
  /** LLM 聊天函数（必需）：(system, user, timeoutMs?) => Promise<string> */
  chat: LlmChat
  /** 生图（可选）：prompt => { data, w, h }；不提供则图帖闸自动跳过 */
  generateImage?: (prompt: string) => Promise<{ data: Buffer | Uint8Array; w: number; h: number }>
  /** 通知 hook（可选）：发评论/发图帖成功时回调 */
  notify?: (text: string) => void
}

export interface ScrollResult {
  ok: boolean
  kind: 'scroll' | 'skip'
  summary: string
  light: { feedId: string; content: string; score: number; conclusion: string }[]
  deep: { feedId: string; content: string; total: number; deepConclusion: string }[]
  commented: { feedId: string; content: string; comment: string; commentId: string } | null
  postedImage: { feedId: string; content: string; picUrl: string } | null
  error?: string
}

const dayOf = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

function huyouClient(): SohuClient {
  const cfg = loadHuyouConfig()
  if (!cfg.cookie) throw new HuyouError('还没贴狐友 cookie（config.json 或 HUYOU_COOKIE 环境变量）', 'login')
  return new SohuClient(cfg.cookie)
}

/** 偏好打分（轻量规则版 —— 真正的判断交给轻读 LLM） */
function scoreFeed(f: HuyouFeedItem, likes: string[], dislikes: string[], selfUserId: string): number {
  if (f.userId && f.userId === selfUserId) return -100
  let s = 0
  for (const p of likes) {
    if (p && f.content.includes(p)) s += 4
  }
  for (const d of dislikes) {
    if (d && f.content.includes(d)) return -100
  }
  s += Math.min(3, Math.log10(1 + f.commentCount))
  if (f.content.length < 8) s -= 2
  return s
}

/** 拉帖子：圈子模式（配置了 circles 就只刷这些圈子）否则全站推荐流 */
async function fetchFeeds(
  client: SohuClient,
  cfg: ReturnType<typeof loadHuyouConfig>,
): Promise<{ feeds: HuyouFeedItem[]; source: string }> {
  if (cfg.circles.length) {
    const per = Math.max(4, Math.ceil((cfg.maxFeeds * 2) / cfg.circles.length))
    const all: HuyouFeedItem[] = []
    for (const c of cfg.circles) {
      try {
        const { feeds } = await client.circleFeedList(c.id, { listType: cfg.circleListType, count: per })
        all.push(...feeds)
        huyouLog(`[huyou] 圈子「${c.name}」拉到 ${feeds.length} 条`)
      } catch (e) {
        if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
        huyouLog(`[huyou] 圈子「${c.name}」拉取失败（继续别的圈）：${(e as Error).message}`)
      }
    }
    return { feeds: all, source: `圈子模式（${cfg.circles.map((c) => c.name).join('、')}）` }
  }
  const { feeds } = await client.popularFeeds(0, 40)
  return { feeds, source: '推荐流' }
}

export async function runScroll(
  deps: HuyouEngineDeps,
  kind: 'scroll' | 'skip' = 'scroll',
): Promise<ScrollResult> {
  const cfg = loadHuyouConfig()
  const persona = personaLine(cfg.persona)
  const date = dayOf()

  const empty: ScrollResult = { ok: true, kind, summary: '', light: [], deep: [], commented: null, postedImage: null }

  if (kind === 'skip') {
    huyouLog('[huyou] 今天不想刷 —— 写日记不看帖')
    const diary = await writeDiary(deps.chat, persona, { date, light: [], deep: [], commented: null, skipped: true })
    if (cfg.diaryEnabled) appendHuyouDiary(diary)
    const summary = await draftSummary(deps.chat, persona, { date, light: 0, deep: 0, commented: null, skipped: true })
    pushHuyouEvent({ at: new Date().toISOString(), kind: 'skip', note: '今天不想刷（skipChance 掷中）' })
    return { ...empty, summary }
  }

  const client = huyouClient()

  // 0. 体检
  const me = await client.userInfo()
  huyouLog(`[huyou] 出海：${me.userName}（${me.userId}）`)

  // 1. 拉帖子 + 过滤排序
  const seen = huyouSeen()
  const { feeds, source } = await fetchFeeds(client, cfg)
  const likes = (cfg.likes || '').split(/[\s·,，、]+/).map((s) => s.trim()).filter(Boolean)
  const dislikes = (cfg.dislikes || '').split(/[\s·,，、]+/).map((s) => s.trim()).filter(Boolean)
  const candidates = feeds
    .filter((f) => !seen.has(f.feedId))
    .map((f) => ({ f, s: scoreFeed(f, likes, dislikes, me.userId) }))
    .filter((x) => x.s > -50)
    .sort((a, b) => b.s - a.s)
    .slice(0, cfg.maxFeeds)
    .map((x) => x.f)
  huyouLog(`[huyou] ${source} ${feeds.length} 条 → 过滤后剩 ${candidates.length} 条`)

  if (!candidates.length) {
    const summary = '这轮没捞到能看的（全被判重/偏好筛掉了）—— 不硬凑 ✓'
    pushHuyouEvent({ at: new Date().toISOString(), kind: 'scroll', note: summary })
    return { ...empty, summary }
  }

  // 2. 轻读
  const lights = await judgeLight(deps.chat, persona, candidates)
  appendHuyouSeen(candidates.map((f) => f.feedId))

  // 3. 深读
  const ranked = [...lights].sort((a, b) => b.score - a.score)
  const deepTargets = ranked.slice(0, cfg.deepRead).filter((l) => l.score > 0)
  const deepResults: ScrollResult['deep'] = []
  const deepJudges: { f: HuyouFeedItem; j: Awaited<ReturnType<typeof judgeDeep>> }[] = []
  for (const t of deepTargets) {
    const f = candidates.find((x) => x.feedId === t.feedId)
    if (!f) continue
    try {
      const { comments } = await client.commentList(f.feedId, 0, 20)
      const j = await judgeDeep(deps.chat, persona, f, comments, cfg.likes)
      deepJudges.push({ f, j })
      deepResults.push({ feedId: f.feedId, content: f.content, total: j.total, deepConclusion: j.deepConclusion })
      pushHuyouEvent({ at: new Date().toISOString(), kind: 'deep', target: f.feedId, note: `${j.total}/20` })
      huyouLog(`[huyou] 深读 [${f.feedId}] → ${j.total}/20`)
    } catch (e) {
      if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
      huyouLog(`[huyou] 深读失败 ${t.feedId}：${(e as Error).message}`)
    }
  }

  // 4. 接话闸
  let commented: ScrollResult['commented'] = null
  const best = [...deepJudges].sort((a, b) => b.j.total - a.j.total)[0]
  if (best && best.j.total >= cfg.commentMinScore && cfg.commentEnabled) {
    const gate = commentGate(cfg, best.f.feedId)
    if (!gate.ok) {
      huyouLog(`[huyou] 评论被闸：${gate.reason}`)
    } else if (best.j.commentReason.trim().length < 8) {
      huyouLog('[huyou] 回帖理由不足 8 字 → 说不清为什么就不发 ✓')
    } else {
      try {
        const recentComments = loadHuyouQuota()
          .log.filter((x) => x.type === 'comment')
          .map((x) => x.note ?? '').filter(Boolean)
        const comment = await draftComment(deps.chat, persona, best.f, best.j, recentComments, cfg.fishTone)
        if (comment.trim().length < 4) {
          huyouLog('[huyou] 文案太短（<4 字）→ 弃发 ✓')
        } else {
          const commentId = await client.postComment(best.f.feedId, comment)
          commented = { feedId: best.f.feedId, content: best.f.content, comment, commentId }
          recordHuyouQuota({
            at: new Date().toISOString(), type: 'comment', target: best.f.feedId,
            note: comment.replace(/\s+/g, ' ').slice(0, 60), auto: true,
            commentId, feedId: best.f.feedId,
          })
          pushHuyouEvent({ at: new Date().toISOString(), kind: 'comment', target: best.f.feedId, note: `已发：${comment.slice(0, 40)}` })
          huyouLog(`[huyou] 评论已发 [${best.f.feedId}]：${comment.slice(0, 50)}`)
          deps.notify?.(`狐友评论已发：\n帖子：${best.f.content.slice(0, 60)}\n她说的：${comment.slice(0, 80)}`)
        }
      } catch (e) {
        if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
        huyouLog(`[huyou] 评论发送失败（不杀整轮）：${(e as Error).message}`)
        pushHuyouEvent({ at: new Date().toISOString(), kind: 'error', note: `评论发送失败：${(e as Error).message}` })
      }
    }
  }

  // 5. 图帖闸（可选）
  let postedImage: ScrollResult['postedImage'] = null
  if (cfg.imagePostEnabled && cfg.circles.length && deps.generateImage) {
    const gate = imagePostGate(cfg)
    if (!gate.ok) {
      huyouLog(`[huyou] 图帖被闸：${gate.reason}`)
    } else {
      try {
        const recentPosts = loadHuyouQuota()
          .log.filter((x) => x.type === 'image' || x.type === 'feed')
          .map((x) => x.note ?? '').filter(Boolean)
        const draft = await draftImagePost(deps.chat, persona, {
          circles: cfg.circles.map((c) => c.name),
          todayVibes: lights.map((l) => l.conclusion).filter(Boolean).slice(0, 6),
          recentPosts,
        })
        if (!draft.want || !draft.imagePrompt.trim()) {
          huyouLog(`[huyou] 这轮不想画图（${draft.reason}）✓`)
        } else {
          const circle = cfg.circles.find((c) => c.name === draft.circleName) ?? cfg.circles[0]
          const img = await deps.generateImage(draft.imagePrompt)
          const up = await client.uploadImage({ data: img.data, mime: 'image/png' }, { w: img.w, h: img.h })
          const content = humanize(draft.content || '（尾巴一甩画的）', {
            strength: cfg.fishTone,
            seed: seedOf(`${circle.id}:${draft.imagePrompt.slice(0, 40)}`),
          }).text.trim() || '（尾巴一甩画的）'
          const feedId = await client.postImageFeed(content, [{ key: up.key, w: img.w, h: img.h }], {
            circleId: circle.id,
            statementCode: cfg.statementCode,
          })
          postedImage = { feedId, content, picUrl: up.picUrl }
          recordHuyouQuota({
            at: new Date().toISOString(), type: 'image', target: feedId,
            note: `${circle.name}：${content.replace(/\s+/g, ' ').slice(0, 50)}`, auto: true, feedId,
          })
          pushHuyouEvent({ at: new Date().toISOString(), kind: 'feed', target: feedId, note: `图帖已发到「${circle.name}」：${content.slice(0, 40)}` })
          huyouLog(`[huyou] 图帖已发 [${feedId}] →「${circle.name}」：${content}`)
          deps.notify?.(`狐友图帖已发（${circle.name}）：${content}\n${up.picUrl}`)
        }
      } catch (e) {
        if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
        huyouLog(`[huyou] 图帖失败（不杀整轮）：${(e as Error).message}`)
        pushHuyouEvent({ at: new Date().toISOString(), kind: 'error', note: `图帖失败：${(e as Error).message}` })
      }
    }
  }

  // 6. 日记
  if (cfg.diaryEnabled) {
    try {
      const diary = await writeDiary(deps.chat, persona, {
        date,
        light: lights.map((l) => ({
          feedId: l.feedId,
          content: candidates.find((c) => c.feedId === l.feedId)?.content ?? '',
          conclusion: l.conclusion, wantToSay: l.wantToSay, score: l.score,
        })),
        deep: deepResults.map((d) => ({ ...d })),
        commented: commented ? { feedId: commented.feedId, content: commented.content, comment: commented.comment } : null,
        skipped: false,
      })
      appendHuyouDiary(diary)
      pushHuyouEvent({ at: new Date().toISOString(), kind: 'diary', note: '日记已写' })
    } catch (e: any) {
      huyouLog(`[huyou] 日记失败：${e?.message ?? e}`)
    }
  }

  const summary = await draftSummary(deps.chat, persona, {
    date, light: lights.length, deep: deepResults.length,
    commented: commented ? { feedId: commented.feedId } : null, skipped: false,
  })
  pushHuyouEvent({
    at: new Date().toISOString(), kind: 'scroll',
    note: `轻读 ${lights.length} · 深读 ${deepResults.length} · ${commented ? `接话 ${commented.feedId}` : '没接话'} · ${postedImage ? `图帖 ${postedImage.feedId}` : '没画图'}`,
  })
  return {
    ok: true, kind, summary,
    light: lights.map((l) => ({
      feedId: l.feedId,
      content: candidates.find((c) => c.feedId === l.feedId)?.content ?? '',
      score: l.score, conclusion: l.conclusion,
    })),
    deep: deepResults,
    commented,
    postedImage,
  }
}

/** 手动发一条纯文字帖 */
export async function postText(deps: HuyouEngineDeps, content: string, circleId?: string): Promise<{ feedId: string }> {
  void deps
  const client = huyouClient()
  const feedId = await client.postFeed(content, circleId)
  recordHuyouQuota({
    at: new Date().toISOString(), type: 'feed', target: feedId,
    note: content.replace(/\s+/g, ' ').slice(0, 60), auto: false, feedId,
  })
  pushHuyouEvent({ at: new Date().toISOString(), kind: 'feed', target: feedId, note: '手动发帖' })
  return { feedId }
}

/** 给账号改简介（⚠️ 服务端敏感词过滤：「狐友」二字会 800001） */
export async function updateBio(bio: string): Promise<void> {
  await huyouClient().updateBio(bio)
}
