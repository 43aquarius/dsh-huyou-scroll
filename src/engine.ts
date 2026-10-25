/**
 * dsh-huyou-scroll 刷帖引擎 —— 「她在狐友的一晚」：
 *   0. 体检（cookie 登录态）
 *   0.5 回信检查：挨个看她评过的帖子（threads）—— 有人回复她的评论才接着说（一帖一评的主人规矩）
 *   1. 拉帖子 → 圈子模式（配置了 circles 就只刷这些圈子）或全站推荐流
 *      → 过滤（判重 / 自帖 / 已评过 / 偏好排除）→ 打分排序
 *   2. 轻读 top maxFeeds（一次 LLM 批量）
 *   3. 深读 top deepRead（拉评论 + 评分卡 5×0-4）
 *   4. 接话闸：过阈值的候选挨个发，每轮最多 commentPerRound 条 —— 每帖只发一条并注册线程
 *   5. 发帖闸（可选）：她有真实想说的才发 —— 默认纯文字帖；
 *      只有帖子主体是一张画、且 verifyImage 验过图文相符才发图帖（主人规矩：图不配文就不配图）
 *   6. 日记 + 事件流 + 摘要
 * 红线：撞风控（HuyouError code=risk/login）立刻整轮终止上抛，绝不硬顶。
 *
 * 依赖全部可插拔（见 HuyouEngineDeps）：
 *   chat          必需 —— 任何能聊天的函数
 *   generateImage 可选 —— 不给就不发图帖（想配图也配不成，自动降级纯文字帖）
 *   verifyImage   可选 —— VLM 图文校验（图配不配文案）；不给 = 图一律不发（宁缺毋滥）
 *   notify        可选 —— 收到回复/发帖成功时回调（接微信/Telegram 推送都行）
 */
import { HuyouError, SohuClient, type HuyouFeedItem, type HuyouReply } from './client.js'
import {
  loadHuyouConfig, huyouSeen, appendHuyouSeen,
  loadHuyouQuota, recordHuyouQuota, commentGate, imagePostGate,
  pushHuyouEvent, appendHuyouDiary, huyouLog,
  loadHuyouThreads, upsertHuyouThread, type HuyouThread,
} from './store.js'
import {
  judgeLight, judgeDeep, draftComment, draftReply, writeDiary, draftSummary,
  personaLine, draftImagePost, type LlmChat,
} from './llm.js'
import { humanize, seedOf } from './fishtone/index.js'

export interface HuyouEngineDeps {
  /** LLM 聊天函数（必需）：(system, user, timeoutMs?) => Promise<string> */
  chat: LlmChat
  /** 生图（可选）：prompt => { data, w, h }；不提供则永远发纯文字帖 */
  generateImage?: (prompt: string) => Promise<{ data: Buffer | Uint8Array; w: number; h: number }>
  /** VLM 验图配文（可选）：(图字节, 文案) => { ok, why }；不提供则图一律不发（宁缺毋滥） */
  verifyImage?: (image: Buffer | Uint8Array, content: string) => Promise<{ ok: boolean; why: string }>
  /** 通知 hook（可选）：收到回复/发帖成功时回调 */
  notify?: (text: string) => void
  /** 跨平台共享上下文（可选）：query => 提示词块。注入后她在评论/日记里能自然带出别的窗口的经历（宿主的记忆系统提供） */
  sharedContext?: (query: string) => string
}

export interface ScrollResult {
  ok: boolean
  kind: 'scroll' | 'skip'
  summary: string
  light: { feedId: string; content: string; score: number; conclusion: string }[]
  deep: { feedId: string; content: string; total: number; deepConclusion: string }[]
  /** 这轮发的新评论（一帖一评；每轮最多 commentPerRound 条） */
  comments: { feedId: string; content: string; comment: string; commentId: string }[]
  /** 这轮回的信（有人回复她才说） */
  replies: { feedId: string; to: string; reply: string; commentId: string }[]
  /** 兼容旧字段：这轮第一条评论 */
  commented: { feedId: string; content: string; comment: string; commentId: string } | null
  /** 这轮发的图帖（图经 verifyImage 验过配文） */
  postedImage: { feedId: string; content: string; picUrl: string } | null
  /** 这轮发的纯文字帖（默认形态） */
  postedText: { feedId: string; content: string } | null
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

/**
 * 回信检查（主人规矩：一帖一评，有人回复了她的评论才继续说）。
 * 每条线程拉一次 replylist：她自己的回复不算；回她的（replyUserId 是她 / 直接挂在她评论下）
 * → 以人格回一条（挂到最新那条回复下面）；别人在楼下互聊的 → 记下已看，不插嘴。
 */
async function checkThreadReplies(
  deps: HuyouEngineDeps,
  client: SohuClient,
  cfg: ReturnType<typeof loadHuyouConfig>,
  persona: string,
  me: { userId: string },
): Promise<ScrollResult['replies']> {
  const sent: ScrollResult['replies'] = []
  if (!cfg.commentEnabled) return sent
  const { threads } = loadHuyouThreads()
  if (!threads.length) return sent
  // 最久没查的先查，每轮最多 8 条（读预算保护）
  const toCheck = threads
    .slice()
    .sort((a, b) => String(a.lastCheckedAt ?? '').localeCompare(String(b.lastCheckedAt ?? '')))
    .slice(0, 8)
  let budget = cfg.replyPerRound
  huyouLog(`[huyou] 回信检查：${threads.length} 条线程，这轮看 ${toCheck.length} 条`)

  for (const t of toCheck) {
    if (budget <= 0) break
    let replies: HuyouReply[] = []
    let totalCount = 0
    try {
      const r = await client.commentReplyList(t.commentId, t.feedId, 0, 50)
      replies = r.replies
      totalCount = r.totalCount
    } catch (e) {
      if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
      huyouLog(`[huyou] 拉回复失败 ${t.feedId}（跳过这条线程）：${(e as Error).message}`)
      upsertHuyouThread({ ...t, lastCheckedAt: new Date().toISOString() })
      continue
    }
    const fresh = replies.filter((r) => r.userId !== me.userId && !t.handledReplyIds.includes(r.commentId))
    const handled = [...new Set([
      ...t.handledReplyIds,
      ...replies.filter((r) => r.userId !== me.userId).map((r) => r.commentId),
    ])]
    const thread: HuyouThread = {
      ...t, handledReplyIds: handled, seenReplyCount: totalCount, lastCheckedAt: new Date().toISOString(),
    }
    const toMe = fresh
      .filter((r) => r.replyUserId === me.userId || r.replyCommentId === t.commentId)
      .sort((a, b) => a.timeId - b.timeId)
    if (!toMe.length) {
      if (fresh.length) huyouLog(`[huyou] [${t.feedId}] 楼下有人互聊但不是回她 —— 看过不插嘴 ✓`)
      upsertHuyouThread(thread)
      continue
    }
    const newest = toMe[toMe.length - 1]
    try {
      const myRecentReplies = loadHuyouQuota()
        .log.filter((x) => x.type === 'reply').map((x) => x.note ?? '').filter(Boolean)
      const text = await draftReply(deps.chat, persona, {
        feed: { content: t.feedContent, author: t.feedAuthor || '网友' },
        myComment: t.content,
        replies: toMe.map((r) => ({ userName: r.userName || '网友', content: r.content })),
        myRecentReplies,
      }, cfg.fishTone, deps.sharedContext?.(`${t.feedContent.slice(0, 120)} ${toMe[toMe.length - 1]?.content.slice(0, 60) ?? ''}`) ?? '')
      if (text.trim().length < 2) {
        huyouLog('[huyou] 回信文案太短 → 弃发 ✓')
        upsertHuyouThread(thread)
        continue
      }
      const newId = await client.postComment(t.feedId, text, newest.commentId)
      thread.repliesByMe += 1
      upsertHuyouThread(thread)
      recordHuyouQuota({
        at: new Date().toISOString(), type: 'reply', target: t.feedId,
        note: text.replace(/\s+/g, ' ').slice(0, 60), auto: true, commentId: newId, feedId: t.feedId,
      })
      pushHuyouEvent({
        at: new Date().toISOString(), kind: 'reply', target: t.feedId,
        note: `回 ${newest.userName || '网友'}：${text.replace(/\s+/g, ' ').slice(0, 40)}`,
      })
      huyouLog(`[huyou] 回信已发 [${t.feedId}] → ${newest.userName || '网友'}：${text.slice(0, 50)}`)
      deps.notify?.(`狐友收到回复啦（来自 ${newest.userName || '网友'}）：\n对方说：${newest.content.slice(0, 60)}\n她回的：${text.slice(0, 80)}`)
      sent.push({ feedId: t.feedId, to: newest.userName || '网友', reply: text, commentId: newId })
      budget -= 1
    } catch (e) {
      if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
      huyouLog(`[huyou] 回信发送失败 ${t.feedId}（不杀整轮）：${(e as Error).message}`)
      upsertHuyouThread(thread)
      pushHuyouEvent({
        at: new Date().toISOString(), kind: 'error', target: t.feedId,
        note: `回信失败：${(e as Error).message}`,
      })
    }
  }
  return sent
}

export async function runScroll(
  deps: HuyouEngineDeps,
  kind: 'scroll' | 'skip' = 'scroll',
): Promise<ScrollResult> {
  const cfg = loadHuyouConfig()
  const persona = personaLine(cfg.persona)
  const date = dayOf()

  const empty: ScrollResult = {
    ok: true, kind, summary: '', light: [], deep: [],
    comments: [], replies: [], commented: null, postedImage: null, postedText: null,
  }

  // ── skip 日：不刷帖，但有人在等她回话的话还是回的 ──
  if (kind === 'skip') {
    huyouLog('[huyou] 今天不想刷 —— 但先看看有没有人在等回信')
    let replies: ScrollResult['replies'] = []
    try {
      const client = huyouClient()
      const me = await client.userInfo()
      replies = await checkThreadReplies(deps, client, cfg, persona, me)
    } catch (e) {
      if (e instanceof HuyouError && e.code === 'login') throw e
      huyouLog(`[huyou] skip 日回信检查失败（不挡日记）：${(e as Error).message}`)
    }
    const diary = await writeDiary(deps.chat, persona, {
      date, light: [], deep: [], commented: null,
      replies: replies.map((r) => ({ to: r.to, reply: r.reply })),
      skipped: true,
    }, deps.sharedContext?.(`${date} 狐友 skip 日`) ?? '')
    if (cfg.diaryEnabled) appendHuyouDiary(diary)
    const summary = await draftSummary(deps.chat, persona, {
      date, light: 0, deep: 0, commented: null, replies: replies.length, skipped: true,
    }, deps.sharedContext?.(`${date} 狐友 skip 日`) ?? '')
    pushHuyouEvent({
      at: new Date().toISOString(), kind: 'skip',
      note: `今天不想刷（skipChance 掷中）${replies.length ? `，但还是回了 ${replies.length} 条信` : '，也没人找她'}`,
    })
    return { ...empty, summary, replies }
  }

  const client = huyouClient()

  // 0. 体检
  const me = await client.userInfo()
  huyouLog(`[huyou] 出海：${me.userName}（${me.userId}）`)

  // 0.5 回信检查（优先于刷新帖 —— 对话比围观要紧）
  const replies = await checkThreadReplies(deps, client, cfg, persona, me)

  // 1. 拉帖子 + 过滤排序（已评过的不进候选 —— 一帖一评，不用再深读）
  const seen = huyouSeen()
  const commentedFeedIds = new Set<string>([
    ...loadHuyouThreads().threads.map((t) => t.feedId),
    ...loadHuyouQuota().log.filter((x) => (x.type === 'comment' || x.type === 'reply') && x.feedId).map((x) => x.feedId as string),
  ])
  const { feeds, source } = await fetchFeeds(client, cfg)
  const likes = (cfg.likes || '').split(/[\s·,，、]+/).map((s) => s.trim()).filter(Boolean)
  const dislikes = (cfg.dislikes || '').split(/[\s·,，、]+/).map((s) => s.trim()).filter(Boolean)
  const candidates = feeds
    .filter((f) => !seen.has(f.feedId) && !commentedFeedIds.has(f.feedId))
    .map((f) => ({ f, s: scoreFeed(f, likes, dislikes, me.userId) }))
    .filter((x) => x.s > -50)
    .sort((a, b) => b.s - a.s)
    .slice(0, cfg.maxFeeds)
    .map((x) => x.f)
  huyouLog(`[huyou] ${source} ${feeds.length} 条 → 过滤后剩 ${candidates.length} 条`)

  if (!candidates.length) {
    const summary = `这轮没捞到能看的（全被判重/已评/偏好筛掉了）${replies.length ? `，但回了 ${replies.length} 条信 ✓` : ' —— 不硬凑 ✓'}`
    pushHuyouEvent({ at: new Date().toISOString(), kind: 'scroll', note: summary })
    return { ...empty, summary, replies }
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
      pushHuyouEvent({
        at: new Date().toISOString(), kind: 'deep', target: f.feedId,
        note: `${j.total}/20 ${j.commentReason.slice(0, 40)}`,
      })
      huyouLog(`[huyou] 深读 [${f.feedId}] → ${j.total}/20`)
    } catch (e) {
      if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
      huyouLog(`[huyou] 深读失败 ${t.feedId}：${(e as Error).message}`)
    }
  }

  // 4. 接话闸（无日上限 —— 规矩是「一帖一评」；过阈值的候选挨个发，每轮最多 commentPerRound 条）
  const comments: ScrollResult['comments'] = []
  if (!cfg.commentEnabled) {
    if (deepJudges.some((d) => d.j.total >= cfg.commentMinScore))
      huyouLog('[huyou] 有够格的帖子，但评论开关关着 → 只记日记')
  } else {
    const queue = [...deepJudges].sort((a, b) => b.j.total - a.j.total)
    for (const cand of queue) {
      if (comments.length >= cfg.commentPerRound) break
      if (cand.j.total < cfg.commentMinScore) break // 已按分排序，后面只会更低
      const gate = commentGate(cfg, cand.f.feedId)
      if (!gate.ok) {
        huyouLog(`[huyou] 评论被闸：${gate.reason}`)
        continue
      }
      if (cand.j.commentReason.trim().length < 8) {
        huyouLog('[huyou] 回帖理由不足 8 字 → 说不清为什么就不发 ✓')
        continue
      }
      try {
        const recentComments = loadHuyouQuota()
          .log.filter((x) => x.type === 'comment' || x.type === 'reply')
          .map((x) => x.note ?? '')
          .filter(Boolean)
        const comment = await draftComment(deps.chat, persona, cand.f, cand.j, recentComments, cfg.fishTone, deps.sharedContext?.(`${cand.f.content.slice(0, 200)}`) ?? '')
        if (comment.trim().length < 4) {
          huyouLog('[huyou] 文案太短（<4 字）→ 弃发 ✓')
          continue
        }
        const commentId = await client.postComment(cand.f.feedId, comment)
        comments.push({ feedId: cand.f.feedId, content: cand.f.content, comment, commentId })
        // 注册对话线程（下次回信检查的依据）
        upsertHuyouThread({
          feedId: cand.f.feedId, commentId, content: comment,
          feedContent: cand.f.content.slice(0, 300),
          feedAuthor: cand.f.anonymous ? '匿名网友' : (cand.f.userName || '网友'),
          at: new Date().toISOString(),
          handledReplyIds: [], seenReplyCount: 0, repliesByMe: 0,
          lastCheckedAt: new Date().toISOString(),
        })
        recordHuyouQuota({
          at: new Date().toISOString(), type: 'comment', target: cand.f.feedId,
          note: comment.replace(/\s+/g, ' ').slice(0, 60), auto: true,
          commentId, feedId: cand.f.feedId,
        })
        pushHuyouEvent({
          at: new Date().toISOString(), kind: 'comment', target: cand.f.feedId,
          note: `已发：${comment.replace(/\s+/g, ' ').slice(0, 40)}`,
        })
        huyouLog(`[huyou] 评论已发 [${cand.f.feedId}]：${comment.slice(0, 50)}`)
        deps.notify?.(`狐友评论已发：\n帖子：${cand.f.content.slice(0, 60)}\n她说的：${comment.slice(0, 80)}`)
      } catch (e) {
        if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
        huyouLog(`[huyou] 评论发送失败（不杀整轮）：${(e as Error).message}`)
        pushHuyouEvent({
          at: new Date().toISOString(), kind: 'error', target: cand.f.feedId,
          note: `评论发送失败：${(e as Error).message}`,
        })
      }
    }
  }
  const commented = comments[0] ?? null

  // 5. 发帖闸（默认纯文字帖；只有「帖子的主体是一张画」且验过图文相符才配图 —— 主人规矩：图不配文就不配图）
  let postedImage: ScrollResult['postedImage'] = null
  let postedText: ScrollResult['postedText'] = null
  if (cfg.imagePostEnabled && cfg.circles.length && kind === 'scroll') {
    const gate = imagePostGate(cfg)
    if (!gate.ok) {
      huyouLog(`[huyou] 发帖被闸：${gate.reason}`)
    } else {
      try {
        const recentPosts = loadHuyouQuota()
          .log.filter((x) => x.type === 'image' || x.type === 'feed')
          .map((x) => x.note ?? '').filter(Boolean)
        const draft = await draftImagePost(deps.chat, persona, {
          circles: cfg.circles.map((c) => c.name),
          todayVibes: lights.map((l) => l.conclusion).filter(Boolean).slice(0, 6),
          recentPosts,
        }, deps.sharedContext?.(`${cfg.circles.map((c) => c.name).join(' ')} ${lights.map((l) => l.conclusion).join(' ').slice(0, 120)}`) ?? '')
        if (!draft.want || !draft.content.trim()) {
          huyouLog(`[huyou] 她这轮不想发帖（${draft.reason}）✓`)
        } else {
          const circle = cfg.circles.find((c) => c.name === draft.circleName) ?? cfg.circles[0]
          const content = humanize(draft.content, {
            strength: cfg.fishTone,
            seed: seedOf(`${circle.id}:${draft.content.slice(0, 40)}`),
          }).text.trim() || draft.content.trim()
          const prompt = draft.imagePrompt.trim()
          let pics: { key: string; w: number; h: number }[] | null = null
          let picUrl = ''

          if (!prompt) {
            huyouLog('[huyou] 纯文字帖（无配图必要）✓')
          } else if (!deps.generateImage || !deps.verifyImage) {
            // 生图/验图链没配 → 宁缺毋滥，直接文字帖
            huyouLog('[huyou] 生图或验图链未配置 → 纯文字帖（宁缺毋滥）✓')
          } else {
            // 生图 → VLM 验图文相符 → 相符才发图帖；不符/拿不准 → 降级纯文字帖
            try {
              const img = await deps.generateImage(prompt)
              const verdict = await deps.verifyImage(img.data, content)
              if (verdict.ok) {
                const up = await client.uploadImage({ data: img.data, mime: 'image/png' }, { w: img.w, h: img.h })
                pics = [{ key: up.key, w: img.w, h: img.h }]
                picUrl = up.picUrl
                huyouLog('[huyou] VLM 验图通过 → 图帖')
              } else {
                huyouLog(`[huyou] VLM 判图不配文（${verdict.why}）→ 降级纯文字帖 ✓`)
                pushHuyouEvent({
                  at: new Date().toISOString(), kind: 'error',
                  note: `图不配文已拦下（降级文字帖）：${verdict.why}`,
                })
              }
            } catch (e) {
              if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
              huyouLog(`[huyou] 生图/验图链挂了（${(e as Error).message}）→ 降级纯文字帖 ✓`)
            }
          }

          if (pics) {
            const feedId = await client.postImageFeed(content, pics, {
              circleId: circle.id,
              statementCode: cfg.statementCode,
            })
            postedImage = { feedId, content, picUrl }
            recordHuyouQuota({
              at: new Date().toISOString(), type: 'image', target: feedId,
              note: `${circle.name}：${content.replace(/\s+/g, ' ').slice(0, 50)}（已验图文相符）`, auto: true, feedId,
            })
            pushHuyouEvent({
              at: new Date().toISOString(), kind: 'feed', target: feedId,
              note: `图帖（已验图文相符）已发到「${circle.name}」：${content.slice(0, 40)}`,
            })
            huyouLog(`[huyou] 图帖已发 [${feedId}] →「${circle.name}」：${content}`)
            deps.notify?.(`狐友图帖已发（${circle.name}，已验图配文）：${content}\n${picUrl}`)
          } else {
            const feedId = await client.postFeed(content, circle.id)
            postedText = { feedId, content }
            recordHuyouQuota({
              at: new Date().toISOString(), type: 'feed', target: feedId,
              note: `${circle.name}（文字帖）：${content.replace(/\s+/g, ' ').slice(0, 50)}`, auto: true, feedId,
            })
            pushHuyouEvent({
              at: new Date().toISOString(), kind: 'feed', target: feedId,
              note: `文字帖已发到「${circle.name}」：${content.slice(0, 40)}`,
            })
            huyouLog(`[huyou] 文字帖已发 [${feedId}] →「${circle.name}」：${content}`)
            deps.notify?.(`狐友文字帖已发（${circle.name}）：${content}`)
          }
        }
      } catch (e) {
        if (e instanceof HuyouError && (e.code === 'risk' || e.code === 'login')) throw e
        huyouLog(`[huyou] 发帖失败（不杀整轮）：${(e as Error).message}`)
        pushHuyouEvent({ at: new Date().toISOString(), kind: 'error', note: `发帖失败：${(e as Error).message}` })
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
        replies: replies.map((r) => ({ to: r.to, reply: r.reply })),
        skipped: false,
      }, deps.sharedContext?.(`${date} ${lights.map((l) => `${l.conclusion}${l.wantToSay}`.slice(0, 60)).join(' ')}`) ?? '')
      appendHuyouDiary(diary)
      pushHuyouEvent({ at: new Date().toISOString(), kind: 'diary', note: '日记已写' })
    } catch (e: any) {
      huyouLog(`[huyou] 日记失败：${e?.message ?? e}`)
    }
  }

  const summary = await draftSummary(deps.chat, persona, {
    date, light: lights.length, deep: deepResults.length,
    commented: commented ? { feedId: commented.feedId } : null,
    replies: replies.length, skipped: false,
  }, deps.sharedContext?.(`${date} 狐友收工`) ?? '')
  pushHuyouEvent({
    at: new Date().toISOString(), kind: 'scroll',
    note: `轻读 ${lights.length} · 深读 ${deepResults.length} · 接话 ${comments.length} · 回信 ${replies.length} · ${postedImage ? `图帖 ${postedImage.feedId}` : postedText ? `文字帖 ${postedText.feedId}` : '没发帖'}`,
  })
  return {
    ok: true, kind, summary,
    light: lights.map((l) => ({
      feedId: l.feedId,
      content: candidates.find((c) => c.feedId === l.feedId)?.content ?? '',
      score: l.score, conclusion: l.conclusion,
    })),
    deep: deepResults,
    comments,
    replies,
    commented,
    postedImage,
    postedText,
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

/** 删自己的帖子（图发岔了 / 主人要求撤回） */
export async function deleteFeed(feedId: string): Promise<void> {
  await huyouClient().deleteFeed(feedId)
}

/** 给账号改简介（⚠️ 服务端敏感词过滤：「狐友」二字会 800001） */
export async function updateBio(bio: string): Promise<void> {
  await huyouClient().updateBio(bio)
}
