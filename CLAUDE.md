# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

同一个网页里的两款派对小游戏,支持多房间:

- **传声筒**(3–8 人):描述接龙,看一句话能跑多歪。
- **默契挑战**(2–5 人):同一主题同时写词,直到全员同词。

服务端只用 Node.js 内置模块,前端是原生 HTML/CSS/JS,零依赖、无构建步骤。规则见 `README.md`。每个房间有独立的状态、计时器和 SSE 客户端,房间之间完全隔离。

`docs/默契挑战-规则草案.md` 是默契挑战的设计记录;实际行为以代码为准。

## 房间模型

- 房间码由创建者自定义,**必须是 6 位数字**,全服务器唯一;最多同时存在 **50 间房**。
- 创建房间只填房间码和名字,进入大厅后再由房主选游戏(默认 `chain`)。
- 加入房间:
  - 房间在大厅 → 成为普通玩家。
  - 游戏已经开始 → 进入**旁观模式**,不占玩家席位;本局结束后可以在大厅点「加入这一桌」转为玩家。
- 最后一名玩家离开(宽限期结束)或房主清空牌桌后,房间被删除并释放房间码;房间码之后可以复用。
- 房间码和网页地址都不是密码;拿到的人都能加入/旁观。

## 命令

```bash
node server.js                 # 启动,默认 http://localhost:3000
PORT=4000 node server.js       # 换端口
npm start                      # 等价于 node server.js
node --check server.js && node --check room.js && node --check rules.js && node --check public/app.js

# 调试用:缩短回合计时和断线宽限期
TURN_SECONDS=5 DISCONNECT_GRACE_MS=2000 node server.js

# 默契挑战:每轮 5 秒,揭晓停留 2 秒
MATCH_SECONDS=5 MATCH_REVEAL_SECONDS=2 node server.js
```

默认值:传声筒每棒 60 秒;默契挑战每轮 40 秒,揭晓页停留 8 秒;断线宽限 5 分钟。服务器跑在本机时,合盖/系统睡眠会暂停整个服务;长时间开桌可以用 `caffeinate -dimsu node server.js`。

仓库没有自动化测试、lint 或构建配置。改动后需要启动服务,用多个浏览器窗口验证。注意同一浏览器的多个标签共享 localStorage 身份,模拟多人要用普通窗口 + 无痕窗口 + 另一浏览器。

至少覆盖:建房/加入、房间码唯一、6 位校验、6 人不能进默契挑战、房间之间状态隔离、旁观、空房回收与房间码复用、50 间上限、最后一人离开删除房间。

`rules.js` 是纯函数模块,改判定规则时可以直接用一次性 Node 脚本调用 `findRestriction(id).check(text)` 和 `containsTarget()` 覆盖正反例,再启动服务走一遍完整对局。

## 架构

### 房间管理(server.js)

单进程、多房间、纯内存。`rooms` 是 `房间码 -> room 实例` 的 Map;服务器重启清空所有房间。

- `POST /api/room/create` `{ code, name }`:校验 6 位数字、房间码唯一、50 间上限,创建 `room.js` 实例并加入房主。
- `POST /api/room/join` `{ code, name }`:房间不存在 → 404;大厅 → 加玩家;非大厅 → 返回 `{ spectator: true }`。
- 其余 `/api/*` 通过 `data.pid` 找到房间,再调用 `room.handleAction(path, data, res)`;找不到房间返回 403。
- `GET /events?pid=&room=`:优先用 pid 找房间;没有 pid 时用房间码连接旁观。找不到房间时发送一次 `{ noRoom: true }` 并结束 SSE。
- `deleteRoom(room)` 从 Map 删除并调用 `room.destroy()`;房间销毁时向所有 SSE 客户端发送 `noRoom`。

### 单房引擎(room.js)

`createRoom(code, { onDelete })` 返回 `{ code, game, addPlayer, hasPlayer, handleEvents, handleAction, destroy, viewFor, clients }`。

- 每个房间有自己的 `game`、`clients`(res → `{ pid }`,pid 为空表示旁观)、`turnTimer`、`matchTimer`、`pendingRemoval`、`abandonTimer` 和 `destroyed`。
- 房间内所有对局函数都操作本房间的 `game`;不要把状态重新放回模块级全局变量。
- `addPlayer(name)` 负责生成 pid,并在没有房主时把第一个玩家设为房主。
- `onDelete` 由 server.js 传入;`requestDelete()` 只回调,不直接删 Map。
- `checkEmpty()`:玩家数为 0 时请求删除。`checkAbandoned()`:没有在线玩家时启动一个宽限期计时,到期仍无在线玩家则请求删除,避免全掉线的游戏房永久占用房间码。
- `destroy()` 清空所有计时器、通知客户端 `noRoom`、关闭本地 SSE 客户端;之后 `destroyed` 为真,定时器回调都要先检查它。
- `viewFor(pid)` 包含 `roomCode` 和 `spectator`;玩家视图和旁观视图共用,但敏感字段按身份裁剪。

### 状态与阶段

每个房间独立经历:

```
传声筒:  lobby → playing → vote → (molevote) → result → lobby
默契挑战:lobby → match(input ⇄ reveal) → matchresult → lobby
```

- `game.mode` 是 `chain` / `match`;创建后默认 `chain`,房主在大厅通过 `/api/mode` 切换。已有超过 5 人时不能切到默契挑战。
- `game.order`、`game.step`、`game.options`、`game.hostId` 都是房间内的状态。
- `game.options.theme`(默认 `true`)决定默契挑战是否指定主题;关闭时 `game.match.theme = ''`。
- 主题题库在 `data/themes.json`;`loadMatchThemes()` 每局开局读取,改文件后下一局生效,无需重启。文件缺失/损坏时回退到 `DEFAULT_MATCH_THEMES`。
- `game.match` 保存默契挑战的 `theme`、`round`、`stage`、`submissions`、`sources`、`history`、`result`。
- 默契挑战判同:所有非离线参与者都有非空词,`normalize()` 后完全相等,至少 2 名参与者;允许重复自己上一轮的词。
- 一局只结算一次;称号按 `history.length`。房主可随时 `/api/match-end` 收场,当前未揭晓的一轮不计入。

### 回合计时与在线状态

- 传声筒用房间自己的 `turnTimer`;`startTurnTimer()` 设置 `game.deadline`,`autoSubmitTurn()` 超时推进。
- 默契挑战用房间自己的 `matchTimer`;`scheduleMatchTimer()` 覆盖输入/揭晓两个阶段,`clearMatchTimer()` 在结束、重开、销毁时调用。
- 在线状态由本房间的 SSE 客户端统计(`isOnline(pid)`);`onlinePlayers()` 只统计本房间玩家。
- 断线后 `DISCONNECT_GRACE_MS`(默认 5 分钟)内重连会取消移除;`scheduleRemoval()` 带睡眠保护,定时器明显延迟时重新计时。
- 大厅里离线玩家超时会被移出并顺延房主;游戏中保留席位,传声筒靠 60 秒超时推进,默契挑战本轮弃权。
- 房主可在大厅 `/api/kick-offline` 手动移出离线玩家;没有玩家在线时 `checkAbandoned()` 也会回收房间。
- 前端断线显示 `.conn-banner`;名字存 `tt_name`,房间码存 `tt_room`,旁观标记存 `tt_spectator`。

### 视图与隐私

`viewFor(pid)` 是全项目最重要的不变量:

- 玩家身份只通过 `me` 返回给本人;卧底只通过 `isMole` 返回给本人,公开 `mole` 只在 result 阶段出现。
- 传声筒 playing 阶段只有当前玩家拿到 `turn`(上一棒描述、限制卡);旁观者不拿描述,只拿 `currentPlayer` / `step` / `turnTimeLeft` 等公开进度。
- vote / molevote / result 的完整链路对玩家和旁观者都公开(这是揭晓阶段);投票明细 `myVote` / `myMoleVote` 只给本人,旁观者为 null。
- 默契挑战 input 阶段只有本人拿 `match.myWord`;别人的词只以 `players[].submitted` 存在。完整 `match.history` 只包含已揭晓轮次;旁观者拿到主题、轮次、已提交计数和历史,但拿不到本轮未揭晓的词。
- matchresult / result 的公开结果可以发给旁观者;结果页对旁观者隐藏「再来一局」。
- 房间之间绝不共享 `game`、`clients`、计时器或投票数据;所有广播只发给本房间客户端。

### 服务端接口

- 建房/加入:`/api/room/create`、`/api/room/join`。
- 房间内:`start` / `options` / `mode`;`submit` / `guess`;`match-submit` / `match-end`;`vote` / `finish-vote` / `mole-vote` / `finish-mole-vote`;`again` / `reset` / `kick-offline`。
- `again` 保留房间和房间码;`reset` 删除整个房间(房主清空牌桌)。
- `POST /api/options` 做部分合并,默契挑战只传 `theme` 时不会清掉传声筒选项。

### 前端

- 未进房间时渲染 `entryView()`:创建/加入两个页签,房间码 6 位数字 + 名字。创建成功/加入成功后才建立 SSE;旁观用房间码连接(没有 pid)。
- 大厅显示房间码;房主用 `.mode-card` 切换游戏,其他玩法开关按模式显示。
- 收到 `{ noRoom: true }` 时 `resetToEntry()`:清空 pid/房间码/旁观标记,关闭 SSE,回到入口页。
- 旁观视图:
  - 大厅:`spectatorLobbyView()`,可点「加入这一桌」转为玩家。
  - 传声筒 playing:`spectatorChainPlayingView()` 只显示进度;vote/molevote/result 用公开链路和结果。
  - 默契挑战:input 显示主题/提交计数/上一轮;reveal 显示本轮词;matchresult 显示公开结果。
  - 旁观者的结果页不显示「再来一局」。
- `renderKey()` 包含 `roomCode`、`spectator`、`phase`、`mode`、`entryTab` 等;倒计时剩余时间绝不能进 key。玩家输入期间别人的在线/提交状态由 `syncMatchLive()` 轻量更新。
- `render()` 重建前用 `captureInputDrafts()` / `restoreInputDrafts()` 保存输入;入口页的 `entryCode` / `entryName` 的草稿优先于默认回填的名字。
- 身份存 `tt_pid`,房间码存 `tt_room`,旁观标记存 `tt_spectator`,名字存 `tt_name`;刷新后按这些恢复连接。
- 所有玩家/旁观者输入在插入模板前必须经过 `esc()`。
- 样式在 `public/style.css`,复古档案纸 + 朱红印章,颜色和字体集中在 `:root` 变量;移动优先。

## 改功能时的连锁点

1. 每个房间的状态/计时器/客户端都在 `room.js`;不要在 `server.js` 里新增全局游戏状态。
2. 新增房间生命周期行为时同步考虑:创建、加入、旁观、删除、房间码复用、50 间上限、`noRoom` 通知。
3. 新增对局阶段或玩法时同步改 `room.js` 的 phase/校验、`viewFor` 的玩家/旁观者可见性、阶段切换的数据重置。
4. 前端同步改 `build()`、`entryView`/`spectatorView`、`renderKey()`、`bind()`、`onState()`、`focusFor()`;旁观和玩家共用视图时注意按钮权限。
5. 结算路径:`settlePig()` / `settleMole()` / `finishMatch()`,以及 `again`(保留房间)/ `reset`(删除房间)的清理。
6. 匿名与泄露检查:投票人、卧底、原词、历史描述、默契挑战当前轮未揭晓的词、旁观者可见范围。
7. 人数限制同时写在房间加入和开局两处:传声筒 3–8,默契挑战 2–5;切换模式时检查当前人数。
8. 新增限制卡规则时同步改 `rules.js` 的 `check`;新增模式选项时 `apiOptions` 做部分合并,`renderKey` 的 `optionsKey` 加字段。

样式优先复用 `.panel`、`.paper`、`.btn`、`.vote-opt`、`.count-row` 等现有类,保持纸张主题一致。
