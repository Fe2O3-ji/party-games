'use strict';

/**
 * 本地统计:记录建房、加入、旁观、开局和结束。
 * 数据默认写到 data/stats.json;该文件包含玩家名字,已在 .gitignore 中排除。
 */

const fs = require('fs');
const path = require('path');

const STATS_FILE = process.env.STATS_FILE || path.resolve(__dirname, 'data', 'stats.json');
const MAX_EVENTS = 200;

function emptyStats() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    roomsCreated: 0,
    playerJoins: 0,
    spectatorJoins: 0,
    gamesStarted: { chain: 0, match: 0 },
    gamesFinished: { chain: 0, match: 0 },
    players: {}, // name -> { joins, spectators, firstSeen, lastSeen }
    events: [],  // 最新在前
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    const base = emptyStats();
    return {
      ...base,
      ...raw,
      gamesStarted: { ...base.gamesStarted, ...(raw.gamesStarted || {}) },
      gamesFinished: { ...base.gamesFinished, ...(raw.gamesFinished || {}) },
      players: raw.players && typeof raw.players === 'object' ? raw.players : {},
      events: Array.isArray(raw.events) ? raw.events.slice(0, MAX_EVENTS) : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[stats] 读取失败,从空统计开始:', err.message);
    }
    return emptyStats();
  }
}

let data = load();

function save() {
  data.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    const tmp = `${STATS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, STATS_FILE);
  } catch (err) {
    console.warn('[stats] 保存失败:', err.message);
  }
}

function now() {
  return new Date().toISOString();
}

function recordPlayer(name, kind) {
  if (!name) return;
  const at = now();
  const entry = data.players[name] || {
    joins: 0,
    spectators: 0,
    firstSeen: at,
    lastSeen: at,
  };
  if (kind === 'spectator') entry.spectators += 1;
  else entry.joins += 1;
  entry.lastSeen = at;
  data.players[name] = entry;
}

function addEvent(type, { room = '', name = '', mode = '' } = {}) {
  data.events.unshift({ at: now(), type, room, name, mode });
  if (data.events.length > MAX_EVENTS) data.events.length = MAX_EVENTS;
}

function roomCreated(room, name) {
  data.roomsCreated += 1;
  data.playerJoins += 1;
  recordPlayer(name, 'player');
  addEvent('create', { room, name });
  save();
}

function playerJoined(room, name) {
  data.playerJoins += 1;
  recordPlayer(name, 'player');
  addEvent('join', { room, name });
  save();
}

function spectatorJoined(room, name) {
  data.spectatorJoins += 1;
  recordPlayer(name, 'spectator');
  addEvent('spectate', { room, name });
  save();
}

function gameStarted(room, mode) {
  if (!data.gamesStarted[mode]) data.gamesStarted[mode] = 0;
  data.gamesStarted[mode] += 1;
  addEvent('start', { room, mode });
  save();
}

function gameEnded(room, mode) {
  if (!data.gamesFinished[mode]) data.gamesFinished[mode] = 0;
  data.gamesFinished[mode] += 1;
  addEvent('end', { room, mode });
  save();
}

function snapshot() {
  return JSON.parse(JSON.stringify(data));
}

module.exports = {
  roomCreated,
  playerJoined,
  spectatorJoined,
  gameStarted,
  gameEnded,
  snapshot,
  filePath: STATS_FILE,
};
