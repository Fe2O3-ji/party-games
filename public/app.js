'use strict';

/* =========================================================
   传声筒 · 前端
   ========================================================= */

const appEl = document.getElementById('app');

let pid = localStorage.getItem('tt_pid') || '';
let roomCode = localStorage.getItem('tt_room') || '';
let spectator = localStorage.getItem('tt_spectator') === '1';
let savedName = localStorage.getItem('tt_name') || '';
let state = null;
let stateReceivedAt = 0;
let es = null;

let lastKey = '';
let lastPhase = null;
let lastTurnIndex = null;

// 当前玩家的本地两步:先猜,再描述
let stage = 'guess';
let guessDraft = '';
let selectedVote = null;
let selectedMoleVote = null;
let celebratedRound = null;
let celebratedMatch = null;

// 未进入房间时的入口:创建房间 / 加入房间
let entryTab = 'create'; // create | join

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

let toastTimer = null;

function toast(message) {
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      toast(data.error || '出错了');
      return null;
    }
    return data;
  } catch (err) {
    toast('网络断了,稍后再试');
    return null;
  }
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

let connBanner = null;

// 断线时在页面顶部显示提示;EventSource 会自动重连,收到消息后自动消失
function setConnectionLost(lost) {
  if (lost) {
    if (connBanner) return;
    connBanner = document.createElement('div');
    connBanner.className = 'conn-banner';
    connBanner.textContent = '连接中断,正在重连…';
    document.body.appendChild(connBanner);
  } else if (connBanner) {
    connBanner.remove();
    connBanner = null;
  }
}

function makeEntryState() {
  return {
    phase: 'entry',
    mode: 'chain',
    roomCode: '',
    spectator: false,
    roundNo: 1,
    hostId: null,
    options: { mole: false, restriction: false, category: false, history: false, theme: true },
    players: [],
    order: [],
    step: 0,
    me: null,
    isHost: false,
    turnSeconds: 60,
    matchSeconds: 40,
  };
}

function resetToEntry() {
  pid = '';
  roomCode = '';
  spectator = false;
  localStorage.removeItem('tt_pid');
  localStorage.removeItem('tt_room');
  localStorage.removeItem('tt_spectator');

  if (es) {
    es.onopen = null;
    es.onmessage = null;
    es.onerror = null;
    es.close();
    es = null;
  }

  setConnectionLost(false);
  selectedVote = null;
  selectedMoleVote = null;
  celebratedRound = null;
  celebratedMatch = null;
  lastPhase = null;
  lastTurnIndex = null;
  lastKey = '';
  state = makeEntryState();
  renderNow();
}

function connect() {
  if (es) {
    // 主动换连接时不要把旧连接的关闭当成断线
    es.onopen = null;
    es.onmessage = null;
    es.onerror = null;
    es.close();
    es = null;
  }

  setConnectionLost(false);
  const params = new URLSearchParams();
  if (pid) params.set('pid', pid);
  if (roomCode) params.set('room', roomCode);
  es = new EventSource('/events?' + params.toString());

  es.onopen = () => setConnectionLost(false);

  es.onmessage = (event) => {
    setConnectionLost(false);

    let next;
    try {
      next = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (next.noRoom) {
      resetToEntry();
      return;
    }
    onState(next);
    render();
  };

  es.onerror = () => {
    // EventSource 会自动重连,先给用户一个提示
    setConnectionLost(true);
  };
}

function onState(next) {
  const turnIndex = next.turn ? next.turn.index : null;

  if (next.phase !== lastPhase) {
    selectedVote = null;
    selectedMoleVote = null;
  }

  if (next.phase !== lastPhase || turnIndex !== lastTurnIndex) {
    stage = 'guess';
    guessDraft = '';
  }

  lastPhase = next.phase;
  lastTurnIndex = turnIndex;

  // 房间 / 身份以服务端视图为准
  if (next.roomCode) {
    roomCode = next.roomCode;
    localStorage.setItem('tt_room', roomCode);
  }
  if (next.spectator) {
    spectator = true;
    if (pid) {
      pid = '';
      localStorage.removeItem('tt_pid');
    }
    localStorage.setItem('tt_spectator', '1');
  } else if (next.me) {
    spectator = false;
    pid = next.me.id;
    localStorage.setItem('tt_pid', pid);
    localStorage.removeItem('tt_spectator');
  }

  if (next.perfect && celebratedRound !== next.roundNo) {
    celebratedRound = next.roundNo;
    setTimeout(fireConfetti, 120);
  }

  // 默契挑战成功相遇时也放礼炮(按主题 + 轮数去重)
  if (next.phase === 'matchresult' && next.match && next.match.matched) {
    const matchKey = `${next.match.theme}|${next.match.rounds}`;
    if (celebratedMatch !== matchKey) {
      celebratedMatch = matchKey;
      setTimeout(fireConfetti, 120);
    }
  }

  if (next.phase === 'lobby') {
    celebratedRound = null;
    celebratedMatch = null;
  }

  state = next;
  stateReceivedAt = Date.now();
}

// ---------------------------------------------------------------------------
// 渲染调度
// ---------------------------------------------------------------------------

function renderKey(s) {
  const meKey = s.me ? s.me.id : 'guest';
  const playerCount = s.players.length;
  const resultKey = s.result
    ? s.result.winners.map((w) => w.id).join(',') + '|' + s.result.totalVotes
    : '';
  const optionsKey = [
    s.options.mole ? 1 : 0,
    s.options.restriction ? 1 : 0,
    s.options.category ? 1 : 0,
    s.options.history ? 1 : 0,
    s.options.theme ? 1 : 0,
  ].join('');

  const matchKey = s.match
    ? [
        s.match.stage || '',
        s.match.round ?? '',
        s.match.myWord || '',
        s.match.matched ? 1 : 0,
        s.match.rounds ?? '',
        s.match.history ? s.match.history.length : 0,
      ].join('|')
    : '';

  // 当前玩家正在输入时不因别人的在线/提交状态重建页面
  const hasInput = s.turn
    || (s.phase === 'match' && s.match && s.match.stage === 'input' && !s.match.myWord);
  const onlineKey = hasInput ? '' : s.players.map((p) => (p.online ? 1 : 0)).join('');

  return [
    s.phase,
    s.mode ?? '',
    s.roomCode ?? '',
    s.spectator ? 1 : 0,
    s.phase === 'entry' ? entryTab : '',
    s.roundNo,
    s.step,
    meKey,
    playerCount,
    s.hostId ?? '',
    optionsKey,
    s.votesCount ?? '',
    s.myVote ?? '',
    s.moleVotesCount ?? '',
    s.myMoleVote ?? '',
    s.hasMole ? 1 : 0,
    resultKey,
    s.currentPlayer ?? '',
    s.isMole ? 1 : 0,
    s.category ?? '',
    s.mole ? s.mole.id : '',
    s.history ? s.history.length : 0,
    s.turn && s.turn.restriction ? s.turn.restriction : '',
    matchKey,
    onlineKey,
  ].join('~');
}

// 整页重建前保存输入草稿和焦点,避免广播(如房主切游戏、有人入座)清空正在填的内容
function captureInputDrafts() {
  const fields = [];
  let activeId = null;
  const active = document.activeElement;

  appEl.querySelectorAll('input[type="text"], textarea').forEach((el) => {
    if (!el.id) return;
    fields.push({
      id: el.id,
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
    });
    if (el === active) activeId = el.id;
  });

  return { fields, activeId };
}

function restoreInputDrafts(draft) {
  if (!draft) return;

  for (const item of draft.fields) {
    const el = document.getElementById(item.id);
    if (!el || !('value' in el)) continue;

    // 入口页的名字可能有默认回填值,用户的输入草稿要优先。
    const restore = item.id === 'entryCode' || item.id === 'entryName'
      ? item.value !== el.value
      : (!el.value && item.value);

    if (restore && item.value) {
      el.value = item.value;
      if (el.setSelectionRange && item.start != null) {
        try {
          el.setSelectionRange(item.start, item.end);
        } catch (err) {
          /* 某些输入类型不支持选区,忽略 */
        }
      }
    }
  }

  if (draft.activeId) {
    const el = document.getElementById(draft.activeId);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
}

function render() {
  if (!state) return;

  const key = renderKey(state);
  if (key === lastKey) return;
  lastKey = key;

  const draft = captureInputDrafts();
  appEl.innerHTML = build(state);
  bind(state);
  restoreInputDrafts(draft);
  focusFor(state);
  updateCountdown();
}

function renderNow() {
  lastKey = '';
  render();
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

function build(s) {
  if (s.phase === 'entry') return entryView(s);
  if (!s.me) {
    if (s.spectator) return spectatorView(s);
    return entryView(s);
  }

  switch (s.phase) {
    case 'lobby':
      return lobbyView(s);
    case 'playing':
      return playingView(s);
    case 'vote':
      return voteView(s);
    case 'molevote':
      return moleVoteView(s);
    case 'result':
      return resultView(s);
    case 'match':
      return matchView(s);
    case 'matchresult':
      return matchResultView(s);
    default:
      return spectatorView(s);
  }
}

function shell(s, inner, modeOverride) {
  const isMatch = (modeOverride || s.mode) === 'match';

  return `
    <div class="wrap">
      <header class="masthead">
        <div class="seal">${isMatch ? '心有灵犀' : '越传越歪'}</div>
        <div class="eyebrow">${isMatch ? '同时猜词' : '描述接龙'}</div>
        <h1>${isMatch ? '默契挑战' : '传声筒'}</h1>
        <div class="rule"></div>
      </header>
      ${inner}
      <div class="foot">${isMatch
        ? '同一道题 · 同一个词 · 看看能不能想到一块'
        : '一个人想词 · 一个人猜 · 一句话就够跑偏'}</div>
    </div>`;
}

function roomCodeHtml(s) {
  if (!s.roomCode) return '';
  return `
    <div class="room-code anim">
      <span class="tag">房间码</span>
      <b>${esc(s.roomCode)}</b>
    </div>`;
}

function entryView(s) {
  const isCreate = entryTab === 'create';

  return `
    <div class="wrap">
      <header class="masthead">
        <div class="seal">开一桌</div>
        <div class="eyebrow">派对小游戏</div>
        <h1>小游戏桌</h1>
        <div class="rule"></div>
      </header>
      <div class="entry-tabs anim">
        <button type="button" class="entry-tab ${isCreate ? 'active' : ''}" data-entry-tab="create">创建房间</button>
        <button type="button" class="entry-tab ${isCreate ? '' : 'active'}" data-entry-tab="join">加入房间</button>
      </div>
      <section class="panel anim">
        <div class="entry-head">
          <span class="tag">${isCreate ? '建一桌' : '进一桌'}</span>
          <span class="hint">6 位数字房间码</span>
        </div>
        <form id="${isCreate ? 'createForm' : 'joinForm'}">
          <label class="field">
            <span>房间码(6 位数字)</span>
            <input id="entryCode" type="text" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" placeholder="例如 123456" autocomplete="off" required>
          </label>
          <label class="field">
            <span>你的名字</span>
            <input id="entryName" type="text" maxlength="12" value="${esc(savedName)}" placeholder="写个名字" autocomplete="off" required>
          </label>
          <button class="btn red" type="submit">${isCreate ? '创建并进入' : '加入房间'}</button>
        </form>
        <p class="hint">${isCreate
          ? '房间码由你定,不能和现有房间重复;进入大厅后再选游戏。'
          : '输入房主给你的房间码。游戏已经开始时会进入旁观模式。'}</p>
      </section>
      <p class="pick-note">最多 50 间房 · 创建后把房间码发给朋友</p>
      <div class="foot">同一房间 · 一个房主 · 随时开新局</div>
    </div>`;
}

function spectatorBanner(s) {
  return `
    <div class="spectator-banner anim">
      <span class="tag">旁观中</span>
      <span>房间 ${esc(s.roomCode || '')}</span>
    </div>`;
}

function spectatorPlayersHtml(s) {
  return `
    <div class="match-players">
      ${s.players.map((p) => `
        <div class="match-player ${p.online ? '' : 'off'}">
          <span class="mp-name">${esc(p.name)}</span>
          <span class="mp-state">${p.online ? '在线' : '离线'}</span>
        </div>`).join('')}
    </div>`;
}

function spectatorView(s) {
  if (s.phase === 'lobby') return spectatorLobbyView(s);
  if (s.phase === 'result') return resultView(s);
  if (s.phase === 'matchresult') return matchResultView(s);
  if (s.phase === 'vote' || s.phase === 'molevote') return spectatorChainRevealView(s);
  if (s.phase === 'playing') return spectatorChainPlayingView(s);
  if (s.phase === 'match') return spectatorMatchView(s);
  return shell(s, `
    ${spectatorBanner(s)}
    <section class="panel waiting anim">
      <div class="dots"><span></span><span></span><span></span></div>
      <p class="wait-name">旁观中</p>
      <p class="hint">等这一局结束吧。</p>
    </section>`);
}

function spectatorLobbyView(s) {
  const n = s.players.length;
  const cap = s.mode === 'match' ? 5 : 8;
  const full = n >= cap;

  const seats = s.players.map((p, i) => `
    <li class="seat anim" style="animation-delay:${i * 35}ms">
      <span class="no">${String(i + 1).padStart(2, '0')}</span>
      <span class="name">${esc(p.name)}</span>
      ${p.online === false ? '<span class="offline">离线</span>' : ''}
      ${p.id === s.hostId ? '<span class="host">房主</span>' : ''}
    </li>`).join('');

  return shell(s, `
    ${spectatorBanner(s)}
    <section class="panel anim">
      <div class="lobby-head">
        <h2>${s.mode === 'match' ? '默契挑战' : '传声筒'} · <em>${n}</em> / ${cap}</h2>
        <p class="hint">你正在旁观这一桌</p>
      </div>
      <ul class="seat-list">${seats}</ul>
      ${full
        ? '<button class="btn" disabled>房间满了</button>'
        : '<button class="btn red" id="spectatorJoinBtn">加入这一桌</button>'}
      <p class="hint">加入后会成为玩家,从下一局开始参与。</p>
    </section>`);
}

function spectatorChainPlayingView(s) {
  const total = s.order.length;
  const idx = s.step;
  const pips = Array.from({ length: total }, (_, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'now' : '';
    return `<div class="pip ${cls}"></div>`;
  }).join('');
  const offlineNote = s.currentPlayerOnline === false ? ' <span class="offline">离线</span>' : '';

  return shell(s, `
    ${spectatorBanner(s)}
    <div class="turnbar">
      <span>第 ${idx + 1} / ${total} 棒</span>
      <span class="bar">${pips}</span>
      <span class="countdown mono" id="countdown"></span>
    </div>
    <section class="panel waiting anim">
      <div class="dots"><span></span><span></span><span></span></div>
      <p class="wait-name"><b>${esc(s.currentPlayer)}</b> 正在传话${offlineNote}</p>
      <p class="hint">旁观中,看不到描述内容;本局结束后可以加入下一局。</p>
    </section>
    ${spectatorPlayersHtml(s)}`);
}

function spectatorChainRevealView(s) {
  return shell(s, `
    ${spectatorBanner(s)}
    <div class="round-banner anim">本回合结束 · 答案揭晓</div>
    ${perfectBanner(s)}
    ${chainMeta(s)}
    ${chainHtml(s)}
    <section class="panel waiting anim">
      <p class="hint">旁观中,不能参与投票。等本局结束可以加入下一局。</p>
    </section>`);
}

function spectatorMatchInputInner(s) {
  const m = s.match;
  const last = m.history.length ? m.history[m.history.length - 1] : null;

  return `
    ${matchTurnbar(s, `第 ${m.round} 轮 · 旁观`)}
    ${themeCardHtml(m)}
    ${last ? lastRoundHtml(last, '上一轮') : ''}
    <section class="panel waiting anim">
      <div class="dots"><span></span><span></span><span></span></div>
      <p class="wait-name">玩家正在写词…</p>
      <p class="hint">全部交卷后自动揭晓。</p>
    </section>
    ${matchPlayersHtml(s)}`;
}

function spectatorMatchView(s) {
  const m = s.match;
  if (!m) {
    return shell(s, `
      ${spectatorBanner(s)}
      <section class="panel waiting anim">
        <p class="wait-name">旁观中</p>
        <p class="hint">等这一局结束吧。</p>
      </section>`);
  }

  const inner = m.stage === 'reveal' ? matchRevealInner(s) : spectatorMatchInputInner(s);
  return shell(s, `
    ${spectatorBanner(s)}
    ${inner}
    <p class="hint">旁观中,不能提交;本局结束后可以加入下一局。</p>`);
}

function optionsView(s) {
  const locked = s.isHost ? '' : 'disabled';
  const item = (id, key, title, desc) => `
    <label class="opt ${s.isHost ? '' : 'locked'}">
      <input type="checkbox" id="${id}" ${s.options[key] ? 'checked' : ''} ${locked}>
      <span class="opt-body"><b>${title}</b><small>${desc}</small></span>
    </label>`;

  return `
    <div class="options">
      <div class="options-head">
        <span class="tag">花样玩法</span>
        <span class="hint">${s.isHost ? '由你设置' : '由房主设置'}</span>
      </div>
      ${item('optMole', 'mole', '卧底棒', '随机一人暗中把话带偏')}
      ${item('optRestriction', 'restriction', '限制卡', '每棒描述抽一条奇怪限制')}
      ${item('optCategory', 'category', '类别词库', '第一棒只能在本局类别里想词')}
      ${item('optHistory', 'history', '历史记录', '传过话的人可以回看已传内容')}
    </div>`;
}

function modeView(s) {
  const locked = s.isHost ? '' : 'disabled';
  const card = (mode, title, desc) => `
    <button type="button" class="mode-card ${s.mode === mode ? 'active' : ''}" data-mode="${mode}" ${locked}>
      <b>${title}</b><small>${desc}</small>
    </button>`;

  return `
    <div class="mode-head">
      <span class="tag">本局游戏</span>
      <span class="hint">${s.isHost ? '由你选择' : '由房主选择'}</span>
    </div>
    <div class="mode-grid">
      ${card('chain', '传声筒', '3–8 人 · 描述接龙')}
      ${card('match', '默契挑战', '2–5 人 · 同时猜词')}
    </div>`;
}

function matchOptionsView(s) {
  const locked = s.isHost ? '' : 'disabled';

  return `
    <div class="options">
      <div class="options-head">
        <span class="tag">玩法</span>
        <span class="hint">2–5 人 · ${s.isHost ? '由你设置' : '由房主设置'}</span>
      </div>
      <label class="opt ${s.isHost ? '' : 'locked'}">
        <input type="checkbox" id="optTheme" ${s.options.theme ? 'checked' : ''} ${locked}>
        <span class="opt-body"><b>指定主题</b><small>开局随机一个主题;关闭后自由起手</small></span>
      </label>
      <p class="match-rule">每轮 ${s.matchSeconds ?? 40} 秒,所有人同时写一个 1–8 字的词,交卷前互不可见;全部交卷立即揭晓。</p>
      <p class="match-rule">看到上一轮的词后继续联想,直到全员在同一轮写出同一个词。超时自动沿用自己上一轮的词(第一轮没有旧词则记未答)。房主可随时结束本局。</p>
    </div>`;
}

function lobbyView(s) {
  const n = s.players.length;
  const isMatch = s.mode === 'match';
  const cap = isMatch ? 5 : 8;
  const min = isMatch ? 2 : 3;
  const offlineCount = s.players.filter((p) => p.online === false).length;

  const seats = s.players.map((p, i) => `
    <li class="seat anim" style="animation-delay:${i * 35}ms">
      <span class="no">${String(i + 1).padStart(2, '0')}</span>
      <span class="name">${esc(p.name)}</span>
      ${p.online === false ? '<span class="offline">离线</span>' : ''}
      ${p.id === s.hostId ? '<span class="host">房主</span>' : ''}
      ${p.id === s.me.id ? '<span class="you">你</span>' : ''}
    </li>`).join('');

  const canStart = n >= min && n <= cap;
  let startLabel = isMatch ? '同时开猜' : '洗牌开局';
  if (n < min) startLabel = `还差 ${min - n} 人开局`;
  else if (n > cap) startLabel = `最多 ${cap} 人`;

  const startArea = s.isHost
    ? `<button class="btn" id="startBtn" ${canStart ? '' : 'disabled'}>${startLabel}</button>`
    : '<button class="btn" disabled>等房主开局…</button>';

  return shell(s, `
    <section class="panel anim">
      ${roomCodeHtml(s)}
      <div class="lobby-head">
        <h2>已就座 <em>${n}</em> / ${cap}</h2>
        <p class="hint">${isMatch ? '2 人即可开局,所有人同时写词。' : '3 人即可开局,系统随机排棒次。'}</p>
      </div>
      ${modeView(s)}
      <ul class="seat-list">${seats}</ul>
      ${isMatch ? matchOptionsView(s) : optionsView(s)}
      ${startArea}
      <p class="hint share">让朋友打开同一网址,输入房间码 ${esc(s.roomCode)} 加入</p>
      ${s.isHost ? `
        ${offlineCount ? `<button class="btn ghost mini" id="kickOfflineBtn">移出离线玩家 (${offlineCount})</button>` : ''}
        <button class="btn ghost mini" id="resetBtn">清空牌桌</button>
      ` : ''}
    </section>
  `);
}

function playingView(s) {
  const total = s.order.length;
  const idx = s.step;

  const pips = Array.from({ length: total }, (_, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'now' : '';
    return `<div class="pip ${cls}"></div>`;
  }).join('');

  const offlineNote = s.currentPlayerOnline === false
    ? ' <span class="offline">离线</span>'
    : '';

  const body = s.turn
    ? turnView(s)
    : `
      <section class="panel waiting anim">
        <div class="dots"><span></span><span></span><span></span></div>
        <p class="wait-name"><b>${esc(s.currentPlayer)}</b> 正在传话${offlineNote}</p>
        <p class="hint">别偷看,等轮到你。</p>
      </section>`;

  const moleNote = s.isMole ? `
    <div class="mole-note anim">
      <span class="tag">卧底任务</span>
      <p>你是卧底。从猜词到描述,想办法把话悄悄带偏,别让大家发现。</p>
    </div>` : '';

  return shell(s, `
    <div class="turnbar">
      <span>第 ${idx + 1} / ${total} 棒</span>
      <span class="bar">${pips}</span>
      <span class="countdown mono" id="countdown"></span>
    </div>
    ${moleNote}
    ${historyHtml(s)}
    ${body}
  `);
}

function historyHtml(s) {
  if (!s.history || !s.history.length) return '';

  const items = s.history.map((t) => `
    <div class="history-item">
      <div class="hi-who"><span class="no">${String(t.index + 1).padStart(2, '0')}</span>${esc(t.player)}</div>
      ${t.guess ? `<div class="hi-guess">猜:${esc(t.guess)}</div>` : ''}
      ${t.description ? `<div class="hi-desc">${esc(t.description)}</div>` : ''}
    </div>`).join('');

  return `
    <details class="history-panel paper anim">
      <summary><span>历史记录</span><small>你已经传过话,可以回看</small></summary>
      <div class="history-list">${items}</div>
    </details>`;
}

function restrictionCard(text) {
  return `
    <div class="restriction-card">
      <span class="tag">本棒限制</span>
      <p>${esc(text)}</p>
      <small>提交时会自动检查</small>
    </div>`;
}

function turnView(s) {
  const t = s.turn;

  if (t.first) {
    const categoryNote = s.category ? `
      <div class="category-note">
        <span class="tag">本局类别</span>
        <b>${esc(s.category)}</b>
      </div>` : '';

    const wordPlaceholder = s.category
      ? `想一个「${esc(s.category)}」类的词`
      : '比如:火锅';
    const descPlaceholder = s.category
      ? '用一句话描述它,别说出这个词'
      : '冬天一群人围着,锅里的汤一直咕嘟咕嘟冒泡,边煮边吃';

    return `
      <section class="panel tape anim">
        <div class="turn-label">第一棒 · 出题</div>
        ${categoryNote}
        <p class="lead">想一个词,再用一句话描述它。<strong>描述里不能出现这个词。</strong></p>
        <form id="firstForm">
          <label class="field">
            <span>你想的词(只有你知道)</span>
            <input id="wordInput" type="text" maxlength="20" placeholder="${wordPlaceholder}" autocomplete="off" required>
          </label>
          <label class="field">
            <span>你的描述(交给下一个人)</span>
            <textarea id="descInput" maxlength="200" rows="3" placeholder="${descPlaceholder}" required></textarea>
          </label>
          ${t.restriction ? restrictionCard(t.restriction) : ''}
          <button class="btn red" type="submit">传下去 →</button>
        </form>
      </section>`;
  }

  const prev = `
    <section class="prev tape anim">
      <div class="prev-label">上一棒 · ${esc(t.prevPlayer)} 的描述</div>
      <p class="prev-text">“${esc(t.prevDescription)}”</p>
    </section>`;

  if (stage === 'describe' && !t.last) {
    return `
      ${prev}
      <section class="locked anim">
        <span class="tag">你的答案</span>
        <div class="big-word">${esc(guessDraft)}</div>
      </section>
      <section class="panel anim" style="animation-delay:60ms">
        <div class="turn-label">现在由你描述它</div>
        <p class="lead">用你自己的话描述<b>你猜的这个词</b>,别说出它本身。</p>
        ${t.restriction ? restrictionCard(t.restriction) : ''}
        <form id="descForm">
          <label class="field">
            <span>你的描述(交给下一个人)</span>
            <textarea id="descInput2" maxlength="200" rows="3" placeholder="换一种说法,让下一个人猜" required></textarea>
          </label>
          <button class="btn red" type="submit">传下去 →</button>
        </form>
      </section>`;
  }

  return `
    ${prev}
    <section class="panel anim" style="animation-delay:60ms">
      <div class="turn-label">${t.last ? '最后一棒 · 猜' : '你来猜'}</div>
      <p class="lead">${t.last
        ? '读完这句话,写下你猜的词。提交后就揭晓全部答案。'
        : '读上面那句话,猜猜描述者原本想的是什么词。'}</p>
      <form id="guessForm">
        <label class="field">
          <span>你猜是</span>
          <input id="guessInput" type="text" maxlength="20" placeholder="写一个词" autocomplete="off" required>
        </label>
        <button class="btn ${t.last ? 'red' : ''}" type="submit">${t.last ? '揭晓答案' : '锁定答案'}</button>
      </form>
    </section>`;
}

function chainMeta(s) {
  const parts = [];
  if (s.category) parts.push(`<span>类别 <b>${esc(s.category)}</b></span>`);
  if (s.mole) parts.push(`<span>卧底 <b>${esc(s.mole.name)}</b></span>`);
  if (!parts.length) return '';
  return `<div class="chain-meta anim">${parts.join('<i></i>')}</div>`;
}

function perfectBanner(s) {
  if (!s.perfect) return '';
  return `
    <div class="perfect-banner anim">
      <div class="perfect-stamp">完美接龙</div>
      <p>最后一棒一字不差地猜回了原词「${esc(s.originalWord)}」。</p>
    </div>`;
}

function chainHtml(s) {
  const parts = [];

  parts.push(`
    <div class="chain-start anim">
      <span class="tag">原始词</span>
      <div class="big-word">${esc(s.originalWord)}</div>
    </div>`);

  s.turns.forEach((t, i) => {
    parts.push(`
      <article class="chain-item anim" style="animation-delay:${50 + i * 55}ms">
        <div class="who"><span class="no">${String(i + 1).padStart(2, '0')}</span><span>${esc(t.player)}</span></div>
        ${t.guess ? `<div class="guess">猜:<b>${esc(t.guess)}</b></div>` : ''}
        ${t.description ? `<blockquote>${esc(t.description)}</blockquote>` : ''}
        ${t.restriction ? `<div class="restriction-line">限制 · ${esc(t.restriction)}</div>` : ''}
      </article>`);
  });

  const finalGuess = s.turns.length ? s.turns[s.turns.length - 1].guess : '';

  parts.push(`
    <div class="chain-end anim">
      <span class="tag">最终答案</span>
      <div class="big-word">${esc(finalGuess || '?')}</div>
    </div>`);

  return `<section class="chain">${parts.join('')}</section>`;
}

function voteView(s) {
  const total = s.players.length;
  const voted = s.votesCount || 0;

  let voteBody;

  if (s.myVote) {
    const target = s.players.find((p) => p.id === s.myVote);
    voteBody = `
      <p class="voted-note">你投给了 <b>${esc(target ? target.name : '?')}</b>,等其他人投票…</p>`;
  } else {
    const options = s.players
      .filter((p) => p.id !== s.me.id)
      .map((p) => `<button type="button" class="vote-opt" data-vote="${esc(p.id)}">${esc(p.name)}</button>`)
      .join('');

    voteBody = `
      <h2 class="vote-title">谁把话带歪了?</h2>
      <p class="hint" style="margin-top:4px">选出本回合最猪的人。</p>
      <div class="vote-grid">${options}</div>
      <button class="btn red" id="castVote" disabled>就投他</button>`;
  }

  const moleHint = s.options.mole
    ? '<p class="hint" style="text-align:center;margin:-4px 0 16px">本局有卧底。投完最猪后,还有一轮「猜卧底」。</p>'
    : '';

  return shell(s, `
    <div class="round-banner anim">本回合结束 · 答案揭晓</div>
    <div class="anim">${moleHint}</div>
    ${perfectBanner(s)}
    ${chainMeta(s)}
    ${chainHtml(s)}
    <section class="panel anim">
      ${voteBody}
      <p class="tally">已投 ${voted} / ${total}</p>
      ${voted > 0 ? `<button class="btn ghost mini" id="finishVote">人齐不了?直接开奖</button>` : ''}
    </section>
  `);
}

function moleVoteView(s) {
  const total = s.moleVotersCount || 0;
  const voted = s.moleVotesCount || 0;

  let body;

  if (s.isMole) {
    body = `
      <div class="mole-note">
        <span class="tag">你是卧底</span>
        <p>这一轮你不能投票。看看大家能不能猜到你。</p>
      </div>
      <p class="tally">已投 ${voted} / ${total}</p>`;
  } else if (s.myMoleVote) {
    const target = s.players.find((p) => p.id === s.myMoleVote);
    body = `
      <p class="voted-note">你猜的是 <b>${esc(target ? target.name : '?')}</b>,等其他人…</p>
      <p class="tally">已投 ${voted} / ${total}</p>`;
  } else {
    const options = s.players
      .filter((p) => p.id !== s.me.id)
      .map((p) => `<button type="button" class="vote-opt" data-mole-vote="${esc(p.id)}">${esc(p.name)}</button>`)
      .join('');

    body = `
      <h2 class="vote-title">谁是卧底?</h2>
      <p class="hint" style="margin-top:4px">匿名投票,卧底本人不参与。</p>
      <div class="vote-grid">${options}</div>
      <button class="btn red" id="castMoleVote" disabled>就猜他</button>
      <p class="tally">已投 ${voted} / ${total}</p>
      ${voted > 0 ? '<button class="btn ghost mini" id="finishMoleVote">人齐不了?直接开奖</button>' : ''}`;
  }

  return shell(s, `
    <div class="round-banner anim">最后一轮 · 猜卧底</div>
    ${perfectBanner(s)}
    ${chainMeta(s)}
    ${chainHtml(s)}
    <section class="panel anim">
      ${body}
    </section>
  `);
}

function resultView(s) {
  const r = s.result;
  const winners = r ? r.winners : [];
  const max = r ? r.max : 0;
  const names = winners.map((w) => w.name).join('、');

  const counts = (r ? r.counts : []).map((c) => `
    <div class="count-row">
      <span class="count-name">${esc(c.name)}</span>
      <span class="count-bar"><i style="width:${max ? Math.round((c.count / max) * 100) : 0}%"></i></span>
      <span class="count-num mono">${c.count}</span>
    </div>`).join('');

  const mole = r && r.mole;
  let moleBlock = '';

  if (mole) {
    const guessed = mole.guessed.length
      ? mole.guessed.map((g) => g.name).join('、')
      : '没有人';
    const moleCounts = mole.counts.map((c) => `
      <div class="count-row">
        <span class="count-name">${esc(c.name)}</span>
        <span class="count-bar"><i style="width:${mole.max ? Math.round((c.count / mole.max) * 100) : 0}%"></i></span>
        <span class="count-num mono">${c.count}</span>
      </div>`).join('');

    moleBlock = `
      <section class="panel anim">
        <div class="turn-label">卧底竞猜</div>
        <div class="mole-reveal">
          <div class="mole-line"><span>真卧底</span><b>${esc(mole.actual.name)}</b></div>
          <div class="mole-line"><span>大家猜</span><b>${esc(guessed)}</b></div>
          <div class="mole-verdict ${mole.correct ? 'caught' : 'escaped'}">${mole.correct ? '抓到了' : '没抓到'}</div>
        </div>
        <div style="margin-top:16px">${moleCounts}</div>
      </section>`;
  }

  return shell(s, `
    ${s.spectator ? spectatorBanner(s) : ''}
    ${perfectBanner(s)}
    <section class="panel pig-card anim">
      <div class="tag">第 ${s.roundNo} 回合</div>
      <div class="pig-name">${winners.length ? esc(names) : '无人'}</div>
      ${winners.length
        ? '<div class="stamp">最猪的人</div>'
        : '<div class="stamp neutral">本轮无人夺魁</div>'}
      <p class="hint">${winners.length ? '得票最多,荣获本回合「最猪」称号。' : '一票都没有,大家都很靠谱。'}</p>
    </section>
    ${moleBlock}
    ${s.spectator ? '' : '<button class="btn" id="againBtn">再来一局</button>'}
    <section class="panel anim" style="margin-top:16px">
      <div class="turn-label">得票</div>
      ${counts}
    </section>
    ${chainMeta(s)}
    ${chainHtml(s)}
  `);
}

// ---------------------------------------------------------------------------
// 默契挑战
// ---------------------------------------------------------------------------

function wordSourceText(source) {
  if (source === 'carry') return '超时,沿用上一轮的词';
  if (source === 'missed') return '超时未答';
  if (source === 'offline') return '离线弃权';
  return '';
}

function matchWordTag(w) {
  const text = wordSourceText(w.source);
  return text ? `<small class="word-tag">${text}</small>` : '';
}

function matchTurnbar(s, label) {
  return `
    <div class="turnbar">
      <span>${label}</span>
      <span class="bar"></span>
      <span class="countdown mono" id="countdown"></span>
    </div>`;
}

function lastRoundHtml(round, label) {
  const items = round.words.map((w) => `
    <div class="lr-item ${w.source === 'offline' ? 'muted' : ''}">
      <span class="lr-name">${esc(w.name)}</span>
      <b class="lr-word">${w.word ? esc(w.word) : '未答'}</b>
      ${matchWordTag(w)}
    </div>`).join('');

  return `
    <section class="last-round anim">
      <div class="lr-head">
        <span class="tag">${label} · 第 ${round.round} 轮</span>
        <span class="hint-inline">大家说的</span>
      </div>
      <div class="lr-words">${items}</div>
    </section>`;
}

function matchFormHtml(s) {
  const m = s.match;
  const hasPrev = m.history.length > 0;

  return `
    <section class="panel anim">
      <div class="turn-label">写下你的词</div>
      <p class="lead">${hasPrev
        ? '看看上一轮大家说的,写一个能把大家拉近的词。'
        : m.theme
          ? '凭第一反应写一个词,别商量。'
          : '本局不指定主题,想到什么就写什么。'}</p>
      <form id="matchForm">
        <label class="field">
          <span>你的词(1–8 字,提交后不能改)</span>
          <input id="matchWordInput" type="text" maxlength="8" placeholder="第一反应" autocomplete="off" required>
        </label>
        <button class="btn red" type="submit">提交</button>
      </form>
    </section>`;
}

function matchWaitingHtml(s) {
  return `
    <section class="locked anim">
      <span class="tag">你已提交</span>
      <div class="big-word">${esc(s.match.myWord)}</div>
      <p class="hint">等其他人交卷,全部交齐会立刻揭晓。</p>
    </section>`;
}

function matchPlayersHtml(s) {
  const m = s.match;
  const players = m.players.map((p) => `
    <div class="match-player ${p.submitted ? 'done' : ''} ${p.online ? '' : 'off'}" data-m-player="${esc(p.id)}">
      <span class="mp-name">${esc(p.name)}</span>
      <span class="mp-state">${!p.online ? '离线' : p.submitted ? '已提交' : '在写…'}</span>
    </div>`).join('');

  return `
    <div class="match-players">${players}</div>
    <p class="tally">已提交 <b id="matchSubmittedCount">${m.submittedCount}</b> / <span id="matchOnlineCount">${m.onlineCount}</span> 在线</p>`;
}

function themeCardHtml(m) {
  if (!m.theme) {
    return `
    <section class="theme-card tape free anim">
      <span class="tag">自由起手</span>
      <div class="theme-word">想到什么写什么</div>
      <p class="hint">本局不指定主题,凭第一直觉写一个词。</p>
    </section>`;
  }

  return `
    <section class="theme-card tape anim">
      <span class="tag">本局主题</span>
      <div class="theme-word">${esc(m.theme)}</div>
      <p class="hint">想到什么就写什么,1–8 个字。交卷前看不到别人。</p>
    </section>`;
}

function matchInputInner(s) {
  const m = s.match;
  const last = m.history.length ? m.history[m.history.length - 1] : null;

  return `
    ${matchTurnbar(s, `第 ${m.round} 轮 · 每轮 ${m.matchSeconds}s`)}
    ${themeCardHtml(m)}
    ${last ? lastRoundHtml(last, '上一轮') : ''}
    ${m.myWord ? matchWaitingHtml(s) : matchFormHtml(s)}
    ${matchPlayersHtml(s)}`;
}

function matchRevealInner(s) {
  const m = s.match;
  const reveal = m.reveal;

  if (!reveal) {
    return matchTurnbar(s, `第 ${m.round} 轮 · 揭晓`);
  }

  const items = reveal.words.map((w, i) => `
    <div class="rw-item ${w.source === 'offline' ? 'muted' : ''}" style="animation-delay:${i * 60}ms">
      <span class="rw-name">${esc(w.name)}</span>
      <b class="rw-word">${w.word ? esc(w.word) : '—'}</b>
      ${matchWordTag(w)}
    </div>`).join('');

  const notes = reveal.words
    .filter((w) => w.source !== 'submit')
    .map((w) => `${esc(w.name)}:${wordSourceText(w.source)}`)
    .join(' · ');

  return `
    ${matchTurnbar(s, `第 ${reveal.round} 轮 · 揭晓`)}
    <section class="panel reveal-panel anim">
      <div class="turn-label">本轮所有人的词</div>
      <div class="reveal-words">${items}</div>
      ${notes ? `<p class="reveal-note">${notes}</p>` : ''}
    </section>
    <p class="reveal-next">对不上?下一轮继续联想,倒计时结束自动开始。</p>`;
}

function matchView(s) {
  const m = s.match;
  if (!m) return spectatorView(s);

  const inner = m.stage === 'reveal' ? matchRevealInner(s) : matchInputInner(s);
  const endBtn = s.isHost
    ? '<button class="btn ghost mini" id="endMatchBtn">结束本局</button>'
    : '';

  return shell(s, `${inner}${endBtn}`);
}

function trajectoryHtml(history, finalRound) {
  if (!history.length) {
    return '<p class="hint" style="text-align:center">本局还没有走完任何一轮。</p>';
  }

  const rounds = history.map((r) => {
    const isFinal = finalRound && r.round === finalRound.round;
    const words = r.words.map((w) => `
      <div class="traj-word ${w.source === 'submit' ? '' : 'muted'}">
        <span>${esc(w.name)}</span>
        <b>${w.word ? esc(w.word) : '—'}</b>
        ${matchWordTag(w)}
      </div>`).join('');

    return `
      <div class="traj-round ${isFinal ? 'final' : ''}">
        <div class="traj-head">
          <span class="no">${String(r.round).padStart(2, '0')}</span>
          <span>第 ${r.round} 轮</span>
          ${isFinal ? '<span class="traj-final-tag">相遇</span>' : ''}
        </div>
        <div class="traj-words">${words}</div>
      </div>`;
  }).join('');

  return `
    <section class="trajectory anim">
      <div class="turn-label">思维轨迹</div>
      ${rounds}
    </section>`;
}

function matchResultView(s) {
  const m = s.match;
  if (!m) {
    return shell(s, `
      ${s.spectator ? spectatorBanner(s) : ''}
      <section class="panel waiting anim">
        <p class="wait-name">本局已结束</p>
      </section>`);
  }

  const reasonText = m.matched
    ? `全员在第 ${m.rounds} 轮说出了同一个词`
    : m.reason === 'players'
      ? '在线人数不足 2 人,本局提前结束'
      : m.rounds
        ? `房主结束了本局,一共走了 ${m.rounds} 轮`
        : '还没走完一轮,房主就结束了本局';

  const finalRound = m.matched && m.history.length
    ? m.history[m.history.length - 1]
    : null;
  const themeLabel = m.theme ? `主题「${esc(m.theme)}」` : '自由起手';

  return shell(s, `
    ${s.spectator ? spectatorBanner(s) : ''}
    <section class="panel pig-card anim">
      <div class="tag">默契挑战 · ${themeLabel}</div>
      <div class="pig-name">${esc(m.rating)}</div>
      ${m.matched
        ? '<div class="stamp">相遇成功</div>'
        : '<div class="stamp neutral">没能相遇</div>'}
      <p class="hint">${reasonText}</p>
    </section>
    ${trajectoryHtml(m.history, finalRound)}
    ${s.spectator ? '' : '<button class="btn" id="againBtn">再来一局</button>'}
  `);
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

async function submitEntry(event, url, form) {
  event.preventDefault();

  const code = document.getElementById('entryCode').value.trim();
  const name = document.getElementById('entryName').value.trim();
  if (!/^\d{6}$/.test(code)) {
    toast('房间码必须是 6 位数字');
    return;
  }
  if (!name) {
    toast('先起个名字');
    return;
  }

  const btn = form.querySelector('button');
  btn.disabled = true;
  const result = await post(url, { code, name });
  if (!result) {
    btn.disabled = false;
    return;
  }

  savedName = name;
  localStorage.setItem('tt_name', name);
  roomCode = result.room;
  localStorage.setItem('tt_room', roomCode);

  if (result.spectator) {
    pid = '';
    spectator = true;
    localStorage.removeItem('tt_pid');
    localStorage.setItem('tt_spectator', '1');
  } else {
    pid = result.pid;
    spectator = false;
    localStorage.setItem('tt_pid', pid);
    localStorage.removeItem('tt_spectator');
  }

  state = null;
  lastKey = '';
  connect();
}

function bind(s) {
  document.querySelectorAll('[data-entry-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.entryTab === entryTab) return;
      entryTab = btn.dataset.entryTab;
      renderNow();
    });
  });

  const createForm = document.getElementById('createForm');
  if (createForm) {
    createForm.addEventListener('submit', (event) => submitEntry(event, '/api/room/create', createForm));
  }

  const joinForm = document.getElementById('joinForm');
  if (joinForm) {
    joinForm.addEventListener('submit', (event) => submitEntry(event, '/api/room/join', joinForm));
  }

  const entryCode = document.getElementById('entryCode');
  if (entryCode) {
    entryCode.addEventListener('input', () => {
      entryCode.value = entryCode.value.replace(/\D/g, '').slice(0, 6);
    });
  }

  const spectatorJoinBtn = document.getElementById('spectatorJoinBtn');
  if (spectatorJoinBtn) {
    spectatorJoinBtn.addEventListener('click', async () => {
      if (!savedName) {
        toast('先起个名字');
        return;
      }
      spectatorJoinBtn.disabled = true;
      const result = await post('/api/room/join', { code: s.roomCode, name: savedName });
      if (!result) {
        spectatorJoinBtn.disabled = false;
        return;
      }
      if (result.spectator) {
        toast('本局已经开始了,继续旁观');
        renderNow();
        return;
      }
      pid = result.pid;
      spectator = false;
      roomCode = result.room;
      localStorage.setItem('tt_pid', pid);
      localStorage.setItem('tt_room', roomCode);
      localStorage.removeItem('tt_spectator');
      connect();
    });
  }

  if (s.isHost && s.phase === 'lobby') {
    document.querySelectorAll('.opt input[type="checkbox"]').forEach((el) => {
      el.addEventListener('change', async () => {
        let options;

        if (el.id === 'optTheme') {
          // 默契挑战只改主题开关,其余选项由服务端保持原样
          options = { theme: el.checked };
        } else {
          options = {
            mole: document.getElementById('optMole').checked,
            restriction: document.getElementById('optRestriction').checked,
            category: document.getElementById('optCategory').checked,
            history: document.getElementById('optHistory').checked,
          };
        }

        const result = await post('/api/options', { pid, options });
        if (!result) renderNow();
      });
    });

    document.querySelectorAll('.mode-card').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.classList.contains('active')) return;
        document.querySelectorAll('.mode-card').forEach((el) => { el.disabled = true; });
        const result = await post('/api/mode', { pid, mode: btn.dataset.mode });
        if (!result) renderNow();
      });
    });
  }

  const matchForm = document.getElementById('matchForm');
  if (matchForm) {
    matchForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = document.getElementById('matchWordInput').value.trim();
      if (!value) {
        toast('先写一个词');
        return;
      }
      if (Array.from(value).length > 8) {
        toast('最多 8 个字');
        return;
      }

      const btn = matchForm.querySelector('button');
      btn.disabled = true;
      const result = await post('/api/match-submit', { pid, word: value });
      if (!result) btn.disabled = false;
    });
  }

  const endMatchBtn = document.getElementById('endMatchBtn');
  if (endMatchBtn) {
    endMatchBtn.addEventListener('click', async () => {
      if (!confirm('确定结束本局?还没揭晓的当前轮不计入轨迹。')) return;
      endMatchBtn.disabled = true;
      const result = await post('/api/match-end', { pid });
      if (!result) endMatchBtn.disabled = false;
    });
  }

  const startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      const result = await post('/api/start', { pid });
      if (!result) startBtn.disabled = false;
    });
  }

  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('确定清空牌桌上所有人?')) return;
      resetBtn.disabled = true;
      const result = await post('/api/reset', { pid });
      if (result) {
        resetToEntry();
      } else {
        resetBtn.disabled = false;
      }
    });
  }

  const kickOfflineBtn = document.getElementById('kickOfflineBtn');
  if (kickOfflineBtn) {
    kickOfflineBtn.addEventListener('click', async () => {
      if (!confirm('把当前离线的玩家移出牌桌?')) return;
      kickOfflineBtn.disabled = true;
      const result = await post('/api/kick-offline', { pid });
      if (!result) kickOfflineBtn.disabled = false;
    });
  }

  const firstForm = document.getElementById('firstForm');
  if (firstForm) {
    firstForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const word = document.getElementById('wordInput').value.trim();
      const description = document.getElementById('descInput').value.trim();
      if (!word || !description) {
        toast('词和描述都要写');
        return;
      }

      const btn = firstForm.querySelector('button');
      btn.disabled = true;
      const result = await post('/api/submit', { pid, word, description });
      if (!result) btn.disabled = false;
    });
  }

  const guessForm = document.getElementById('guessForm');
  if (guessForm) {
    guessForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = document.getElementById('guessInput').value.trim();
      if (!value) {
        toast('先写一个你猜的词');
        return;
      }

      // 最后一棒:直接提交,揭晓
      if (s.turn && s.turn.last) {
        const btn = guessForm.querySelector('button');
        btn.disabled = true;
        const result = await post('/api/submit', { pid, guess: value });
        if (!result) btn.disabled = false;
        return;
      }

      // 中间棒:先把猜测交给服务端(超时兜底),再进入描述
      const btn = guessForm.querySelector('button');
      btn.disabled = true;
      const result = await post('/api/guess', { pid, guess: value });
      if (!result) {
        btn.disabled = false;
        return;
      }

      guessDraft = value;
      stage = 'describe';
      renderNow();
    });
  }

  const descForm = document.getElementById('descForm');
  if (descForm) {
    descForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = document.getElementById('descInput2').value.trim();
      if (!value) {
        toast('写一句描述再传下去');
        return;
      }

      const btn = descForm.querySelector('button');
      btn.disabled = true;
      const result = await post('/api/submit', { pid, guess: guessDraft, description: value });
      if (!result) btn.disabled = false;
    });
  }

  document.querySelectorAll('.vote-opt[data-vote]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedVote = btn.dataset.vote;
      document.querySelectorAll('.vote-opt[data-vote]').forEach((el) => {
        el.classList.toggle('selected', el === btn);
      });
      const castBtn = document.getElementById('castVote');
      if (castBtn) castBtn.disabled = false;
    });
  });

  // 重渲染后恢复投票选择
  if (s.phase === 'vote' && selectedVote) {
    const chosen = document.querySelector(`.vote-opt[data-vote="${selectedVote}"]`);
    if (chosen) {
      chosen.classList.add('selected');
      const castBtn = document.getElementById('castVote');
      if (castBtn) castBtn.disabled = false;
    }
  }

  document.querySelectorAll('.vote-opt[data-mole-vote]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedMoleVote = btn.dataset.moleVote;
      document.querySelectorAll('.vote-opt[data-mole-vote]').forEach((el) => {
        el.classList.toggle('selected', el === btn);
      });
      const castBtn = document.getElementById('castMoleVote');
      if (castBtn) castBtn.disabled = false;
    });
  });

  if (s.phase === 'molevote' && selectedMoleVote) {
    const chosen = document.querySelector(`.vote-opt[data-mole-vote="${selectedMoleVote}"]`);
    if (chosen) {
      chosen.classList.add('selected');
      const castBtn = document.getElementById('castMoleVote');
      if (castBtn) castBtn.disabled = false;
    }
  }

  const castVote = document.getElementById('castVote');
  if (castVote) {
    castVote.addEventListener('click', async () => {
      if (!selectedVote) return;
      castVote.disabled = true;
      const result = await post('/api/vote', { pid, targetId: selectedVote });
      if (result) {
        selectedVote = null;
      } else {
        castVote.disabled = false;
      }
    });
  }

  const castMoleVote = document.getElementById('castMoleVote');
  if (castMoleVote) {
    castMoleVote.addEventListener('click', async () => {
      if (!selectedMoleVote) return;
      castMoleVote.disabled = true;
      const result = await post('/api/mole-vote', { pid, targetId: selectedMoleVote });
      if (result) {
        selectedMoleVote = null;
      } else {
        castMoleVote.disabled = false;
      }
    });
  }

  const finishVote = document.getElementById('finishVote');
  if (finishVote) {
    finishVote.addEventListener('click', async () => {
      finishVote.disabled = true;
      const result = await post('/api/finish-vote', { pid });
      if (!result) finishVote.disabled = false;
    });
  }

  const finishMoleVote = document.getElementById('finishMoleVote');
  if (finishMoleVote) {
    finishMoleVote.addEventListener('click', async () => {
      finishMoleVote.disabled = true;
      const result = await post('/api/finish-mole-vote', { pid });
      if (!result) finishMoleVote.disabled = false;
    });
  }

  const againBtn = document.getElementById('againBtn');
  if (againBtn) {
    againBtn.addEventListener('click', async () => {
      againBtn.disabled = true;
      const result = await post('/api/again', { pid });
      if (!result) againBtn.disabled = false;
    });
  }
}

// ---------------------------------------------------------------------------
// 输入框聚焦
// ---------------------------------------------------------------------------

function focusFor(s) {
  let id = null;

  if (s.phase === 'entry') {
    const codeEl = document.getElementById('entryCode');
    id = codeEl && codeEl.value.length === 6 ? 'entryName' : 'entryCode';
  } else if (s.phase === 'playing' && s.turn) {
    if (s.turn.first) id = 'wordInput';
    else if (stage === 'guess') id = 'guessInput';
    else id = 'descInput2';
  } else if (s.phase === 'match' && s.match && s.match.stage === 'input' && !s.match.myWord) {
    id = 'matchWordInput';
  }

  if (!id) return;

  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) el.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------------------
// 完美接龙礼炮
// ---------------------------------------------------------------------------

function fireConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);

  const colors = ['#b3362a', '#d4a62a', '#3e6355', '#d47a3a', '#f7f0df', '#221b13'];
  const pieces = [];
  const count = 160;

  for (let i = 0; i < count; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const angle = -Math.PI / 2 - side * 0.42 + (Math.random() - 0.5) * 0.35;
    const speed = 7.5 + Math.random() * 7;

    pieces.push({
      x: width * (side === -1 ? 0.06 : 0.94),
      y: height * 0.98,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 7,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      wobble: Math.random() * Math.PI * 2,
      life: 0,
    });
  }

  const startedAt = performance.now();
  const duration = 4200;

  function frame(now) {
    const elapsed = now - startedAt;
    ctx.clearRect(0, 0, width, height);

    for (const p of pieces) {
      p.life += 1;
      p.vy += 0.22;
      p.vx *= 0.995;
      p.vy *= 0.995;
      p.x += p.vx + Math.sin(p.wobble + p.life * 0.08) * 0.6;
      p.y += p.vy;
      p.rotation += p.spin;

      const fade = Math.max(0, 1 - Math.max(0, elapsed - 3000) / 1200);

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.62);
      ctx.restore();
    }

    if (elapsed < duration) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// 倒计时(用收到视图时的剩余毫秒数校准,不依赖设备时钟)
// ---------------------------------------------------------------------------

function updateCountdown() {
  const el = document.getElementById('countdown');
  if (!el) return;

  let left = null;

  if (state && state.phase === 'playing' && state.turnTimeLeft != null) {
    left = state.turnTimeLeft - (Date.now() - stateReceivedAt);
  } else if (state && state.phase === 'match' && state.match && state.match.timeLeft != null) {
    left = state.match.timeLeft - (Date.now() - stateReceivedAt);
  }

  if (left == null) {
    el.textContent = '';
    el.classList.remove('urgent');
    return;
  }

  if (left <= 0) {
    el.textContent = state.phase === 'match' ? '…' : '超时';
    el.classList.add('urgent');
    return;
  }

  el.textContent = `${Math.ceil(left / 1000)}s`;
  const canBeUrgent = state.phase === 'playing'
    || (state.match && state.match.stage === 'input');
  el.classList.toggle('urgent', canBeUrgent && left <= 10000);
}

// 默契挑战的提交状态用轻量 DOM 更新,避免玩家正在输入时整页重建
function syncMatchLive() {
  if (!state || !state.match || !state.match.players) return;

  const m = state.match;
  const byId = new Map(m.players.map((p) => [p.id, p]));

  document.querySelectorAll('[data-m-player]').forEach((el) => {
    const p = byId.get(el.dataset.mPlayer);
    if (!p) return;
    el.classList.toggle('done', !!p.submitted);
    el.classList.toggle('off', !p.online);
    const st = el.querySelector('.mp-state');
    if (st) st.textContent = !p.online ? '离线' : p.submitted ? '已提交' : '在写…';
  });

  const submittedEl = document.getElementById('matchSubmittedCount');
  if (submittedEl) submittedEl.textContent = String(m.submittedCount ?? 0);
  const onlineEl = document.getElementById('matchOnlineCount');
  if (onlineEl) onlineEl.textContent = String(m.onlineCount ?? 0);
}

setInterval(() => {
  updateCountdown();
  syncMatchLive();
}, 250);

// ---------------------------------------------------------------------------

if (pid || (roomCode && spectator)) {
  connect();
} else {
  state = makeEntryState();
  renderNow();
}
