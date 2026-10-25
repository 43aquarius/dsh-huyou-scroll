#!/usr/bin/env node
/**
 * dsh-huyou CLI —— 不写代码也能玩：
 *
 *   HUYOU_COOKIE='reqtype=pc; …' dsh-huyou login          # 登录态体检
 *   dsh-huyou circles 连理社区                              # 圈子搜索（拿 circleId）
 *   dsh-huyou browse 924791210739184512                     # 拉一个圈子的帖子
 *   dsh-huyou feed <feedId>                                 # 看一条帖子
 *   dsh-huyou comments <feedId>                             # 看评论
 *   dsh-huyou bio '我的新简介'                               # 改简介
 *   dsh-huyou post '吃了吗' <circleId>                      # 发文字帖
 *   dsh-huyou tone '一句很 AI 的话' normal                   # fish-tone 掰话预览
 *   dsh-huyou memes 5                                       # 随机抽 5 条梗
 *
 * cookie 来源（二选一）：环境变量 HUYOU_COOKIE，或 data/huyou/config.json（saveHuyouConfig 写的）。
 * 只读命令直接跑；写命令（bio/post）会先打印确认，回车才发。
 */
import { SohuClient } from '../src/index.ts'
import { loadHuyouConfig } from '../src/store.ts'
import { humanize, pickMemes, memeCount } from '../src/fishtone/index.ts'

function cookie(): string {
  const cfg = loadHuyouConfig()
  const c = process.env.HUYOU_COOKIE || cfg.cookie
  if (!c) {
    console.error('没有 cookie。设置 HUYOU_COOKIE 环境变量，或先把 cookie 写进 data/huyou/config.json')
    process.exit(1)
  }
  return c
}

const [cmd, ...args] = process.argv.slice(2)

async function main() {
  switch (cmd) {
    case 'login': {
      const me = await new SohuClient(cookie()).userInfo()
      console.log(`✅ 登录态正常：${me.userName}（${me.userId}）关注 ${me.followCount} / 粉丝 ${me.fansCount}`)
      break
    }
    case 'circles': {
      if (!args[0]) throw new Error('用法：dsh-huyou circles <关键词>')
      const list = await new SohuClient(cookie()).circleSearch(args[0])
      for (const c of list) console.log(`  ${c.circleName} → ${c.circleId}`)
      break
    }
    case 'browse': {
      if (!args[0]) throw new Error('用法：dsh-huyou browse <circleId> [1|2]')
      const { feeds } = await new SohuClient(cookie()).circleFeedList(args[0], { listType: (Number(args[1]) || 2) as 1 | 2, count: 10 })
      for (const f of feeds) {
        console.log(`  [${f.feedId}] ${f.anonymous ? '（匿名）' : f.userName}：${f.content.replace(/\n/g, ' ').slice(0, 60)}（评${f.commentCount}）`)
      }
      break
    }
    case 'feed': {
      if (!args[0]) throw new Error('用法：dsh-huyou feed <feedId>')
      const f = await new SohuClient(cookie()).feedShow(args[0])
      if (!f) throw new Error('帖子不存在')
      console.log(`  ${f.anonymous ? '匿名' : f.userName} @ ${f.circleName}\n  ${f.content}\n  评论 ${f.commentCount} · 转发 ${f.repostCount}`)
      break
    }
    case 'comments': {
      if (!args[0]) throw new Error('用法：dsh-huyou comments <feedId>')
      const { comments } = await new SohuClient(cookie()).commentList(args[0], 0, 10)
      for (const c of comments) console.log(`  ${c.userName}：${c.content.replace(/\n/g, ' ').slice(0, 60)}（赞${c.likeCount}）`)
      break
    }
    case 'bio': {
      const bio = args.join(' ')
      if (!bio) throw new Error('用法：dsh-huyou bio <简介正文>')
      console.log(`将把简介改为：「${bio}」（⚠️「狐友」二字会被敏感词过滤，命中报 800001）\n回车确认，Ctrl+C 取消`)
      await new Promise((r) => process.stdin.once('data', r))
      await new SohuClient(cookie()).updateBio(bio)
      console.log('✅ 简介已更新')
      break
    }
    case 'post': {
      const circleId = args[1] || ''
      const content = args[0]
      if (!content) throw new Error('用法：dsh-huyou post <正文> [circleId]')
      console.log(`将发帖到 ${circleId || '（无圈子）'}：「${content}」\n回车确认，Ctrl+C 取消`)
      await new Promise((r) => process.stdin.once('data', r))
      const fid = await new SohuClient(cookie()).postFeed(content, circleId)
      console.log(`✅ 已发：${fid}`)
      break
    }
    case 'tone': {
      const text = args.slice(0, -1).join(' ') || args[0] || ''
      const strength = (['off', 'light', 'normal', 'max'].includes(args[args.length - 1]) ? args[args.length - 1] : 'light')
      const r = humanize(text, { strength: strength as 'light' })
      console.log(`  [${strength}] ${r.text}`)
      break
    }
    case 'memes': {
      const n = Number(args[0]) || 5
      const cnt = memeCount()
      console.log(`  库存：${cnt.memes} 梗 + ${cnt.constructions} 句式`)
      for (const m of pickMemes(n)) console.log(`  · ${m.term}：${m.gloss}`)
      break
    }
    default:
      console.log('dsh-huyou —— 狐友逆向 API 插件\n\n用法：\n  dsh-huyou login                登录态体检\n  dsh-huyou circles <关键词>      圈子搜索（拿 circleId）\n  dsh-huyou browse <circleId>    拉圈子帖子\n  dsh-huyou feed <feedId>        看一条帖子\n  dsh-huyou comments <feedId>    看评论\n  dsh-huyou bio <简介>           改简介\n  dsh-huyou post <正文> <circleId>  发文字帖\n  dsh-huyou tone <正文> [档位]    fish-tone 掰话预览\n  dsh-huyou memes [n]            随机抽梗')
      process.exit(cmd ? 1 : 0)
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`)
  process.exit(1)
})
