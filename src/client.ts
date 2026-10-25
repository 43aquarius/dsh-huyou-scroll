/**
 * 狐友（w.sohu.com）客户端 —— 2026-10-25 逆向接入并全链路实测
 *
 * 域名：cs-ol.sns.sohu.com（内容服务，feed/评论/发帖全在这）；op/dm 是运营和数据域。
 * 鉴权（双层）：
 *   ① cookie：完整搜狐 passport（ppinf/pprdig/pchytk/hyuid/pchypp/gidinf…）
 *   ② 请求头：S-PID=hyuid · S-PPID=pchypp · S-CID=gidinf · token=pchytk ·
 *      P-APPID=110503 · appid=330012 · s-nonce · flyer · S-VS=6.24.0
 *   ③ 签名（Hi 函数复刻）：params + flyer + appid + app_key_vs，
 *      再拼 s-nonce / S-VS → 全部按字典序 sort → 末尾 append app_key →
 *      join("") → md5 → sig（GET 签 query，POST 签 form body）
 * 信封：{status: 100000, data} = OK；304023/40110/200004 = 登录失效。
 *
 * 端点（全部 2026-10-25 实测通过）：
 *   GET  /rcmd/popular/feeds/v20      推荐流（score 翻页游标）
 *   GET  /v8/circle/feed/list         圈子帖子列表（circle_id/list_type=1热2新/score/withTop/extras）
 *   GET  /v8/circle/suggest/search    圈子搜索（query + page_index）→ circleId
 *   GET  /v7/feeds/show               帖子详情
 *   GET  /v8/comment/list             评论列表（score 翻页）
 *   POST /v8/comment/text             发评论（comment_type=comment|reply）
 *   GET  /v6/feeds/comment/remove     删评论
 *   POST /v7/feeds/text               发纯文字帖（返回 newFeedId）
 *   POST /v7/feeds/dynamic            发图帖（dynamic_pic=JSON([{p,w,h,f}]) + statement_code）
 *   POST /v5/upload/uploadFromFeed    图片上传（multipart：签名字段 file_type/file_metas + file）→ keys
 *   POST /v6/feeds/delete             删帖（feed_id + user_id）
 *   POST /v5/users/update             改简介（user_id + description；⚠️「狐友」二字被敏感词过滤）
 *   POST /v6/users/show_reduced       用户信息（登录态体检）
 *   POST /v8/userapi/user/show        用户主页全量（含 description 简介）
 *
 * 备注（2026-10-25 实测）：pchytk JWT 名义 10 分钟过期，但服务端不严查（passport 主体有效即放行）；
 * 发帖声明码 statement_code：7=无需声明 1=内容由AI生成 4=个人观点 5=转载 2=虚构演绎 6=营销。
 */
import crypto from 'node:crypto'

export const HUYOU_BASE = 'https://cs-ol.sns.sohu.com'
const APP_KEY = '1U32034rUs20A064'
const APP_KEY_VS = '6.24.0'
const APPID = '330012'
const P_APPID = '110503'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 登录失效类业务码（前端 mv 集合：跳登录） */
const LOGIN_INVALID = new Set([304023, 40110, 200004])
/** 业务成功码 */
const OK_STATUS = 100000

export class HuyouError extends Error {
  constructor(
    message: string,
    public code: 'login' | 'risk' | 'upstream' | 'network' | 'encode',
    public status?: number,
  ) {
    super(message)
    this.name = 'HuyouError'
  }
}

export interface HuyouFeedItem {
  feedId: string
  content: string
  userName: string
  userId: string
  avatar: string
  anonymous: boolean
  commentCount: number
  repostCount: number
  exposureCount: number
  circleName: string
  circleId: string
  /** 推荐理由（如「100+评论」） */
  rcmdReason: string
  score: number
  /** 热评一条（推荐流自带） */
  hotComment: string
  /** 原始 tpl（1=转发 2=图文 …） */
  tpl: number
}

export interface HuyouComment {
  commentId: string
  content: string
  userName: string
  userId: string
  likeCount: number
  replyCount: number
}

/** 某条评论下的楼中楼回复（含「回的是谁」—— 回复触发式续评的依据） */
export interface HuyouReply extends HuyouComment {
  /** 回的是哪条（她的评论 id，或楼中楼里另一条回复） */
  replyCommentId: string
  /** 被回复的人（用来认出「回的是我」） */
  replyUserName: string
  replyUserId: string
  /** epoch 毫秒（排序用 —— 实测 replylist 是正序，但代码里仍按 timeId 排保险） */
  timeId: number
}

export interface HuyouUserInfo {
  userId: string
  userName: string
  avatar: string
  followCount: number
  fansCount: number
}

function cookieOf(cookie: string, name: string): string {
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return ''
}

/** s-nonce：时间戳 hex + 随机 hex，截 32 位（复刻 CB()） */
function mintNonce(): string {
  let n = Date.now().toString(16)
  let out = ''
  while (n.length + out.length < 32) {
    const r = Math.random().toString(16)
    out += r.length >= 2 ? r.slice(2) : r
  }
  return (n + out).slice(0, 32)
}

/** Hi() 复刻：参数签名 */
function signParams(params: Record<string, unknown>, extra: { nonce: string; flyer: string }): Record<string, string> {
  const l: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    l[k] = String(v)
  }
  l.flyer = extra.flyer
  l.appid = APPID
  l.app_key_vs = APP_KEY_VS
  const u: string[] = Object.entries(l).map(([k, v]) => `${k}=${v}`)
  u.push(`s-nonce=${extra.nonce}`)
  u.push(`S-VS=${APP_KEY_VS}`)
  u.sort()
  u.push(APP_KEY)
  l.sig = crypto.createHash('md5').update(u.join('')).digest('hex')
  return l
}

export interface HuyouTrafficBudget {
  minGapMs: number
  readHourly: number
  readDaily: number
  writeHourly: number
  writeDaily: number
  writeGapSec: number
}

/** 请求保护预算（狐友侧独立小账本 —— 比 B站 保守一点） */
export const HUYOU_BUDGET: HuyouTrafficBudget = {
  minGapMs: 1500,
  readHourly: 300,
  readDaily: 1200,
  writeHourly: 8,
  writeDaily: 16,
  writeGapSec: 180,
}

/** 请求保护内部账本形状 */
interface HuyouTrafficState {
  nextAt: number
  readHour: number
  readDay: number
  writeHour: number
  writeDay: number
  hourAt: number
  date: string
  lastWrite: number
  until: number
  streak: number
  reason: string
}

/**
 * 狐友客户端。内置单实例请求保护：全局间隔 / 读写预算 / 写冷却 /
 * 429·风控码指数退避 —— 语义对齐 whale/traffic.ts（单进程简化版）。
 */
export class SohuClient {
  private g: HuyouTrafficState

  constructor(private cookie: string) {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    const g = globalThis as unknown as { __huyouTraffic?: HuyouTrafficState }
    this.g = (g.__huyouTraffic ??= {
      nextAt: 0, readHour: 0, readDay: 0, writeHour: 0, writeDay: 0,
      hourAt: Date.now(), date: today, lastWrite: 0, until: 0, streak: 0, reason: '',
    })
  }

  trafficStatus() {
    return {
      pausedUntil: this.g.until > Date.now() ? new Date(this.g.until).toLocaleString('zh-CN') : null,
      pauseReason: this.g.until > Date.now() ? this.g.reason : null,
      today: { read: this.g.readDay, write: this.g.writeDay },
      hourly: { read: this.g.readHour, write: this.g.writeHour },
      budget: HUYOU_BUDGET,
    }
  }

  /** 翻过预算/冷却 → 拒发（不消耗额度）。bypassCooldown：图帖的「上传→发帖」是同一动作，豁免冷却检查（额度照记） */
  private reserve(writing: boolean, bypassCooldown = false): number {
    const b = HUYOU_BUDGET
    const now = Date.now()
    const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
    if (this.g.date !== today) Object.assign(this.g, { date: today, readDay: 0, writeDay: 0 })
    if (now - this.g.hourAt >= 3_600_000) Object.assign(this.g, { hourAt: now, readHour: 0, writeHour: 0 })
    if (this.g.until > now)
      throw new HuyouError(`狐友请求暂停中（${this.g.reason}），${new Date(this.g.until).toLocaleString('zh-CN')} 后恢复`, 'risk')
    if (writing) {
      if (!bypassCooldown && this.g.lastWrite && now - this.g.lastWrite < b.writeGapSec * 1000)
        throw new HuyouError(`写操作冷却中（至少隔 ${b.writeGapSec}s）`, 'risk')
      if (this.g.writeHour >= b.writeHourly || this.g.writeDay >= b.writeDaily)
        throw new HuyouError('狐友写预算用完（小时/日额度），本轮收手', 'risk')
    } else if (this.g.readHour >= b.readHourly || this.g.readDay >= b.readDaily) {
      throw new HuyouError('狐友读预算用完，等窗口恢复', 'risk')
    }
    const slot = Math.max(now, this.g.nextAt)
    if (slot - now > 20_000) throw new HuyouError('狐友请求队列太深，本轮收手', 'risk')
    this.g.nextAt = slot + b.minGapMs
    if (writing) {
      this.g.writeHour += 1
      this.g.writeDay += 1
      this.g.lastWrite = now
    } else {
      this.g.readHour += 1
      this.g.readDay += 1
    }
    return slot
  }

  private noteRisk(status: number, bodyStatus: number | null) {
    const risk = status === 429 || status === 412 || [320002, 320003, 200009, 200010].includes(bodyStatus ?? -1)
    if (!risk) return
    this.g.streak = Math.min(6, this.g.streak + 1)
    this.g.until = Date.now() + Math.min(30 * 60_000, 5 * 60_000 * 2 ** (this.g.streak - 1))
    this.g.reason = `HTTP ${status} / 业务码 ${bodyStatus}`
  }

  /** 带签名的统一请求（accountWrite=false：POST 但语义是读 —— 如用户信息体检，不烧写预算） */
  private async call<T>(
    path: string,
    method: 'GET' | 'POST',
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; accountWrite?: boolean; bypassCooldown?: boolean } = {},
  ): Promise<T> {
    const writing = method === 'POST' && opts.accountWrite !== false
    const slot = this.reserve(writing, opts.bypassCooldown === true)
    const wait = Math.max(0, slot - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))

    const nonce = mintNonce()
    const flyer = String(Date.now())
    const signed = signParams(params, { nonce, flyer })
    const headers: Record<string, string> = {
      'user-agent': UA,
      accept: 'application/json',
      referer: 'https://w.sohu.com/',
      origin: 'https://w.sohu.com',
      cookie: this.cookie,
      'S-PID': cookieOf(this.cookie, 'hyuid'),
      'S-PPID': cookieOf(this.cookie, 'pchypp'),
      'S-VS': APP_KEY_VS,
      'S-CID': cookieOf(this.cookie, 'gidinf'),
      gid: cookieOf(this.cookie, 'gidinf'),
      token: cookieOf(this.cookie, 'pchytk'),
      'P-APPID': P_APPID,
      appid: APPID,
      's-nonce': nonce,
      flyer,
    }
    let url = HUYOU_BASE + path
    if (method === 'GET') {
      url += '?' + new URLSearchParams(signed).toString()
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded'
    }

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? new URLSearchParams(signed).toString() : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
      })
    } catch (e) {
      throw new HuyouError(`狐友网络故障：${(e as Error).message}`, 'network')
    }

    const text = await res.text()
    let body: { status?: number; desc?: string; data?: unknown } = {}
    try {
      body = JSON.parse(text)
    } catch {
      this.noteRisk(res.status, null)
      throw new HuyouError(`狐友返回非 JSON（HTTP ${res.status}）`, 'upstream', res.status)
    }
    this.noteRisk(res.status, body.status ?? null)

    if (LOGIN_INVALID.has(body.status ?? -1))
      throw new HuyouError(`狐友登录失效（业务码 ${body.status}）—— 去设置页重贴 cookie`, 'login', body.status)
    if (body.status !== OK_STATUS)
      throw new HuyouError(`狐友业务错误 ${body.status}：${body.desc ?? ''}`, 'upstream', body.status)
    return (body.data ?? {}) as T
  }

  // ─────────────────── 读端点 ───────────────────

  /** 登录态体检 + 用户信息 */
  async userInfo(userId?: string): Promise<HuyouUserInfo> {
    const uid = userId || cookieOf(this.cookie, 'pchypp')
    const d = await this.call<{
      userId?: string; suid?: string; userName?: string; avatar?: string
      followCount?: number; fansCount?: number
    }>('/v6/users/show_reduced', 'POST', { user_id: uid, log_user_id: uid }, { accountWrite: false })
    const id = String(d.userId ?? d.suid ?? '')
    if (!id) throw new HuyouError('用户信息返回空（cookie 可能失效）', 'login')
    return {
      userId: id,
      userName: d.userName ?? '',
      avatar: d.avatar ?? '',
      followCount: d.followCount ?? 0,
      fansCount: d.fansCount ?? 0,
    }
  }

  /** 推荐流（首页「热门」） */
  async popularFeeds(score = 0, count = 20): Promise<{ feeds: HuyouFeedItem[]; nextScore: number; hasMore: boolean }> {
    const d = await this.call<{
      feedList?: unknown[]
      pageInfo?: { score?: number; hasMore?: boolean; infoCount?: number }
    }>('/rcmd/popular/feeds/v20', 'GET', {
      score, count, tpl: '1,2,3,4', stpl: '1,2,3,4,7,9,11,12,13,16',
    })
    const feeds = (d.feedList ?? []).map(normalizeFeed).filter((x): x is HuyouFeedItem => Boolean(x.feedId))
    return {
      feeds,
      nextScore: d.pageInfo?.score ?? 0,
      hasMore: Boolean(d.pageInfo?.hasMore),
    }
  }

  /** 帖子详情（补全内容） */
  async feedShow(feedId: string): Promise<HuyouFeedItem | null> {
    const d = await this.call<Record<string, unknown>>('/v7/feeds/show', 'GET', { feed_id: feedId })
    const item = normalizeFeed(d)
    return item.feedId ? item : null
  }

  /** 圈子帖子列表（list_type：1=热门 2=最新；score 翻页游标） */
  async circleFeedList(
    circleId: string,
    opts: { listType?: 1 | 2; score?: number; count?: number } = {},
  ): Promise<{ feeds: HuyouFeedItem[]; nextScore: number; hasMore: boolean }> {
    const d = await this.call<{
      feedList?: unknown[]
      pageInfo?: { score?: number; hasMore?: boolean; totalCount?: number }
    }>('/v8/circle/feed/list', 'GET', {
      circle_id: circleId,
      tpl: '1,2,3,4,26,29',
      stpl: '1,2,3,4,7,9,11,12,13,16',
      count: opts.count ?? 20,
      withTop: 1,
      score: opts.score ?? 0,
      list_type: opts.listType ?? 2,
      extras: '1',
    })
    const feeds = (d.feedList ?? []).map(normalizeFeed).filter((x): x is HuyouFeedItem => Boolean(x.feedId))
    return {
      feeds,
      nextScore: d.pageInfo?.score ?? 0,
      hasMore: Boolean(d.pageInfo?.hasMore),
    }
  }

  /** 圈子搜索（找 circleId 用） */
  async circleSearch(query: string): Promise<{ circleId: string; circleName: string }[]> {
    const d = await this.call<{ circleList?: { circleId?: string; circleName?: string }[] }>(
      '/v8/circle/suggest/search', 'GET', { query, page_index: 1, count: 10 },
    )
    return (d.circleList ?? [])
      .map((c) => ({ circleId: String(c.circleId ?? ''), circleName: String(c.circleName ?? '') }))
      .filter((c) => c.circleId)
  }

  /** 用户主页全量（含 description 简介） */
  async userShow(userId?: string): Promise<HuyouUserInfo & { description: string }> {
    const uid = userId || cookieOf(this.cookie, 'hyuid')
    const d = await this.call<{
      userId?: string; userName?: string; avatar?: string; description?: string
      followCount?: number; followerCount?: number
    }>('/v8/userapi/user/show', 'POST', { profile_user_id: uid }, { accountWrite: false })
    return {
      userId: String(d.userId ?? uid),
      userName: d.userName ?? '',
      avatar: d.avatar ?? '',
      description: d.description ?? '',
      followCount: d.followCount ?? 0,
      fansCount: d.followerCount ?? 0,
    }
  }

  /** 评论列表 */
  async commentList(feedId: string, score = 0, count = 20): Promise<{ comments: HuyouComment[]; hasMore: boolean }> {
    const d = await this.call<{ list?: unknown[]; pageInfo?: { hasMore?: boolean } }>(
      '/v8/comment/list', 'GET',
      { feed_id: feedId, stpl: '1,2,4,7,8,9,16', score, count },
    )
    const comments = (d.list ?? []).map((raw) => {
      const c = raw as Record<string, unknown>
      return {
        commentId: String(c.commentId ?? ''),
        content: String(c.content ?? ''),
        userName: String(c.userName ?? ''),
        userId: String(c.userId ?? ''),
        likeCount: Number(c.likeCount ?? c.supportCount ?? 0),
        replyCount: Number(c.replyCount ?? 0),
      }
    }).filter((c) => c.commentId && c.content)
    return { comments, hasMore: Boolean(d.pageInfo?.hasMore) }
  }

  /** 某条评论下的回复列表（2026-10-25 闭环实测：条目含 replyCommentId/replyUserId，翻页用 score 游标） */
  async commentReplyList(
    commentId: string,
    feedId: string,
    score = 0,
    count = 20,
  ): Promise<{ replies: HuyouReply[]; hasMore: boolean; totalCount: number; nextScore: number }> {
    const d = await this.call<{
      list?: unknown[]
      pageInfo?: { hasMore?: boolean; totalCount?: number; infoCount?: number; score?: number }
    }>('/v8/comment/replylist', 'GET', {
      stpl: '1,2,3,4,7,9,11,12,13,16',
      comment_id: commentId,
      score,
      feed_id: feedId,
      count,
    })
    const replies = (d.list ?? []).map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        commentId: String(r.commentId ?? ''),
        content: String(r.content ?? ''),
        userName: String(r.userName ?? ''),
        userId: String(r.userId ?? ''),
        likeCount: Number(r.likeCount ?? r.supportCount ?? 0),
        replyCount: Number(r.replyCount ?? 0),
        replyCommentId: String(r.replyCommentId ?? ''),
        replyUserName: String(r.replyUserName ?? ''),
        replyUserId: String(r.replyUserId ?? ''),
        timeId: Number(r.timeId ?? 0),
      } as HuyouReply
    }).filter((r) => r.commentId && r.content)
    return {
      replies,
      hasMore: Boolean(d.pageInfo?.hasMore),
      totalCount: Number(d.pageInfo?.totalCount ?? d.pageInfo?.infoCount ?? replies.length),
      nextScore: Number(d.pageInfo?.score ?? 0),
    }
  }

  // ─────────────────── 写端点 ───────────────────

  /** 发评论（返回 commentId） */
  async postComment(feedId: string, content: string, replyCommentId?: string): Promise<string> {
    const d = await this.call<{ commentId?: string; comment_id?: string }>(
      '/v8/comment/text', 'POST',
      {
        feed_id: feedId,
        comment_type: replyCommentId ? 'reply' : 'comment',
        content,
        tid: Date.now(),
        ...(replyCommentId ? { reply_comment_id: replyCommentId } : {}),
      },
    )
    const cid = String(d.commentId ?? d.comment_id ?? '')
    if (!cid) throw new HuyouError('评论发出去了但没回 commentId（回帖列表核查）', 'encode')
    return cid
  }

  /** 删评论（自己发的） */
  async removeComment(commentId: string): Promise<void> {
    await this.call('/v6/feeds/comment/remove', 'GET', {
      comment_id: commentId,
      log_user_id: cookieOf(this.cookie, 'hyuid'),
    })
  }

  /** 发纯文字帖（返回 newFeedId） */
  async postFeed(content: string, circleId?: string): Promise<string> {
    const d = await this.call<{ newFeedId?: string }>('/v7/feeds/text', 'POST', {
      content,
      tid: Date.now(),
      circle_id: circleId ?? '',
      user_id: cookieOf(this.cookie, 'hyuid'),
    })
    const fid = String(d.newFeedId ?? '')
    if (!fid) throw new HuyouError('发帖成功但没回 newFeedId', 'encode')
    return fid
  }

  /** 发图帖：多图 + 声明码（返回 newFeedId）。pic 用 uploadImage 返回的 key（自动截文件名）。 */
  async postImageFeed(
    content: string,
    pics: { key: string; w: number; h: number }[],
    opts: { circleId?: string; statementCode?: number } = {},
  ): Promise<string> {
    const dynamicPic = JSON.stringify(
      pics.map((p) => ({ p: p.key.includes('/') ? p.key.slice(p.key.lastIndexOf('/') + 1) : p.key, w: p.w, h: p.h, f: '1' })),
    )
    const d = await this.call<{ newFeedId?: string }>('/v7/feeds/dynamic', 'POST', {
      content,
      tid: Date.now(),
      circle_id: opts.circleId ?? '',
      board_id: '',
      statement_code: opts.statementCode ?? 7,
      user_id: cookieOf(this.cookie, 'hyuid'),
      dynamic_pic: dynamicPic,
    }, { bypassCooldown: true })
    const fid = String(d.newFeedId ?? '')
    if (!fid) throw new HuyouError('图帖发出去了但没回 newFeedId', 'encode')
    return fid
  }

  /** 删自己的帖子 */
  async deleteFeed(feedId: string): Promise<void> {
    await this.call('/v6/feeds/delete', 'POST', {
      feed_id: feedId,
      user_id: cookieOf(this.cookie, 'hyuid'),
    })
  }

  /**
   * 图片上传（multipart）→ 返回 key（如 pic/20261025/xxx.png）。
   * 复刻 web 端 kV()：签名字段（file_type/file_metas/…）进 FormData + file 二进制，
   * 不设 Content-Type（fetch 自动带 boundary）。
   */
  async uploadImage(
    file: { data: Buffer | Uint8Array; filename?: string; mime?: string },
    size: { w: number; h: number },
  ): Promise<{ key: string; picUrl: string; isAigc: boolean }> {
    const slot = this.reserve(true, true)
    const wait = Math.max(0, slot - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))

    const nonce = mintNonce()
    const flyer = String(Date.now())
    const fields = { file_type: 'pic', file_metas: JSON.stringify([{ w: size.w, h: size.h }]) }
    const signed = signParams(fields, { nonce, flyer })
    const headers: Record<string, string> = {
      'user-agent': UA,
      accept: 'application/json',
      referer: 'https://w.sohu.com/',
      origin: 'https://w.sohu.com',
      cookie: this.cookie,
      'S-PID': cookieOf(this.cookie, 'hyuid'),
      'S-PPID': cookieOf(this.cookie, 'pchypp'),
      'S-VS': APP_KEY_VS,
      'S-CID': cookieOf(this.cookie, 'gidinf'),
      gid: cookieOf(this.cookie, 'gidinf'),
      token: cookieOf(this.cookie, 'pchytk'),
      'P-APPID': P_APPID,
      appid: APPID,
      's-nonce': nonce,
      flyer,
    }
    const boundary = '----HuyouUpload' + crypto.randomBytes(8).toString('hex')
    const parts: Buffer[] = []
    for (const [k, v] of Object.entries(signed)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
    }
    const fname = file.filename ?? 'image.png'
    const mime = file.mime ?? 'image/png'
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: ${mime}\r\n\r\n`))
    parts.push(Buffer.from(file.data))
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    headers['content-type'] = `multipart/form-data; boundary=${boundary}`

    let res: Response
    try {
      res = await fetch(HUYOU_BASE + '/v5/upload/uploadFromFeed', {
        method: 'POST',
        headers,
        body: Buffer.concat(parts),
        signal: AbortSignal.timeout(90_000),
      })
    } catch (e) {
      throw new HuyouError(`图片上传网络故障：${(e as Error).message}`, 'network')
    }
    let body: { status?: number; desc?: string; data?: { keys?: string[]; files?: { picUrl?: string }[]; hasMetaAIGC?: string } } = {}
    try {
      body = JSON.parse(await res.text())
    } catch {
      this.noteRisk(res.status, null)
      throw new HuyouError(`图片上传返回非 JSON（HTTP ${res.status}）`, 'upstream', res.status)
    }
    this.noteRisk(res.status, body.status ?? null)
    if (LOGIN_INVALID.has(body.status ?? -1))
      throw new HuyouError(`狐友登录失效（业务码 ${body.status}）`, 'login', body.status)
    if (body.status !== OK_STATUS)
      throw new HuyouError(`图片上传业务错误 ${body.status}：${body.desc ?? ''}`, 'upstream', body.status)
    const key = body.data?.keys?.[0] ?? ''
    if (!key) throw new HuyouError('上传成功但没回 key', 'encode')
    return { key, picUrl: body.data?.files?.[0]?.picUrl ?? '', isAigc: body.data?.hasMetaAIGC === '1' }
  }

  /** 改简介（⚠️ 服务端敏感词过滤：「狐友」等词会 800001，命中就换个说法重试） */
  async updateBio(description: string): Promise<void> {
    await this.call('/v5/users/update', 'POST', {
      user_id: cookieOf(this.cookie, 'hyuid'),
      description,
    })
  }
}

/** feedList 元素 → 统一形状（tpl=1 转发的内容在 sourceFeed 里，其余在顶层） */
function normalizeFeed(raw: unknown): HuyouFeedItem {
  const f = (raw ?? {}) as Record<string, any>
  const sf = (f.sourceFeed ?? {}) as Record<string, any>
  const pick = (k: string): any => f[k] ?? sf[k]
  const circle = (pick('circle') ?? {}) as Record<string, any>
  const hot = (f.hotComment ?? {}) as Record<string, any>
  return {
    feedId: String(pick('feedId') ?? ''),
    content: String(pick('content') ?? '').slice(0, 600),
    userName: String(pick('userName') ?? ''),
    userId: String(pick('userId') ?? ''),
    avatar: String(pick('avatar') ?? ''),
    anonymous: Boolean(pick('anonymous')),
    commentCount: Number(pick('commentCount') ?? 0),
    repostCount: Number(pick('repostCount') ?? 0),
    exposureCount: Number(pick('exposureCount') ?? 0),
    circleName: String(circle.circleName ?? ''),
    circleId: String(circle.circleId ?? ''),
    rcmdReason: String(f.extra?.rcmdReason ?? pick('popularFeedReason') ?? ''),
    score: Number(pick('score') ?? 0),
    hotComment: String(hot.content ?? '').slice(0, 200),
    tpl: Number(f.tpl ?? pick('tpl') ?? 0),
  }
}
