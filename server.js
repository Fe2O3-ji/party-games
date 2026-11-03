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
  room = createRoom(code, { onDelete: () => deleteRoom(room) });
  rooms.set(code, room);
  const pid = room.addPlayer(name);

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
