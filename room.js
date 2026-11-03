'use strict';

/**
 * 单个房间的游戏引擎
 * 每个房间独立保存状态、计时器和 SSE 客户端,由 server.js 按房间码创建和调度。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  RESTRICTIONS,
  findRestriction,
  restrictionText,
  containsTarget,
  normalize,
} = require('./rules');

const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 60;
const TURN_MS = TURN_SECONDS * 1000;

const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 5 * 60 * 1000;

const MATCH_SECONDS = Number(process.env.MATCH_SECONDS) || 40;
const MATCH_REVEAL_SECONDS = Number(process.env.MATCH_REVEAL_SECONDS) || 8;
const MATCH_MS = MATCH_SECONDS * 1000;
const MATCH_REVEAL_MS = MATCH_REVEAL_SECONDS * 1000;

const CATEGORIES = [
  '食物', '动物', '职业', '日用品', '交通工具',
  '影视作品', '网络流行语', '运动', '地点', '情绪',
];

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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 创建一个房间实例。
 * @param {string} code 六位数字房间码
 * @param {{ onDelete?: () => void }} options onDelete: 房间应被删除时调用(最后一人离开/房主清空)
 */
function createRoom(code, options = {}) {
  const onDelete = options.onDelete || (() => {});
  const onGameStart = options.onGameStart || (() => {});
  const onGameEnd = options.onGameEnd || (() => {});

  function notifyGameStart() {
    try {
      onGameStart(game.mode);
    } catch (err) {
      console.warn('[stats] 记录开局失败:', err.message);
    }
  }

  function notifyGameEnd(mode) {
    try {
      onGameEnd(mode);
    } catch (err) {
      console.warn('[stats] 记录结束失败:', err.message);
    }
  }

  const game = {
    phase: 'lobby',   // lobby | playing | vote | molevote | result | match | matchresult
    mode: 'chain',    // chain(传声筒) | match(默契挑战)
    roundNo: 1,
    hostId: null,
    options: {
      mole: false,
      restriction: false,
      category: false,
      history: false,
      theme: true,
    },
    players: [],
    order: [],
    step: 0,
    turns: [],
    originalWord: '',
    moleId: null,
    restrictions: [],
    category: '',
    votes: {},
    moleVotes: {},
    result: null,
    deadline: null,
    pendingGuess: null,
    match: null,
  };

  const clients = new Map(); // res -> { pid }  pid 为空表示旁观
  let turnTimer = null;
  let turnSeq = 0;
  let matchTimer = null;
  let matchSeq = 0;
  const pendingRemoval = new Map();
  let abandonTimer = null;
  let destroyed = false;

  const isPlayer = (pid) => game.players.some((p) => p.id === pid);

  function nameOf(pid) {
    const p = game.players.find((x) => x.id === pid);
    return p ? p.name : '';
  }

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

  // -------------------------------------------------------------------------
  // 回合计时(传声筒)
  // -------------------------------------------------------------------------

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
    if (game.phase !== 'playing' || destroyed) return;

    const seq = ++turnSeq;
    game.deadline = Date.now() + TURN_MS;
    turnTimer = setTimeout(() => autoSubmitTurn(seq), TURN_MS);
  }

  function autoSubmitTurn(seq) {
    if (destroyed || seq !== turnSeq) return;
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

  // -------------------------------------------------------------------------
  // 默契挑战
  // -------------------------------------------------------------------------

  function clearMatchTimer() {
    matchSeq += 1;
    if (matchTimer) {
      clearTimeout(matchTimer);
      matchTimer = null;
    }
    if (game.match) game.match.deadline = null;
  }

  function scheduleMatchTimer(ms, fn) {
    clearMatchTimer();
    if (destroyed) return;
    const seq = ++matchSeq;
    if (game.match) game.match.deadline = Date.now() + ms;
    matchTimer = setTimeout(() => {
      if (destroyed || seq !== matchSeq) return;
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
    let theme = '';
    if (game.options.theme) {
      const themes = loadMatchThemes();
      theme = themes[Math.floor(Math.random() * themes.length)];
    }

    game.match = {
      theme,
      round: 1,
      stage: 'input',
      deadline: null,
      submissions: {},
      sources: {},
      history: [],
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

  function previousMatchWord(pid) {
    const m = game.match;
    if (!m) return '';
    const prev = m.history[m.history.length - 1];
    if (!prev) return '';
    const entry = prev.words.find((w) => w.playerId === pid && w.word);
    return entry ? entry.word : '';
  }

  function autoMatchRound() {
    if (destroyed || game.phase !== 'match' || !game.match || game.match.stage !== 'input') return;

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
    if (destroyed || game.phase !== 'match' || !m || m.stage !== 'reveal') return;

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
      reason,
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
    notifyGameEnd('match');
  }

  // -------------------------------------------------------------------------
  // 断线 / 房间回收
  // -------------------------------------------------------------------------

  function requestDelete() {
    if (destroyed) return;
    onDelete();
  }

  function checkEmpty() {
    if (!game.players.length) requestDelete();
  }

  function checkAbandoned() {
    if (destroyed) return;
    if (onlinePlayers().length > 0) {
      if (abandonTimer) {
        clearTimeout(abandonTimer);
        abandonTimer = null;
      }
      return;
    }
    if (abandonTimer) return;
    abandonTimer = setTimeout(() => {
      abandonTimer = null;
      if (!destroyed && onlinePlayers().length === 0) requestDelete();
    }, DISCONNECT_GRACE_MS);
  }

  function scheduleRemoval(pid) {
    if (destroyed || !pid || !isPlayer(pid) || pendingRemoval.has(pid)) return;

    const scheduledAt = Date.now();
    const timer = setTimeout(() => {
      pendingRemoval.delete(pid);
      if (destroyed) return;

      // 电脑睡眠时定时器会暂停;醒来后如果明显超过宽限期,重新计时。
      if (Date.now() - scheduledAt > DISCONNECT_GRACE_MS + 60000) {
        scheduleRemoval(pid);
        return;
      }

      removeOfflinePlayer(pid);
    }, DISCONNECT_GRACE_MS);

    pendingRemoval.set(pid, timer);
  }

  function removeOfflinePlayer(pid) {
    if (destroyed || isOnline(pid)) return;

    const player = game.players.find((p) => p.id === pid);
    if (!player) return;

    // 只在大厅移除;游戏中保留席位,靠回合超时继续推进。
    if (game.phase === 'lobby') {
      game.players = game.players.filter((p) => p.id !== pid);
      if (game.hostId === pid) {
        game.hostId = game.players.length ? game.players[0].id : null;
      }
      broadcast();
      checkEmpty();
    }
  }

  function cleanupOfflinePlayers(keepId) {
    game.players = game.players.filter((p) => p.id === keepId || isOnline(p.id));
    if (!game.players.length) {
      requestDelete();
      return;
    }
    if (!game.players.some((p) => p.id === game.hostId)) {
      game.hostId = game.players[0].id;
    }
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  function viewFor(pid) {
    const me = game.players.find((p) => p.id === pid) || null;
    const spectator = !me;

    const view = {
      phase: game.phase,
      mode: game.mode,
      roomCode: code,
      spectator,
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

    if (me && game.moleId && game.moleId === me.id && game.phase !== 'lobby') {
      view.isMole = true;
    }

    if (game.phase === 'playing') {
      const currentId = game.order[game.step];
      view.currentPlayer = nameOf(currentId);
      view.currentPlayerOnline = isOnline(currentId);
      view.turnTimeLeft = game.deadline ? Math.max(0, game.deadline - Date.now()) : null;
      if (game.category) view.category = game.category;

      // 只有本人能回看自己传过的内容;旁观者不拿描述。
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
        if (!last && game.options.restriction) {
          view.turn.restriction = restrictionText(game.restrictions[game.step]);
        }
      }
    }

    // 揭晓后的链路是公开的;投票明细仍然只给本人。
    if ((game.phase === 'vote' || game.phase === 'molevote' || game.phase === 'result')
      && (me || spectator)) {
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

      if (game.phase === 'result') {
        view.mole = game.moleId ? { id: game.moleId, name: nameOf(game.moleId) } : null;
      }

      if (game.phase === 'vote') {
        view.myVote = me ? (game.votes[pid] || null) : null;
        view.votesCount = Object.keys(game.votes).length;
      }

      if (game.phase === 'molevote') {
        view.hasMole = !!game.moleId;
        view.myMoleVote = me ? (game.moleVotes[pid] || null) : null;
        view.moleVotesCount = Object.keys(game.moleVotes).length;
        view.moleVotersCount = game.players.filter((p) => p.id !== game.moleId).length;
      }
    }

    if (game.phase === 'result' && (me || spectator)) {
      view.result = game.result;
    }

    // 默契挑战:本轮提交的词只回给本人;旁观者只拿公开信息。
    if (game.phase === 'match' && game.match && (me || spectator)) {
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
        myWord: me && m.sources[me.id] === 'submit' ? (m.submissions[me.id] || '') : '',
        history: publicHistory,
      };

      if (m.stage === 'reveal') {
        view.match.reveal = publicHistory.length
          ? publicHistory[publicHistory.length - 1]
          : null;
      }
    }

    if (game.phase === 'matchresult' && game.match && game.match.result && (me || spectator)) {
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

  function broadcast() {
    for (const [res, meta] of clients) {
      try {
        res.write(`data: ${JSON.stringify(viewFor(meta.pid))}\n\n`);
      } catch (err) {
        clients.delete(res);
      }
    }
  }

  function handleEvents(req, res, pid) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    clients.set(res, { pid });

    if (pid) {
      const pending = pendingRemoval.get(pid);
      if (pending) {
        clearTimeout(pending);
        pendingRemoval.delete(pid);
      }
      if (abandonTimer) {
        clearTimeout(abandonTimer);
        abandonTimer = null;
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
      if (destroyed) return;

      if (pid && isPlayer(pid) && !isOnline(pid)) {
        broadcast();
        scheduleRemoval(pid);
      }
      checkAbandoned();
    });
  }

  // -------------------------------------------------------------------------
  // 接口
  // -------------------------------------------------------------------------

  function addPlayer(name) {
    const id = crypto.randomUUID();
    game.players.push({ id, name });
    if (!game.hostId) game.hostId = id;
    broadcast();
    return id;
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
      notifyGameStart();
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

    if (game.options.category) {
      game.category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    }

    if (game.options.restriction) {
      const describers = game.order.length - 1;
      for (let i = 0; i < describers; i++) {
        game.restrictions.push(RESTRICTIONS[Math.floor(Math.random() * RESTRICTIONS.length)].id);
      }
    }

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
    notifyGameStart();
    json(res, 200, { ok: true });
  }

  function apiOptions(res, data) {
    if (game.phase !== 'lobby') {
      return json(res, 409, { ok: false, error: '开局后不能改玩法' });
    }
    if (game.hostId !== data.pid) {
      return json(res, 403, { ok: false, error: '只有房主能改玩法' });
    }

    const o = data.options || {};
    const next = { ...game.options };
    for (const key of ['mole', 'restriction', 'category', 'history', 'theme']) {
      if (o[key] !== undefined) next[key] = !!o[key];
    }
    game.options = next;

    broadcast();
    json(res, 200, { ok: true });
  }

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
      notifyGameEnd('chain');
    }
  }

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
    notifyGameEnd('chain');
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

    cleanupOfflinePlayers(data.pid);
    if (destroyed) return;
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

    json(res, 200, { ok: true });
    requestDelete();
  }

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

    if (!game.players.length) {
      requestDelete();
      return;
    }

    broadcast();
    json(res, 200, { ok: true, removed: offline.length });
  }

  function handleAction(pathname, data, res) {
    switch (pathname) {
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
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTurnTimer();
    clearMatchTimer();
    for (const timer of pendingRemoval.values()) clearTimeout(timer);
    pendingRemoval.clear();
    if (abandonTimer) {
      clearTimeout(abandonTimer);
      abandonTimer = null;
    }
    for (const res of clients.keys()) {
      try {
        res.write(`data: ${JSON.stringify({ noRoom: true })}\n\n`);
        res.end();
      } catch (err) {
        /* 连接已断 */
      }
    }
    clients.clear();
  }

  return {
    code,
    game,
    addPlayer,
    hasPlayer: isPlayer,
    handleEvents,
    handleAction,
    destroy,
    viewFor,
    clients,
  };
}

module.exports = { createRoom, json, clean };
