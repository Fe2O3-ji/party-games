# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

同一个网页里有两款派对小游戏:

- **传声筒**(3–8 人):描述接龙,看一句话能跑多歪。
- **默契挑战**(2–5 人):同一主题同时写词,直到全员同词。

服务端只用 Node.js 内置模块,前端是原生 HTML/CSS/JS,零依赖、无构建步骤。规则见 `README.md`。`game.mode` 区分本局玩哪款(`chain` / `match`):空房间由第一位入座的人在选游戏界面决定,入座后房主可以继续在大厅切换。

`docs/默契挑战-规则草案.md` 是默契挑战的设计记录,已于 2026-11-01 实现;实际行为以代码为准。

## 命令

```bash
node server.js                 # 启动,默认 http://localhost:3000
PORT=4000 node server.js       # 换端口
npm start                      # 等价于 node server.js
node --check server.js && node --check rules.js && node --check public/app.js   # 语法检查

# 调试用:缩短回合计时和断线宽限期,方便测试超时/掉线
TURN_SECONDS=5 DISCONNECT_GRACE_MS=2000 node server.js

# 默契挑战:每轮 5 秒,揭晓停留 2 秒
MATCH_SECONDS=5 MATCH_REVEAL_SECONDS=2 node server.js
```

默认值:传声筒每棒 60 秒;默契挑战每轮 40 秒,揭晓页停留 8 秒;断线宽限 5 分钟。服务器跑在本机时,合盖/系统睡眠会暂停整个服务;长时间开桌可以用 `caffeinate -dimsu node server.js`。

仓库没有自动化测试、lint 或构建配置。改动后需要启动服务,用多个浏览器窗口验证完整流程。注意同一浏览器的多个标签共享 localStorage 身份,模拟多人要用普通窗口 + 无痕窗口 + 另一浏览器。

默契挑战至少要覆盖:2 人开局、提交前互不可见、全部交卷立即揭晓、超时沿用上一轮的词、首轮超时未答、同词结算、房主结束、少于 2 人在线结束。

`rules.js` 是纯函数模块,改判定规则时可以直接用一次性 Node 脚本调用 `findRestriction(id).check(text)` 和 `containsTarget()` 覆盖正反例,再启动服务走一遍完整对局。

## 架构

### 状态与阶段

单进程、单房间、纯内存。`server.js` 顶部的 `game` 是唯一状态源,服务器重启即清空。

```
传声筒:  lobby → playing → vote → (molevote) → result → lobby
默契挑战:lobby → match(input ⇄ reveal) → matchresult → lobby
```

- `game.mode` 是 `chain` / `match`:空房间时由第一位入座的人在 `POST /api/join` 里带上 `mode` 决定;房间已有人时新玩家只能加入当前游戏(模式不一致返回 409);入座后房主可通过 `POST /api/mode` 在大厅切换。已有超过 5 人时不能切到默契挑战。
- 默契挑战用 `game.phase = 'match'` 加 `game.match.stage`(`input` / `reveal`)区分输入与揭晓;结算 phase 是 `matchresult`。
- `molevote` 只在开启卧底模式时出现。
- `game.order` 是本局随机棒次(存 playerId);`game.step` 指向当前玩家。
- `game.options`(卧底 / 限制卡 / 类别 / 历史记录)只能在 lobby 由房主修改。
- 第一个加入的人成为 `hostId`;只有房主能 start、改玩法、清空牌桌。
- 每棒限时 60 秒(`TURN_SECONDS` 可覆盖),由服务端计时并自动推进。

### 默契挑战

- `game.match` 保存本局:`theme`、`round`、`stage`(`input` / `reveal`)、`submissions`(pid → 本轮词)、`sources`(pid → `submit` / `carry` / `missed`)、`history[]`、`result`。
- `game.options.theme`(默认 `true`)决定开局是否指定主题;关闭时 `game.match.theme = ''`,前端显示「自由起手」,结果页也标记自由起手。
- 主题题库在 `data/themes.json`;`loadMatchThemes()` 在每次开局时读取,修改后下一局生效,无需重启。文件缺失或解析失败时回退到 `DEFAULT_MATCH_THEMES`。
- 人数 2–5(join / start 都校验);开局要求至少 2 人在线。
- 每轮默认 40 秒(`MATCH_SECONDS`),所有在线玩家交卷立即揭晓;揭晓停留 8 秒(`MATCH_REVEAL_SECONDS`)后自动进入下一轮。
- 超时收卷:在线但没交的人沿用自己上一轮的词(`carry`);上一轮也没有词则记 `missed`。离线且没交的人本轮弃权(`offline`),不参与判同。
- 判同:所有非离线参与者都有非空词,且 `normalize()` 后完全相等;至少 2 名参与者。
- 揭晓时在线人数少于 2 → 直接结算(原因 `players`)。房主随时可以 `POST /api/match-end` 结算;当前未揭晓的一轮不计入 `history`。
- 一局只结算一次(`matchresult`);称号按 `history.length`:1 / 2 / 3–4 / 5+,未相遇统一「各想各的」。
- 手动提交 1–8 个字,不能重复自己上一轮的词;超时沿用不受此限制。
- `game.match` 在 `again` / `reset` 时清空;`again` 保留 `game.mode`,`reset` 回到 `chain`。

### 回合计时与在线状态

- `startTurnTimer()` 在开局和每次推进时设置 `game.deadline`;`autoSubmitTurn()` 超时后用占位内容推进整局,不会卡死。
- 默契挑战使用独立的 `matchTimer` / `matchSeq` 和 `scheduleMatchTimer()`,输入与揭晓共用一个计时器;`clearMatchTimer()` 在结束、重开、清场时调用。
- 中间玩家的猜测在锁定步骤就通过 `POST /api/guess` 存入 `game.pendingGuess`;超时自动提交时会保留这个猜测。
- 在线状态由 SSE 连接实时统计(`isOnline()`),视图里的 `players[].online` 来自它。
- 断开后 `DISCONNECT_GRACE_MS`(默认 5 分钟)内重连会取消移除。`scheduleRemoval()` 带睡眠保护:如果定时器实际延迟超过宽限期 1 分钟以上(电脑睡过),会重新计时而不是立刻踢人。超时后:大厅直接移出玩家并把房主顺延给下一位;传声筒游戏中保留席位,靠 60 秒超时继续推进;默契挑战掉线者本轮弃权,回到大厅时再清理。
- 房主可在大厅通过 `POST /api/kick-offline` 手动移出离线玩家(不会移除房主自己);前端只在有离线玩家时显示「移出离线玩家 (n)」。
- 断线时前端显示 `.conn-banner`「连接中断,正在重连…」;名字存 localStorage `tt_name`,起名页自动回填。
- 投票自动结算只统计在线玩家,掉线的人不会阻塞开奖。
- `game.options.history` 开启后,已提交过本棒的玩家会在视图里拿到 `history`;当前玩家和还没轮到的人都拿不到。

### 描述判定

- `rules.js` 是零依赖纯函数模块:`containsTarget()` 判断描述是否包含完整目标词(忽略空格、标点、大小写);`RESTRICTIONS` 每条都带可执行的 `check`。
- 提交描述时服务端按顺序校验:目标词 → 本棒限制。违规返回 400,不推进 `step`,60 秒计时继续。
- 第一棒的目标词是 `word`;中间玩家的目标词是 `guess`(可能来自 `pendingGuess`);最后一棒没有描述,不校验。
- 超时自动提交的占位描述绕过校验,避免自动推进被拒绝。
- 限制卡只存规则 id,视图用 `restrictionText()` 转成文案。新增规则必须在 `rules.js` 提供 `id`、`text`、`check`,否则无法判定。

### 服务端

- `GET /events?pid=` 是 SSE 长连接,`POST /api/*` 是操作;所有状态变更后调用 `broadcast()`。
- 端点分组:`join` / `start` / `options` / `mode`;`submit` / `guess`;`match-submit` / `match-end`;`vote` / `finish-vote` / `mole-vote` / `finish-mole-vote`;`again` / `reset` / `kick-offline`。
- `POST /api/join` 支持 `mode`:空房间写入该模式;房间已有人且模式不一致返回 409。
- `POST /api/options` 做部分合并,只更新请求里出现的字段;默契挑战只传 `theme`,不会清掉传声筒选项。
- `again` 同时接受 `result` 和 `matchresult`;`reset` 会把模式重置回 `chain`,选项里的 `theme` 恢复为 `true`。
- `viewFor(pid)` 按玩家生成**私有视图**,这是全项目最重要的不变量:
  - playing 阶段只有当前玩家拿到 `turn`(上一棒描述、first/last、限制卡)。
  - 卧底身份只通过 `isMole` 返回给本人;公开的 `mole` 字段只在 result 阶段出现。
  - `originalWord` 和完整 `turns` 只在 vote / molevote / result 阶段返回。
  - `turnTimeLeft` 所有玩家都能看;`history` 只发给已完成本棒的玩家。
  - `perfect` 从 vote 阶段开始返回,表示最后一棒与原词归一化后是否完全一致。
  - 默契挑战输入阶段只给本人 `match.myWord`;别人的词只能用 `players[].submitted` 的布尔值表示。完整 `match.history` 只包含已经揭晓的轮次,当前轮的词绝不进入视图。
  - `matchresult` 才返回完整轨迹和称号;结果对象在 `finishMatch()` 里生成。
  - 新增视图字段时,先判断它应该给谁、在哪个阶段可见。
- 操作接口都会校验:是否玩家、是否当前棒次、是否房主、投票目标是否合法。
- 两轮投票:`game.votes`(最猪)和 `game.moleVotes`(猜卧底,卧底本人被拒绝)。
  - `settlePig()` 统计最猪;若开启卧底则切到 `molevote`,否则直接 `result`。
  - `settleMole()` 统计竞猜、写入 `result.mole`,并把 phase 切到 `result`;卧底到这一刻才公开。
  - 投票视图只暴露票数计数,不暴露 voter→target,保持匿名。
- 开局时根据 `options` 生成 `category`、`restrictions[]`(每位描述者一条)和 `moleId`(从中间棒次随机)。

### 前端

- `public/app.js` 无框架:`shell(s, inner)` 包页面并按 `s.mode` 切换刊头,按 phase 调对应的 `*View()`,再 `bind()` 绑定事件。
- SSE 消息 → `onState()` → `render()`。
- `renderKey()` 控制是否重建 DOM。它是防止玩家正在输入时被广播冲掉的关键:轮到自己时,只要 key 不变就不重建。新增需要实时刷新且可能影响输入的状态才加进 key,不要随意扩大。
- `render()` 在整页重建前会调用 `captureInputDrafts()` / `restoreInputDrafts()`,保存并恢复所有文本框的值、选区和焦点。这样即使房主切游戏、有人入座等广播触发了重建,未提交的输入也不会丢。
- 倒计时用 `turnTimeLeft`(传声筒)或 `match.timeLeft`(默契挑战)+ `stateReceivedAt` 在本地递减,只更新 `#countdown` 文本;这两个剩余时间绝不能进 `renderKey()`。
- `onlineKey` 只在当前玩家没有输入表单时参与渲染 key(传声筒是 `!s.turn`,默契挑战是输入阶段且还没提交),这样等待/大厅能实时看到离线标签,又不打断正在填的输入。
- 中间玩家是本地两步交互:stage 从 `guess` 先 `POST /api/guess` 锁定猜测 → `describe` 提交描述;提交失败会回退。
- 历史记录用 `<details>` 折叠面板,只渲染服务端下发的 `history`。
- 完美接龙:`perfect` 首次出现时按 `roundNo` 去重触发一次 `fireConfetti()`(纯 canvas 纸屑);`prefers-reduced-motion: reduce` 下跳过礼炮,只保留横幅。
- 所有玩家输入在插入模板前必须经过 `esc()`。
- 未入座时先渲染 `gameChoiceView()`(一级选游戏),点卡片后进入 `joinView()`;本地用 `joinScreen` / `selectedMode` 控制。房间已经有人时,另一款游戏的卡片锁定,加入时以 `s.mode` 为准。
- 一级选游戏页使用独立的中性刊头「小游戏桌」,不走 `shell()`;起名页用 `shell(s, inner, mode)` 显示所选游戏的刊头。
- 默契挑战:`matchView()` 按 `s.match.stage` 渲染输入或揭晓,`matchResultView()` 渲染称号和轨迹;`shell(s, inner)` 根据 `s.mode` 切换刊头、印章和页脚。
- 大厅的 `.mode-card` 只在房主且 `phase === 'lobby'` 时绑定点击;默契挑战的 `matchOptionsView()` 显示「指定主题」开关,关闭后输入页渲染自由起手卡片。
- `renderKey()` 里默契挑战只放 `stage` / `round` / `myWord` / `history.length` / 结果字段;**不要**把提交状态或 `matchTimeLeft` 放进 key。正在输入时别人的提交由 `syncMatchLive()` 每 250ms 轻量更新玩家状态和计数,避免整页重建冲掉输入。
- 默契挑战成功结算时按 `theme|rounds` 去重触发一次 `fireConfetti()`。
- 断线时 `setConnectionLost()` 显示 `.conn-banner`;`EventSource` 自动重连,`onopen` / `onmessage` 清除提示。
- 身份存在 localStorage 的 `tt_pid`,名字存在 `tt_name`;起名页用 `savedName` 自动回填。服务端不认识该 pid 时视图返回 `me: null`,前端自动回到选游戏页。
- 样式在 `public/style.css`,复古档案纸 + 朱红印章,颜色和字体集中在 `:root` 变量;移动优先。

## 改功能时的连锁点

新增阶段或玩法通常需要同步修改:

1. 服务端 phase / `game.mode` 流转与校验、`viewFor` 的可见性、阶段切换时的数据重置。
2. 两种模式各自的计时器:`turnTimer`(传声筒)与 `matchTimer`(默契挑战);进入其他阶段、重开、清场时都要清掉。
3. 前端 `build()` 的 switch、对应视图函数、`renderKey()`、`bind()`、`onState()` 的重置逻辑;默契挑战的实时提交状态走 `syncMatchLive()`。
4. 结算路径:`settlePig()` / `settleMole()` / `finishMatch()`,以及 `again` / `reset` 的状态清理(注意 `again` 保留模式、`reset` 重置模式)。
5. 匿名与身份泄露检查:投票人、卧底、原词、历史描述、默契挑战当前轮未揭晓的词。
6. 新增限制卡规则时同步改 `rules.js` 的 `check`,并补充正反例测试。
7. 人数限制同时写在 join 和 start 两处:传声筒 3–8,默契挑战 2–5;大厅切换模式时还要检查当前人数。
8. 新增游戏模式时同步处理:一级选游戏页的锁定、`POST /api/join` 的 `mode`、大厅切换,以及 `again` / `reset` 后的模式。
9. 新增按模式的选项时,`apiOptions` 用部分合并,前端按模式渲染对应开关,`renderKey` 的 `optionsKey` 要包含新字段。

样式优先复用 `.panel`、`.paper`、`.btn`、`.vote-opt`、`.count-row` 等现有类,保持纸张主题一致。
