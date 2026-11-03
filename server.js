#!/usr/bin/env node
'use strict';

/**
 * 小游戏桌 —— 多房间 HTTP + SSE 服务
 * 零依赖:Node 内置模块;每个房间的游戏逻辑在 room.js。
 *
 * 启动:node server.js
 * 端口:默认 3000,可用 PORT 环境变量覆盖
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createRoom, json, clean } = require('./room');
const stats = require('./stats');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MAX_ROOMS = 50;

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

// 房间码 -> 房间实例
const rooms = new Map();

function findRoomByPid(pid) {
  if (!pid) return null;
  for (const room of rooms.values()) {
    if (room.hasPlayer(pid)) return room;
  }
  return null;
}

function deleteRoom(room) {
  if (rooms.get(room.code) !== room) return;
  rooms.delete(room.code);
  room.destroy();
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
// 房间创建 / 加入
// ---------------------------------------------------------------------------

function apiCreateRoom(res, data) {
  const code = String(data.code || '').trim();
  const name = clean(data.name, 12);

  if (!/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, error: '房间码必须是 6 位数字' });
  }
  if (!name) {
    return json(res, 400, { ok: false, error: '先起个名字' });
  }
  if (rooms.size >= MAX_ROOMS) {
    return json(res, 409, { ok: false, error: `房间数已满(最多 ${MAX_ROOMS} 间)` });
  }
  if (rooms.has(code)) {
    return json(res, 409, { ok: false, error: '这个房间码已经被占用了,换一个' });
  }

  let room;
  room = createRoom(code, {
    onDelete: () => deleteRoom(room),
    onGameStart: (mode) => stats.gameStarted(code, mode),
    onGameEnd: (mode) => stats.gameEnded(code, mode),
  });
  rooms.set(code, room);
  const pid = room.addPlayer(name);
  stats.roomCreated(code, name);

  json(res, 200, { ok: true, pid, room: code, mode: room.game.mode });
}

function apiJoinRoom(res, data) {
  const code = String(data.code || '').trim();
  const name = clean(data.name, 12);

  if (!/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, error: '房间码必须是 6 位数字' });
  }

  const room = rooms.get(code);
  if (!room) {
    return json(res, 404, { ok: false, error: '房间不存在' });
  }

  const game = room.game;

  // 游戏已经开始:允许旁观,但不占用玩家席位。
  if (game.phase !== 'lobby') {
    stats.spectatorJoined(code, name);
    return json(res, 200, { ok: true, spectator: true, room: code, mode: game.mode });
  }

  if (!name) {
    return json(res, 400, { ok: false, error: '先起个名字' });
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

  const pid = room.addPlayer(name);
  stats.playerJoined(code, name);
  json(res, 200, { ok: true, pid, room: code, mode: game.mode });
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  let data;
  try {
    data = await readJson(req);
  } catch (err) {
    return json(res, 400, { ok: false, error: '请求格式不对' });
  }

  try {
    if (url.pathname === '/api/room/create') {
      return apiCreateRoom(res, data);
    }
    if (url.pathname === '/api/room/join') {
      return apiJoinRoom(res, data);
    }

    const room = findRoomByPid(data.pid);
    if (!room) {
      return json(res, 403, { ok: false, error: '房间不存在或你已不在房间里' });
    }
    return room.handleAction(url.pathname, data, res);
  } catch (err) {
    console.error('[api error]', err);
    return json(res, 500, { ok: false, error: '服务器出错了' });
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function noRoom(res) {
  res.writeHead(200, SSE_HEADERS);
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ noRoom: true })}\n\n`);
  res.end();
}

function handleEvents(req, res, url) {
  const pid = url.searchParams.get('pid') || '';
  const code = url.searchParams.get('room') || '';

  let room = pid ? findRoomByPid(pid) : null;
  if (!room && code) room = rooms.get(code);
  if (!room) return noRoom(res);

  // pid 不在这个房间时按旁观处理;真正决定权限的是 room.hasPlayer。
  const effectivePid = pid && room.hasPlayer(pid) ? pid : '';
  room.handleEvents(req, res, effectivePid);
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
// 本机统计页
// ---------------------------------------------------------------------------

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escHtml(iso);
  return escHtml(d.toLocaleString('zh-CN', { hour12: false }));
}

function serveStats(req, res) {
  const addr = req.socket.remoteAddress || '';
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!local) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('统计页只允许在本机通过 http://localhost:3000/stats 访问。');
  }

  const s = stats.snapshot();
  const players = Object.entries(s.players)
    .map(([name, v]) => ({
      name,
      joins: v.joins || 0,
      spectators: v.spectators || 0,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
    }))
    .filter((p) => p.joins > 0 || p.spectators > 0)
    .sort((a, b) => (b.joins - a.joins)
      || (b.spectators - a.spectators)
      || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));

  const uniquePlayers = players.filter((p) => p.joins > 0).length;
  const uniqueSpectators = players.filter((p) => p.spectators > 0).length;

  const phaseLabels = {
    lobby: '大厅',
    playing: '传声筒中',
    vote: '最猪投票',
    molevote: '猜卧底',
    result: '结算',
    match: '默契挑战中',
    matchresult: '默契结算',
  };

  const live = [...rooms.values()].map((r) => {
    const onlinePids = new Set([...r.clients.values()].map((c) => c.pid).filter(Boolean));
    return {
      code: r.code,
      mode: r.game.mode === 'match' ? '默契挑战' : '传声筒',
      phase: phaseLabels[r.game.phase] || r.game.phase,
      players: r.game.players.length,
      online: r.game.players.filter((p) => onlinePids.has(p.id)).length,
      spectators: [...r.clients.values()].filter((c) => !c.pid).length,
    };
  });

  const playerRows = players.length
    ? players.map((p) => `
        <tr>
          <td>${escHtml(p.name)}</td>
          <td class="num">${p.joins}</td>
          <td class="num">${p.spectators}</td>
          <td>${fmtTime(p.firstSeen)}</td>
          <td>${fmtTime(p.lastSeen)}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="stats-empty">还没有记录</td></tr>';

  const liveRows = live.length
    ? live.map((r) => `
        <tr>
          <td class="mono">${escHtml(r.code)}</td>
          <td>${escHtml(r.mode)}</td>
          <td>${escHtml(r.phase)}</td>
          <td class="num">${r.online} / ${r.players}</td>
          <td class="num">${r.spectators}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="stats-empty">当前没有活跃房间</td></tr>';

  const eventLabels = {
    create: '创建房间',
    join: '加入玩家',
    spectate: '旁观',
    start: '开局',
    end: '结束',
  };
  const eventRows = s.events.length
    ? s.events.slice(0, 60).map((e) => `
        <tr>
          <td>${fmtTime(e.at)}</td>
          <td>${escHtml(eventLabels[e.type] || e.type)}</td>
          <td class="mono">${escHtml(e.room || '—')}</td>
          <td>${escHtml(e.name || '—')}</td>
          <td>${escHtml(e.mode === 'match' ? '默契挑战' : e.mode === 'chain' ? '传声筒' : '')}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="stats-empty">还没有事件</td></tr>';

  const started = s.gamesStarted || {};
  const finished = s.gamesFinished || {};

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>小游戏桌 · 统计</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="wrap">
    <header class="masthead">
      <div class="seal">统计</div>
      <div class="eyebrow">本机查看</div>
      <h1>玩过的人</h1>
      <div class="rule"></div>
    </header>

    <section class="panel anim">
      <div class="stats-grid">
        <div class="stats-card"><span>累计创建房间</span><b>${s.roomsCreated || 0}</b></div>
        <div class="stats-card"><span>玩家人次</span><b>${s.playerJoins || 0}</b></div>
        <div class="stats-card"><span>唯一玩家名</span><b>${uniquePlayers}</b></div>
        <div class="stats-card"><span>旁观人次</span><b>${s.spectatorJoins || 0}</b><small>${uniqueSpectators} 个名字</small></div>
        <div class="stats-card"><span>传声筒开局</span><b>${started.chain || 0}</b><small>完成 ${finished.chain || 0}</small></div>
        <div class="stats-card"><span>默契挑战开局</span><b>${started.match || 0}</b><small>完成 ${finished.match || 0}</small></div>
        <div class="stats-card"><span>当前活跃房间</span><b>${live.length}</b></div>
      </div>
      <p class="hint">最后一次更新:${fmtTime(s.updatedAt)}</p>
    </section>

    <section class="panel anim">
      <div class="turn-label">玩家名单</div>
      <div class="stats-scroll">
        <table class="stats-table">
          <thead><tr><th>名字</th><th>玩家加入</th><th>旁观</th><th>首次出现</th><th>最近出现</th></tr></thead>
          <tbody>${playerRows}</tbody>
        </table>
      </div>
    </section>

    <section class="panel anim">
      <div class="turn-label">当前房间</div>
      <div class="stats-scroll">
        <table class="stats-table">
          <thead><tr><th>房间码</th><th>游戏</th><th>阶段</th><th>在线 / 玩家</th><th>旁观连接</th></tr></thead>
          <tbody>${liveRows}</tbody>
        </table>
      </div>
    </section>

    <section class="panel anim">
      <div class="turn-label">最近事件</div>
      <div class="stats-scroll">
        <table class="stats-table">
          <thead><tr><th>时间</th><th>事件</th><th>房间</th><th>名字</th><th>游戏</th></tr></thead>
          <tbody>${eventRows}</tbody>
        </table>
      </div>
    </section>

    <p class="hint">只允许本机访问 · 数据保存在 data/stats.json · 统计从启用后开始记录</p>
    <a class="stats-link" href="/">← 回到小游戏桌</a>
    <div class="foot">同一房间 · 一个房主 · 随时开新局</div>
  </div>
</body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
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
  if (req.method === 'GET' && url.pathname === '/stats') {
    return serveStats(req, res);
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
  console.log('  │  小游戏桌 · 多房间                         │');
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
