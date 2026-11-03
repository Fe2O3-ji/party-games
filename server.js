#!/usr/bin/env node
'use strict';

/**
 * 传声筒 / 默契挑战 —— 派对小游戏
 * 零依赖:Node 内置 http + SSE 实时推送
 *
 * 启动:node server.js
 * 端口:默认 3000,可用 PORT 环境变量覆盖
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const {
  RESTRICTIONS,
  findRestriction,
  restrictionText,
  containsTarget,
  normalize,
} = require('./rules');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, 'public');

// 每棒限时(秒);断线后保留多久再移出牌桌(毫秒)
const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 60;
const TURN_MS = TURN_SECONDS * 1000;

// 默认给 5 分钟:合盖、锁屏、切网会短暂断开 SSE,不应该立刻把人踢出房间。
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 5 * 60 * 1000;

// 默契挑战:每轮限时、揭晓后停留多久进入下一轮(秒)
const MATCH_SECONDS = Number(process.env.MATCH_SECONDS) || 40;
const MATCH_REVEAL_SECONDS = Number(process.env.MATCH_REVEAL_SECONDS) || 8;
const MATCH_MS = MATCH_SECONDS * 1000;
const MATCH_REVEAL_MS = MATCH_REVEAL_SECONDS * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// 游戏状态(单房间,内存保存;服务器重启即清空)
// ---------------------------------------------------------------------------

const CATEGORIES = [
  '食物', '动物', '职业', '日用品', '交通工具',
  '影视作品', '网络流行语', '运动', '地点', '情绪',
];

// 默契挑战的起始主题:第一轮大家凭第一反应写词。
// 实际题库在 data/themes.json,每局开局时重新读取,改文件后下一局生效,不用重启服务。
const DEFAULT_MATCH_THEMES = [
  '夏天', '旅行', '红色', '雨天', '深夜', '学校', '厨房', '海边',
  '童年', '周末', '城市', '运动会', '便利店', '火锅', '音乐', '猫',
  '下班路上', '冬天', '第一次见面', '游乐园', '电影', '迟到',
  '早餐', '搬家', '散步', '节日',
];
const THEMES_FILE = path.resolve(__dirname, 'data', 'themes.json');

function loadMatchThemes() {
  try {
    const list = JSON.parse(fs.readFileSync(THEMES_FILE, 'utf8'));
    if (Array.isArray(list)) {
      const themes = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
      if (themes.length) return themes;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[themes] 读取 data/themes.json 失败,使用内置题库:', err.message);
    }
  }
  return DEFAULT_MATCH_THEMES;
}

const game = {
  phase: 'lobby',   // lobby | playing | vote | molevote | result | match | matchresult
  mode: 'chain',    // chain(传声筒) | match(默契挑战)
  roundNo: 1,
  hostId: null,     // 房主:第一个入座的人
  options: {        // 房主开局前勾选的花样玩法
    mole: false,
    restriction: false,
    category: false,
    history: false,
    theme: true,    // 默契挑战:是否由系统指定主题
  },
  players: [],      // { id, name }
  order: [],        // 本局随机棒次,存 playerId
  step: 0,          // 当前轮到 order[step]
  turns: [],        // 每棒 { playerId, guess, description }
  originalWord: '', // 第一棒想的原词,揭晓前绝不外泄
  moleId: null,     // 卧底棒:被指定带偏的人
  restrictions: [], // 限制卡:与每个描述者一一对应
  category: '',     // 类别词库:本局限定类别
  votes: {},        // 最猪投票:voterId -> targetId
  moleVotes: {},    // 猜卧底投票:voterId -> targetId(卧底不能投)
  result: null,
  deadline: null,   // 当前棒的截止时间戳
  pendingGuess: null, // 中间玩家已锁定、还没写描述的猜测
  match: null,      // 默契挑战的局内状态,见 startMatch()
};

let turnTimer = null;
let turnSeq = 0;
let matchTimer = null;
let matchSeq = 0;
const pendingRemoval = new Map(); // pid -> 断线宽限定时器

const clients = new Map(); // res -> { pid }

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 清洗用户输入:去控制字符、去首尾空白、截断长度
function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

const isPlayer = (pid) => game.players.some((p) => p.id === pid);

function nameOf(pid) {
  const p = game.players.find((x) => x.id === pid);
  return p ? p.name : '';
}

// 最后一棒是否一字不差地猜回了第一棒的原词(忽略空格、标点、大小写)
function isPerfectChain() {
  if (!game.originalWord || !game.turns.length) return false;
  const last = game.turns[game.turns.length - 1];
  if (!last || !last.guess) return false;
  return normalize(game.originalWord) === normalize(last.guess);
}

function isOnline(pid) {
  if (!pid) return false;
  for (const meta of clients.values()) {
    if (meta.pid === pid) return true;
  }
  return false;
}

function onlinePlayers() {
  return game.players.filter((p) => isOnline(p.id));
}

// ---------------------------------------------------------------------------
// 回合计时
// ---------------------------------------------------------------------------

function clearTurnTimer() {
  turnSeq += 1;
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  game.deadline = null;
}

function startTurnTimer() {
  clearTurnTimer();
  if (game.phase !== 'playing') return;

  const seq = ++turnSeq;
  game.deadline = Date.now() + TURN_MS;
  turnTimer = setTimeout(() => autoSubmitTurn(seq), TURN_MS);
}

// 超时:用已锁定的猜测、占位描述自动把这一棒传下去
function autoSubmitTurn(seq) {
  if (seq !== turnSeq) return;
  turnTimer = null;
  if (game.phase !== 'playing') return;

  const index = game.step;
  const pid = game.order[index];
  if (!pid) return;

  const first = index === 0;
  const last = index === game.order.length - 1;

  if (first) {
    game.originalWord = '超时';
    game.turns.push({
      playerId: pid,
      guess: null,
      description: '(超时,没有交描述)',
    });
  } else {
    const pending = game.pendingGuess;
    const guess = pending && pending.playerId === pid && pending.guess ? pending.guess : '超时';
    game.turns.push({
      playerId: pid,
      guess,
      description: last ? null : '(超时,没有交描述)',
    });
  }

  game.pendingGuess = null;
  game.deadline = null;

  if (last) {
    game.phase = 'vote';
    game.votes = {};
    game.moleVotes = {};
    game.step = game.order.length - 1;
  } else {
    game.step = index + 1;
    startTurnTimer();
  }

  broadcast();
}

// ---------------------------------------------------------------------------
// 默契挑战:同时猜词,直到全员同词或房主收场
// ---------------------------------------------------------------------------

function clearMatchTimer() {
  matchSeq += 1;
  if (matchTimer) {
    clearTimeout(matchTimer);
    matchTimer = null;
  }
  if (game.match) game.match.deadline = null;
}

// 默契挑战只用一个计时器:输入阶段到点自动收卷,揭晓阶段到点进入下一轮
function scheduleMatchTimer(ms, fn) {
  clearMatchTimer();
  const seq = ++matchSeq;
  if (game.match) game.match.deadline = Date.now() + ms;
  matchTimer = setTimeout(() => {
    if (seq !== matchSeq) return;
    matchTimer = null;
    fn();
  }, ms);
}

function matchRating(rounds) {
  if (rounds <= 1) return '心有灵犀';
  if (rounds === 2) return '默契十足';
  if (rounds <= 4) return '脑回路接近';
  return '终于走到一起';
}

function startMatch() {
  // 房主可以关掉「指定主题」,关掉后第一轮完全自由起手
  let theme = '';
  if (game.options.theme) {
    const themes = loadMatchThemes();
    theme = themes[Math.floor(Math.random() * themes.length)];
  }

  game.match = {
    theme,
    round: 1,
    stage: 'input',   // input | reveal | result
    deadline: null,
    submissions: {},  // pid -> 本轮提交的词(揭晓前不下发给别人)
    sources: {},      // pid -> submit | carry | missed
    history: [],      // [{ round, words: [{ playerId, name, word, source }] }]
    result: null,
  };

  game.phase = 'match';
  game.step = 0;
  game.order = [];
  game.turns = [];
  game.originalWord = '';
  game.moleId = null;
  game.restrictions = [];
  game.category = '';
  game.votes = {};
  game.moleVotes = {};
  game.result = null;
  game.pendingGuess = null;

  scheduleMatchTimer(MATCH_MS, autoMatchRound);
}

// 当前轮里某个玩家最近的可用词(上一轮)
function previousMatchWord(pid) {
  const m = game.match;
  if (!m) return '';
  const prev = m.history[m.history.length - 1];
  if (!prev) return '';
  const entry = prev.words.find((w) => w.playerId === pid && w.word);
  return entry ? entry.word : '';
}

// 超时:在线但没交卷的人沿用自己上一轮的词;第一轮没有旧词则记未答
function autoMatchRound() {
  if (game.phase !== 'match' || !game.match || game.match.stage !== 'input') return;

  const m = game.match;
  for (const p of game.players) {
    if (!isOnline(p.id) || m.sources[p.id] === 'submit') continue;
    const prevWord = previousMatchWord(p.id);
    if (prevWord) {
      m.submissions[p.id] = prevWord;
      m.sources[p.id] = 'carry';
    } else {
      m.sources[p.id] = 'missed';
    }
  }

  endMatchRound('timeout');
}

// 在线玩家全部交卷就提前揭晓
function maybeEndMatchRound() {
  if (game.phase !== 'match' || !game.match || game.match.stage !== 'input') return false;

  const m = game.match;
  const online = onlinePlayers();
  if (!online.length) return false;
  if (!online.every((p) => m.sources[p.id] === 'submit')) return false;

  endMatchRound('all');
  return true;
}

function endMatchRound(reason) {
  const m = game.match;
  if (!m || m.stage !== 'input') return;

  clearMatchTimer();

  const onlineIds = new Set(onlinePlayers().map((p) => p.id));
  const words = game.players.map((p) => {
    const source = m.sources[p.id];
    if (source === 'submit') {
      return { playerId: p.id, name: p.name, word: m.submissions[p.id] || '', source: 'submit' };
    }
    if (source === 'carry') {
      return { playerId: p.id, name: p.name, word: m.submissions[p.id] || '', source: 'carry' };
    }
    if (source === 'missed' || onlineIds.has(p.id)) {
      return { playerId: p.id, name: p.name, word: '', source: 'missed' };
    }
    return { playerId: p.id, name: p.name, word: '', source: 'offline' };
  });

  // 离线且没交卷的人本轮弃权,不参与判同;在线的人必须交出非空词
  const participants = words.filter((w) => w.source !== 'offline');
  const allAnswered = participants.length >= 2 && participants.every((w) => w.word);
  const firstWord = participants.length ? normalize(participants[0].word) : '';
  const matched = allAnswered
    && participants.every((w) => normalize(w.word) === firstWord);

  m.history.push({ round: m.round, words });

  if (matched) {
    m.stage = 'result';
    finishMatch('matched', true);
    return;
  }

  // 在线人数不足 2 人,这局没法继续
  if (onlineIds.size < 2) {
    m.stage = 'result';
    finishMatch('players', false);
    return;
  }

  m.stage = 'reveal';
  scheduleMatchTimer(MATCH_REVEAL_MS, startNextMatchRound);
  broadcast();
}

function startNextMatchRound() {
  const m = game.match;
  if (game.phase !== 'match' || !m || m.stage !== 'reveal') return;

  m.round += 1;
  m.stage = 'input';
  m.submissions = {};
  m.sources = {};
  scheduleMatchTimer(MATCH_MS, autoMatchRound);
  broadcast();
}

function finishMatch(reason, matched) {
  const m = game.match;
  if (!m) return;

  clearMatchTimer();

  const rounds = m.history.length;
  m.result = {
    reason,                    // matched | host | players
    matched: !!matched,
    theme: m.theme,
    rounds,
    rating: matched ? matchRating(rounds) : '各想各的',
    history: m.history.map((r) => ({
      round: r.round,
      words: r.words.map((w) => ({ ...w })),
    })),
  };
  m.stage = 'result';
  game.phase = 'matchresult';
  broadcast();
}

// ---------------------------------------------------------------------------
// 断线处理
// ---------------------------------------------------------------------------

function scheduleRemoval(pid) {
  if (!pid || !isPlayer(pid) || pendingRemoval.has(pid)) return;

  const scheduledAt = Date.now();
  const timer = setTimeout(() => {
    pendingRemoval.delete(pid);

    // 电脑睡眠时 Node 的定时器也会暂停,醒来后可能一次性触发。
    // 如果实际过去的时间明显超过宽限期,说明刚才不是真的离开,重新给一个宽限期,
    // 让浏览器有机会完成重连。
    if (Date.now() - scheduledAt > DISCONNECT_GRACE_MS + 60000) {
      scheduleRemoval(pid);
      return;
    }

    removeOfflinePlayer(pid);
  }, DISCONNECT_GRACE_MS);

  pendingRemoval.set(pid, timer);
}

function removeOfflinePlayer(pid) {
  if (isOnline(pid)) return;

  const player = game.players.find((p) => p.id === pid);
  if (!player) return;

  // 只在大厅移除;游戏中保留席位,靠回合超时继续推进
  if (game.phase === 'lobby') {
    game.players = game.players.filter((p) => p.id !== pid);
    if (game.hostId === pid) {
      game.hostId = game.players.length ? game.players[0].id : null;
    }
    broadcast();
  }
}

function cleanupOfflinePlayers(keepId) {
  game.players = game.players.filter((p) => p.id === keepId || isOnline(p.id));
  if (!game.players.some((p) => p.id === game.hostId)) {
    game.hostId = game.players.length ? game.players[0].id : null;
  }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 视图:每个玩家看到的私有状态
// ---------------------------------------------------------------------------

function viewFor(pid) {
  const me = game.players.find((p) => p.id === pid) || null;

  const view = {
    phase: game.phase,
    mode: game.mode,
    roundNo: game.roundNo,
    hostId: game.hostId,
    options: { ...game.options },
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      online: isOnline(p.id),
    })),
    order: game.order.map(nameOf),
    step: game.step,
    me: me ? { id: me.id, name: me.name } : null,
    isHost: !!(me && game.hostId === me.id),
    turnSeconds: TURN_SECONDS,
    matchSeconds: MATCH_SECONDS,
  };

  // 卧底只让本人知道(整局都保持)
  if (me && game.moleId && game.moleId === me.id && game.phase !== 'lobby') {
    view.isMole = true;
  }

  if (game.phase === 'playing') {
    const currentId = game.order[game.step];
    view.currentPlayer = nameOf(currentId);
    view.currentPlayerOnline = isOnline(currentId);
    view.turnTimeLeft = game.deadline ? Math.max(0, game.deadline - Date.now()) : null;
    if (game.category) view.category = game.category;

    // 已传过话的人(如果房主开启)可以回看历史
    if (game.options.history && me) {
      const myIndex = game.order.indexOf(me.id);
      if (myIndex >= 0 && myIndex < game.step) {
        view.history = game.turns.slice(0, game.step).map((t, i) => ({
          index: i,
          player: nameOf(game.order[i]),
          guess: t.guess,
          description: t.description,
        }));
      }
    }

    // 只有当前轮到的玩家能看到上一棒的描述
    if (me && currentId === me.id) {
      const first = game.step === 0;
      const last = game.step === game.order.length - 1;
      const prevTurn = game.step > 0 ? game.turns[game.step - 1] : null;
      view.turn = {
        index: game.step,
        total: game.order.length,
        first,
        last,
        prevDescription: prevTurn ? prevTurn.description : null,
        prevPlayer: prevTurn ? nameOf(prevTurn.playerId) : null,
      };

      // 限制卡:只发给当前描述者
      if (!last && game.options.restriction) {
        view.turn.restriction = restrictionText(game.restrictions[game.step]);
      }
    }
  }

  if ((game.phase === 'vote' || game.phase === 'molevote' || game.phase === 'result') && me) {
    // 揭晓后才把完整链路发给参与者
    view.originalWord = game.originalWord;
    view.perfect = isPerfectChain();
    view.category = game.category || '';
    view.turns = game.turns.map((t, i) => ({
      player: nameOf(game.order[i]),
      playerId: game.order[i],
      guess: t.guess,
      description: t.description,
      restriction: game.options.restriction && i < game.order.length - 1
        ? restrictionText(game.restrictions[i])
        : null,
    }));

    // 卧底身份要等最终结果页才公开
    if (game.phase === 'result') {
      view.mole = game.moleId ? { id: game.moleId, name: nameOf(game.moleId) } : null;
    }

    if (game.phase === 'vote') {
      view.myVote = game.votes[pid] || null;
      view.votesCount = Object.keys(game.votes).length;
    }

    if (game.phase === 'molevote') {
      view.hasMole = !!game.moleId;
      view.myMoleVote = game.moleVotes[pid] || null;
      view.moleVotesCount = Object.keys(game.moleVotes).length;
      view.moleVotersCount = game.players.filter((p) => p.id !== game.moleId).length;
    }
  }

  if (game.phase === 'result' && me) {
    view.result = game.result;
  }

  // 默契挑战:本轮提交的词只回给本人,别人只能看到「已提交」
  if (game.phase === 'match' && me && game.match) {
    const m = game.match;
    const onlineIds = new Set(onlinePlayers().map((p) => p.id));
    const publicHistory = m.history.map((r) => ({
      round: r.round,
      words: r.words.map((w) => ({ ...w })),
    }));

    view.match = {
      theme: m.theme,
      round: m.round,
      stage: m.stage,
      timeLeft: m.deadline ? Math.max(0, m.deadline - Date.now()) : null,
      matchSeconds: MATCH_SECONDS,
      revealSeconds: MATCH_REVEAL_SECONDS,
      onlineCount: onlineIds.size,
      submittedCount: Object.keys(m.sources)
        .filter((id) => m.sources[id] === 'submit' && onlineIds.has(id)).length,
      players: game.players.map((p) => ({
        id: p.id,
        name: p.name,
        online: onlineIds.has(p.id),
        submitted: m.sources[p.id] === 'submit',
      })),
      myWord: m.sources[me.id] === 'submit' ? (m.submissions[me.id] || '') : '',
      history: publicHistory,
    };

    if (m.stage === 'reveal') {
      view.match.reveal = publicHistory.length
        ? publicHistory[publicHistory.length - 1]
        : null;
    }
  }

  if (game.phase === 'matchresult' && me && game.match && game.match.result) {
    const r = game.match.result;
    view.match = {
      theme: r.theme,
      matched: r.matched,
      rating: r.rating,
      reason: r.reason,
      rounds: r.rounds,
      history: r.history.map((round) => ({
        round: round.round,
        words: round.words.map((w) => ({ ...w })),
      })),
    };
  }

  return view;
}

// ---------------------------------------------------------------------------
// SSE 广播
// ---------------------------------------------------------------------------

function broadcast() {
  for (const [res, meta] of clients) {
    try {
      res.write(`data: ${JSON.stringify(viewFor(meta.pid))}\n\n`);
    } catch (err) {
      clients.delete(res);
    }
  }
}

function handleEvents(req, res, url) {
  const pid = url.searchParams.get('pid') || '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  clients.set(res, { pid });

  // 重新连上:取消待移除
  if (pid) {
    const pending = pendingRemoval.get(pid);
    if (pending) {
      clearTimeout(pending);
      pendingRemoval.delete(pid);
    }
  }

  res.write(`data: ${JSON.stringify(viewFor(pid))}\n\n`);

  if (pid && isPlayer(pid)) broadcast();

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      /* 连接已断,等 close 清理 */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);

    // 这个玩家已经没有连接了:标记离线,宽限期后移出大厅
    if (pid && isPlayer(pid) && !isOnline(pid)) {
      broadcast();
      scheduleRemoval(pid);
    }
  });
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

function apiJoin(res, data) {
  if (game.phase !== 'lobby') {
    return json(res, 409, { ok: false, error: '游戏已经开始了,等下一局吧' });
  }
  const name = clean(data.name, 12);
  if (!name) {
    return json(res, 400, { ok: false, error: '先起个名字' });
  }

  const requestedMode = data.mode === 'match' || data.mode === 'chain' ? data.mode : null;

  // 空房间:第一位入座的人在选游戏界面选的那款就是本房间的游戏
  if (!game.players.length && requestedMode) {
    game.mode = requestedMode;
  }

  // 房间已经有人时游戏由房间决定,客户端选错模式会被拒绝
  if (game.players.length && requestedMode && requestedMode !== game.mode) {
    return json(res, 409, {
      ok: false,
      error: `房间已经在玩「${game.mode === 'match' ? '默契挑战' : '传声筒'}」,请返回重新选择`,
    });
  }

  const cap = game.mode === 'match' ? 5 : 8;
  if (game.players.length >= cap) {
    return json(res, 409, {
      ok: false,
      error: game.mode === 'match' ? '默契挑战最多 5 人,人满了' : '人满了(最多 8 人)',
    });
  }
  if (game.players.some((p) => p.name === name)) {
    return json(res, 409, { ok: false, error: '这个名字有人用了,换一个' });
  }

  const id = crypto.randomUUID();
  game.players.push({ id, name });
  if (!game.hostId) game.hostId = id; // 第一个入座的人是房主
  broadcast();
  json(res, 200, { ok: true, pid: id });
}

function apiStart(res, data) {
  if (game.phase !== 'lobby') {
    return json(res, 409, { ok: false, error: '已经开局了' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }
  if (game.hostId !== data.pid) {
    return json(res, 403, { ok: false, error: '只有房主能开局' });
  }

  if (game.mode === 'match') {
    if (game.players.length < 2) {
      return json(res, 400, { ok: false, error: '至少 2 人才能开局' });
    }
    if (game.players.length > 5) {
      return json(res, 400, { ok: false, error: '默契挑战最多 5 人' });
    }
    if (onlinePlayers().length < 2) {
      return json(res, 400, { ok: false, error: '至少 2 人在线才能开局' });
    }

    clearTurnTimer();
    startMatch();
    broadcast();
    return json(res, 200, { ok: true });
  }

  if (game.players.length < 3) {
    return json(res, 400, { ok: false, error: '至少 3 人才能开局' });
  }
  if (game.players.length > 8) {
    return json(res, 400, { ok: false, error: '最多 8 人' });
  }

  clearMatchTimer();
  game.match = null;
  game.order = shuffle(game.players.map((p) => p.id));
  game.step = 0;
  game.turns = [];
  game.originalWord = '';
  game.votes = {};
  game.moleVotes = {};
  game.result = null;
  game.moleId = null;
  game.restrictions = [];
  game.category = '';

  // 类别词库:开局随机一个类别,第一棒必须在此类别里想词
  if (game.options.category) {
    game.category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  }

  // 限制卡:为每位描述者(除最后一棒)抽一条限制
  if (game.options.restriction) {
    const describers = game.order.length - 1;
    for (let i = 0; i < describers; i++) {
      game.restrictions.push(RESTRICTIONS[Math.floor(Math.random() * RESTRICTIONS.length)].id);
    }
  }

  // 卧底棒:在中间的描述者里随机挑一个带偏
  if (game.options.mole) {
    const candidates = game.order.slice(1, game.order.length - 1);
    if (candidates.length) {
      game.moleId = candidates[Math.floor(Math.random() * candidates.length)];
    }
  }

  game.phase = 'playing';
  game.pendingGuess = null;
  startTurnTimer();

  broadcast();
  json(res, 200, { ok: true });
}

function apiOptions(res, data) {
  if (game.phase !== 'lobby') {
    return json(res, 409, { ok: false, error: '开局后不能改玩法' });
  }
  if (game.hostId !== data.pid) {
    return json(res, 403, { ok: false, error: '只有房主能改玩法' });
  }

  // 允许只传一项(默契挑战的主题开关),其余保持原样
  const o = data.options || {};
  const next = { ...game.options };
  for (const key of ['mole', 'restriction', 'category', 'history', 'theme']) {
    if (o[key] !== undefined) next[key] = !!o[key];
  }
  game.options = next;

  broadcast();
  json(res, 200, { ok: true });
}

// 房主在大厅切换小游戏
function apiMode(res, data) {
  if (game.phase !== 'lobby') {
    return json(res, 409, { ok: false, error: '开局后不能换游戏' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }
  if (game.hostId !== data.pid) {
    return json(res, 403, { ok: false, error: '只有房主能选游戏' });
  }

  const mode = data.mode === 'match' ? 'match' : 'chain';
  if (mode === 'match' && game.players.length > 5) {
    return json(res, 409, {
      ok: false,
      error: `默契挑战最多 5 人,现在有 ${game.players.length} 人,请先让多余的人离开`,
    });
  }

  game.mode = mode;
  game.match = null;
  clearMatchTimer();
  broadcast();
  json(res, 200, { ok: true });
}

function apiSubmit(res, data) {
  if (game.phase !== 'playing') {
    return json(res, 409, { ok: false, error: '现在不能提交' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }

  const index = game.step;
  if (game.order[index] !== data.pid) {
    return json(res, 409, { ok: false, error: '还没轮到你' });
  }

  const first = index === 0;
  const last = index === game.order.length - 1;

  if (first) {
    // 第一棒:想词 + 描述
    const word = clean(data.word, 20);
    const description = clean(data.description, 200);
    if (!word || !description) {
      return json(res, 400, { ok: false, error: '词和描述都要填' });
    }
    if (containsTarget(description, word)) {
      return json(res, 400, { ok: false, error: `描述里不能出现原词「${word}」` });
    }
    const rule = findRestriction(game.restrictions[index]);
    if (rule && !rule.check(description)) {
      return json(res, 400, { ok: false, error: `本棒限制没满足:${rule.text}` });
    }
    game.originalWord = word;
    game.turns.push({ playerId: data.pid, guess: null, description });
  } else {
    // 其他棒:先猜;不是最后一棒的话还要描述
    const pending = game.pendingGuess && game.pendingGuess.playerId === data.pid
      ? game.pendingGuess.guess
      : '';
    const guess = clean(data.guess, 20) || pending;
    if (!guess) {
      return json(res, 400, { ok: false, error: '还没写你猜的词' });
    }
    const description = last ? null : clean(data.description, 200);
    if (!last && !description) {
      return json(res, 400, { ok: false, error: '描述不能空着' });
    }
    if (!last) {
      if (containsTarget(description, guess)) {
        return json(res, 400, { ok: false, error: `描述里不能出现你正在描述的词「${guess}」` });
      }
      const rule = findRestriction(game.restrictions[index]);
      if (rule && !rule.check(description)) {
        return json(res, 400, { ok: false, error: `本棒限制没满足:${rule.text}` });
      }
    }
    game.turns.push({ playerId: data.pid, guess, description });
  }

  game.pendingGuess = null;

  if (last) {
    // 最后一棒猜完,进入投票
    clearTurnTimer();
    game.phase = 'vote';
    game.votes = {};
    game.moleVotes = {};
    game.step = game.order.length - 1;
  } else {
    game.step = index + 1;
    startTurnTimer();
  }

  broadcast();
  json(res, 200, { ok: true });
}

// 中间玩家锁定猜测(描述还没写),用于超时兜底
function apiGuess(res, data) {
  if (game.phase !== 'playing') {
    return json(res, 409, { ok: false, error: '现在不能提交' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }

  const index = game.step;
  if (game.order[index] !== data.pid) {
    return json(res, 409, { ok: false, error: '还没轮到你' });
  }
  if (index === 0 || index === game.order.length - 1) {
    return json(res, 400, { ok: false, error: '这一棒不需要单独锁定猜测' });
  }

  const guess = clean(data.guess, 20);
  if (!guess) {
    return json(res, 400, { ok: false, error: '还没写你猜的词' });
  }

  game.pendingGuess = { playerId: data.pid, guess };
  json(res, 200, { ok: true });
}

// 默契挑战:交本轮自己的词
function apiMatchSubmit(res, data) {
  if (game.phase !== 'match' || !game.match) {
    return json(res, 409, { ok: false, error: '现在不是猜词时间' });
  }
  if (game.match.stage !== 'input') {
    return json(res, 409, { ok: false, error: '本轮已经揭晓,等下一轮' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }

  const m = game.match;
  if (m.sources[data.pid] === 'submit') {
    return json(res, 409, { ok: false, error: '你已经提交过了,提交后不能改' });
  }

  const word = clean(data.word, 20);
  if (!word) {
    return json(res, 400, { ok: false, error: '先写一个词' });
  }
  if (Array.from(word).length > 8) {
    return json(res, 400, { ok: false, error: '最多 8 个字' });
  }
  if (!normalize(word)) {
    return json(res, 400, { ok: false, error: '请写一个带文字的词' });
  }

  m.submissions[data.pid] = word;
  m.sources[data.pid] = 'submit';

  if (!maybeEndMatchRound()) broadcast();
  return json(res, 200, { ok: true });
}

// 房主随时结束本局;当前还没揭晓的那一轮不计入轨迹
function apiMatchEnd(res, data) {
  if (game.phase !== 'match' || !game.match) {
    return json(res, 409, { ok: false, error: '现在没有进行中的默契挑战' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }
  if (game.hostId !== data.pid) {
    return json(res, 403, { ok: false, error: '只有房主能结束本局' });
  }

  finishMatch('host', false);
  return json(res, 200, { ok: true });
}

function tallyVotes(voteMap) {
  const counts = new Map(game.players.map((p) => [p.id, 0]));
  for (const target of Object.values(voteMap)) {
    counts.set(target, (counts.get(target) || 0) + 1);
  }

  const max = Math.max(0, ...counts.values());
  return {
    max,
    top: game.players.filter((p) => counts.get(p.id) === max && max > 0),
    sorted: game.players
      .map((p) => ({ id: p.id, name: p.name, count: counts.get(p.id) || 0 }))
      .sort((a, b) => b.count - a.count),
    totalVotes: Object.keys(voteMap).length,
  };
}

// 最猪投票结算:卧底模式进入猜卧底环节,否则直接出结果
function settlePig() {
  const t = tallyVotes(game.votes);
  game.result = {
    winners: t.top.map((p) => ({ id: p.id, name: p.name })),
    counts: t.sorted,
    max: t.max,
    totalVotes: t.totalVotes,
    mole: null,
  };

  if (game.options.mole && game.moleId) {
    game.phase = 'molevote';
    game.moleVotes = {};
  } else {
    game.phase = 'result';
  }
}

// 猜卧底结算,同时公开真卧底
function settleMole() {
  const t = tallyVotes(game.moleVotes);
  game.result.mole = {
    votesCount: t.totalVotes,
    counts: t.sorted,
    max: t.max,
    guessed: t.top.map((p) => ({ id: p.id, name: p.name })),
    actual: { id: game.moleId, name: nameOf(game.moleId) },
    correct: t.top.some((p) => p.id === game.moleId),
  };
  game.phase = 'result';
}

function apiVote(res, data) {
  if (game.phase !== 'vote') {
    return json(res, 409, { ok: false, error: '现在不是投票时间' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }

  const target = String(data.targetId || '');
  if (!game.players.some((p) => p.id === target)) {
    return json(res, 400, { ok: false, error: '没有这个人' });
  }
  if (target === data.pid) {
    return json(res, 400, { ok: false, error: '不能投自己' });
  }
  if (game.votes[data.pid]) {
    return json(res, 409, { ok: false, error: '你已经投过了' });
  }

  game.votes[data.pid] = target;

  // 在线的人都投了,自动开奖;掉线的人不再阻塞
  const voters = onlinePlayers();
  if (voters.length && voters.every((p) => game.votes[p.id])) {
    settlePig();
  }

  broadcast();
  json(res, 200, { ok: true });
}

function apiFinishVote(res, data) {
  if (game.phase !== 'vote') {
    return json(res, 409, { ok: false, error: '现在不是投票时间' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }
  if (Object.keys(game.votes).length === 0) {
    return json(res, 400, { ok: false, error: '还没有人投票' });
  }

  settlePig();
  broadcast();
  json(res, 200, { ok: true });
}

function apiMoleVote(res, data) {
  if (game.phase !== 'molevote') {
    return json(res, 409, { ok: false, error: '现在不是猜卧底的时间' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }
  if (data.pid === game.moleId) {
    return json(res, 403, { ok: false, error: '你是卧底,不能投票' });
  }

  const target = String(data.targetId || '');
  if (!game.players.some((p) => p.id === target)) {
    return json(res, 400, { ok: false, error: '没有这个人' });
  }
  if (target === data.pid) {
    return json(res, 400, { ok: false, error: '不能投自己' });
  }
  if (game.moleVotes[data.pid]) {
    return json(res, 409, { ok: false, error: '你已经投过了' });
  }

  game.moleVotes[data.pid] = target;

  // 除卧底外的在线玩家都投了,自动开奖
  const voters = game.players.filter((p) => p.id !== game.moleId && isOnline(p.id));
  if (voters.length && voters.every((p) => game.moleVotes[p.id])) {
    settleMole();
  }

  broadcast();
  json(res, 200, { ok: true });
}

function apiFinishMoleVote(res, data) {
  if (game.phase !== 'molevote') {
    return json(res, 409, { ok: false, error: '现在不是猜卧底的时间' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }
  if (Object.keys(game.moleVotes).length === 0) {
    return json(res, 400, { ok: false, error: '还没有人投票' });
  }

  settleMole();
  broadcast();
  json(res, 200, { ok: true });
}

function apiAgain(res, data) {
  if (game.phase !== 'result' && game.phase !== 'matchresult') {
    return json(res, 409, { ok: false, error: '还没到这一步' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }

  clearTurnTimer();
  clearMatchTimer();
  game.match = null;
  game.pendingGuess = null;
  game.phase = 'lobby';
  game.roundNo += 1;
  game.order = [];
  game.step = 0;
  game.turns = [];
  game.originalWord = '';
  game.moleId = null;
  game.restrictions = [];
  game.category = '';
  game.votes = {};
  game.moleVotes = {};
  game.result = null;

  // 回到大厅时清掉已经离线的人,房主掉了就顺延
  cleanupOfflinePlayers(data.pid);

  broadcast();
  json(res, 200, { ok: true });
}

function apiReset(res, data) {
  if (game.phase !== 'lobby') {
    return json(res, 409, { ok: false, error: '游戏进行中不能清场' });
  }
  if (game.hostId !== data.pid) {
    return json(res, 403, { ok: false, error: '只有房主能清空牌桌' });
  }

  clearTurnTimer();
  clearMatchTimer();
  game.pendingGuess = null;
  for (const timer of pendingRemoval.values()) clearTimeout(timer);
  pendingRemoval.clear();

  game.players = [];
  game.hostId = null;
  game.mode = 'chain';
  game.match = null;
  game.options = { mole: false, restriction: false, category: false, history: false, theme: true };
  game.order = [];
  game.step = 0;
  game.turns = [];
  game.originalWord = '';
  game.moleId = null;
  game.restrictions = [];
  game.category = '';
  game.votes = {};
  game.moleVotes = {};
  game.result = null;
  game.roundNo = 1;

  broadcast();
  json(res, 200, { ok: true });
}

// 房主在大厅手动移出已经离线的玩家,避免长时间占着席位
function apiKickOffline(res, data) {
  if (game.phase !== 'lobby') {
    return json(res, 409, { ok: false, error: '游戏进行中不能移出玩家' });
  }
  if (!isPlayer(data.pid)) {
    return json(res, 403, { ok: false, error: '先入座' });
  }
  if (game.hostId !== data.pid) {
    return json(res, 403, { ok: false, error: '只有房主能移出离线玩家' });
  }

  const offline = game.players.filter((p) => p.id !== data.pid && !isOnline(p.id));
  for (const p of offline) {
    const timer = pendingRemoval.get(p.id);
    if (timer) clearTimeout(timer);
    pendingRemoval.delete(p.id);
  }

  game.players = game.players.filter((p) => p.id === data.pid || isOnline(p.id));

  broadcast();
  json(res, 200, { ok: true, removed: offline.length });
}

async function handleApi(req, res, url) {
  let data;
  try {
    data = await readJson(req);
  } catch (err) {
    return json(res, 400, { ok: false, error: '请求格式不对' });
  }

  try {
    switch (url.pathname) {
      case '/api/join':
        return apiJoin(res, data);
      case '/api/start':
        return apiStart(res, data);
      case '/api/options':
        return apiOptions(res, data);
      case '/api/mode':
        return apiMode(res, data);
      case '/api/submit':
        return apiSubmit(res, data);
      case '/api/guess':
        return apiGuess(res, data);
      case '/api/match-submit':
        return apiMatchSubmit(res, data);
      case '/api/match-end':
        return apiMatchEnd(res, data);
      case '/api/vote':
        return apiVote(res, data);
      case '/api/finish-vote':
        return apiFinishVote(res, data);
      case '/api/mole-vote':
        return apiMoleVote(res, data);
      case '/api/finish-mole-vote':
        return apiFinishMoleVote(res, data);
      case '/api/again':
        return apiAgain(res, data);
      case '/api/reset':
        return apiReset(res, data);
      case '/api/kick-offline':
        return apiKickOffline(res, data);
      default:
        return json(res, 404, { ok: false, error: '没有这个接口' });
    }
  } catch (err) {
    console.error('[api error]', err);
    return json(res, 500, { ok: false, error: '服务器出错了' });
  }
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

function serveStatic(res, pathname) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch (err) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (rel === '/') rel = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// HTTP 服务器
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/events') {
    return handleEvents(req, res, url);
  }
  if (req.method === 'POST') {
    return handleApi(req, res, url);
  }
  if (req.method === 'GET') {
    return serveStatic(res, url.pathname);
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌────────────────────────────────────────────┐');
  console.log('  │  小游戏桌 · 传声筒 / 默契挑战              │');
  console.log('  └────────────────────────────────────────────┘');
  console.log(`  本机:   http://localhost:${PORT}`);
  for (const ip of lanIPs()) {
    console.log(`  局域网: http://${ip}:${PORT}`);
  }
  console.log('');
  console.log('  公网联机(Cloudflare 临时隧道):');
  console.log(`    cloudflared tunnel --url http://localhost:${PORT}`);
  console.log('  或 ngrok:');
  console.log(`    ngrok http ${PORT}`);
  console.log('');
});
