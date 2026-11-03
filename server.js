'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const CARDS = require('./cards-data.json');
const BY_ID = Object.fromEntries(CARDS.map(card => [card.id, card]));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});
const PORT = Number(process.env.PORT) || 10000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function uid() { return crypto.randomBytes(9).toString('base64url'); }
function token() { return crypto.randomBytes(24).toString('base64url'); }
function cleanName(value) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 12);
  return name || '플레이어';
}
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeMon(id) {
  const c = BY_ID[id];
  return { uid: uid(), id, hp: c.hp, maxHp: c.hp, energy: 0, shield: 0, weaken: 0, skip: false, guardUsed: false };
}
function createPlayer(name, socketId) {
  const deck = shuffle(CARDS.flatMap(c => [c.id, c.id]));
  const startingHand = deck.splice(0, 5).map(makeMon);
  return {
    token: token(), name, socketId, connected: true,
    startingHand, remainingDeck: deck, selection: [], ready: false,
    side: null, reconnectTimer: null
  };
}
function pushLog(room, message, tone = '') {
  room.logs.push({ id: uid(), message, tone });
  if (room.logs.length > 70) room.logs.splice(0, room.logs.length - 70);
}
function sideFor(room, index) { return room.players[index].side; }
function findMon(side, targetUid) {
  if (side.active && side.active.uid === targetUid) return side.active;
  return side.bench.find(m => m.uid === targetUid) || null;
}
function beginTurn(room, index) {
  if (room.phase !== 'battle' || room.over) return;
  room.current = index;
  const side = sideFor(room, index);
  side.turn += 1;
  side.attachAvailable = true;
  if (side.deck.length) {
    const id = side.deck.shift();
    const drawn = makeMon(id);
    side.hand.push(drawn);
    pushLog(room, `${room.players[index].name}이(가) 카드 1장을 뽑았습니다.`);
  }
  const activeCard = BY_ID[side.active.id];
  if (activeCard.passiveKey === 'fresh') {
    const amount = heal(side.active, 6);
    if (amount) pushLog(room, `${activeCard.name}의 깻잎농장! 체력 ${amount} 회복.`, 'good');
  }
  side.active.guardUsed = false;
  if (side.active.skip) {
    side.active.skip = false;
    pushLog(room, `${room.players[index].name}의 배틀 몬이 행동 불가 상태라 턴을 건너뜁니다.`, 'bad');
    broadcastRoom(room);
    setTimeout(() => {
      if (room.phase === 'battle' && !room.over && room.current === index) beginTurn(room, 1 - index);
    }, 900);
    return;
  }
  broadcastRoom(room);
}
function heal(mon, amount) {
  const before = mon.hp;
  mon.hp = Math.min(mon.maxHp, mon.hp + amount);
  return mon.hp - before;
}
function damage(mon, amount) {
  const card = BY_ID[mon.id];
  let reduction = 0;
  if ((card.passiveKey === 'wall' || card.passiveKey === 'shoulder') && !mon.guardUsed) {
    reduction = card.passiveKey === 'wall' ? 10 : 8;
    mon.guardUsed = true;
  }
  let actual = Math.max(0, amount - reduction);
  const absorbed = Math.min(mon.shield, actual);
  mon.shield -= absorbed;
  actual -= absorbed;
  mon.hp = Math.max(0, mon.hp - actual);
  return { actual, absorbed, reduction };
}
function finish(room, winner, reason) {
  room.over = true;
  room.winner = winner;
  room.phase = 'finished';
  room.reason = reason;
  pushLog(room, reason, 'gold');
  broadcastRoom(room);
}
function checkActiveKO(room, defenderIndex, attackerIndex) {
  const defender = sideFor(room, defenderIndex);
  if (defender.active.hp > 0) return false;
  const fallen = defender.active;
  const fallenName = BY_ID[fallen.id].name;
  sideFor(room, attackerIndex).prizes += 1;
  pushLog(room, `${fallenName} 기절! ${room.players[attackerIndex].name}이(가) 프라이즈 1장을 획득했습니다.`, 'gold');
  if (sideFor(room, attackerIndex).prizes >= 3) {
    finish(room, attackerIndex, '프라이즈 3장을 모두 모았습니다!');
    return true;
  }
  if (defender.bench.length) {
    defender.active = defender.bench.shift();
    pushLog(room, `${BY_ID[defender.active.id].name}이(가) 새 배틀 몬으로 나왔습니다.`, 'gold');
  } else {
    finish(room, attackerIndex, `${fallenName}이(가) 기절했고 교체할 벤치가 없습니다.`);
    return true;
  }
  return false;
}
function publicMon(mon) {
  if (!mon) return null;
  return { uid: mon.uid, id: mon.id, hp: mon.hp, maxHp: mon.maxHp, energy: mon.energy, shield: mon.shield, weaken: mon.weaken, skip: mon.skip };
}
function publicSide(player, includePrivate) {
  const side = player.side;
  if (!side) return { name: player.name, connected: player.connected, ready: player.ready };
  const result = {
    name: player.name,
    connected: player.connected,
    ready: player.ready,
    prizes: side.prizes,
    turn: side.turn,
    active: publicMon(side.active),
    bench: side.bench.map(publicMon),
    handCount: side.hand.length,
    deckCount: side.deck.length
  };
  if (includePrivate) {
    result.hand = side.hand.map(publicMon);
    result.attachAvailable = side.attachAvailable;
  }
  return result;
}
function viewFor(room, index) {
  const me = room.players[index];
  return {
    roomCode: room.code,
    phase: room.phase,
    myIndex: index,
    players: room.players.map((p, i) => publicSide(p, i === index)),
    setupHand: room.phase === 'select' ? me.startingHand.map(publicMon) : [],
    chosen: room.phase === 'select' ? me.selection : [],
    readyFlags: room.players.map(p => p.ready),
    current: room.current,
    winner: room.winner,
    reason: room.reason,
    over: room.over,
    logs: room.logs
  };
}
function broadcastRoom(room) {
  room.players.forEach((player, index) => {
    if (player.socketId && player.connected) io.to(player.socketId).emit('room-state', viewFor(room, index));
  });
}
function playerForSocket(socket) {
  const roomCode = socket.data.roomCode;
  const room = roomCode && rooms.get(roomCode);
  if (!room) return null;
  const index = room.players.findIndex(p => p.socketId === socket.id && p.connected);
  return index >= 0 ? { room, index, player: room.players[index] } : null;
}
function ackError(ack, message) { if (typeof ack === 'function') ack({ ok: false, error: message }); }
function ackOk(ack, data = {}) { if (typeof ack === 'function') ack({ ok: true, ...data }); }

function createSideFromSelection(player) {
  const chosenIds = new Set(player.selection);
  const picked = player.startingHand.filter(m => chosenIds.has(m.uid));
  const left = player.startingHand.filter(m => !chosenIds.has(m.uid));
  return {
    deck: player.remainingDeck,
    hand: left,
    active: picked[0],
    bench: picked.slice(1),
    prizes: 0,
    attachAvailable: true,
    turn: 0
  };
}
function validateTurn(room, index, ack) {
  if (room.phase !== 'battle' || room.over) { ackError(ack, '현재 대전 중이 아닙니다.'); return false; }
  if (room.current !== index) { ackError(ack, '상대의 턴입니다. 잠시 기다려 주세요.'); return false; }
  return true;
}
function nextTurn(room, index) {
  if (!room.over && room.phase === 'battle') beginTurn(room, 1 - index);
}
function performAttack(room, index, moveIndex, ack) {
  const side = sideFor(room, index);
  const enemyIndex = 1 - index;
  const enemy = sideFor(room, enemyIndex);
  const attacker = side.active;
  const target = enemy.active;
  const card = BY_ID[attacker.id];
  const move = card.moves[Number(moveIndex)];
  if (!move || attacker.energy < move.cost) { ackError(ack, '기술에 필요한 에너지가 부족합니다.'); return; }
  attacker.energy -= move.cost;
  const attackPower = card.atk + (card.passiveKey === 'cute' && attacker.hp <= attacker.maxHp / 2 ? 8 : 0) + (card.passiveKey === 'grab' ? 4 : 0) - (attacker.weaken || 0);
  let raw = move.power + Math.floor(attackPower * 0.28) - Math.floor(BY_ID[target.id].def * 0.24);
  raw = Math.max(8, raw);
  if (attacker.weaken) attacker.weaken = 0;
  const hit = damage(target, raw);
  pushLog(room, `${card.name}의 ${move.name}! ${BY_ID[target.id].name}에게 ${hit.actual} 피해${hit.absorbed ? ` (보호막 ${hit.absorbed} 흡수)` : ''}${hit.reduction ? ` (특성으로 ${hit.reduction} 감소)` : ''}.`, index === 0 ? 'good' : 'bad');

  if (move.effect === 'heal') {
    const amount = heal(attacker, move.value);
    if (amount) pushLog(room, `${card.name} 체력 ${amount} 회복.`, 'good');
  }
  if (move.effect === 'shield') {
    attacker.shield += move.value;
    pushLog(room, `${card.name} 보호막 ${move.value} 획득.`, 'good');
  }
  if (move.effect === 'weaken' && target.hp > 0) {
    target.weaken = move.value;
    pushLog(room, `${BY_ID[target.id].name}의 다음 공격 피해가 ${move.value} 감소합니다.`, 'gold');
  }
  if (move.effect === 'stun' && target.hp > 0) {
    target.skip = true;
    pushLog(room, `${BY_ID[target.id].name}은(는) 다음 턴 행동할 수 없습니다!`, 'gold');
  }
  if (move.effect === 'recoil') {
    attacker.hp = Math.max(1, attacker.hp - move.value);
    pushLog(room, `${card.name}도 반동 피해 ${move.value}를 받았습니다.`, 'bad');
  }
  if (move.effect === 'splash' && enemy.bench.length) {
    const benchTarget = enemy.bench[Math.floor(Math.random() * enemy.bench.length)];
    const benchHit = damage(benchTarget, move.value);
    pushLog(room, `충격파가 벤치의 ${BY_ID[benchTarget.id].name}에게 ${benchHit.actual} 피해!`, 'gold');
    if (benchTarget.hp <= 0) {
      enemy.bench = enemy.bench.filter(mon => mon.uid !== benchTarget.uid);
      side.prizes += 1;
      pushLog(room, `벤치의 ${BY_ID[benchTarget.id].name} 기절! 프라이즈 1장 획득.`, 'gold');
      if (side.prizes >= 3) {
        finish(room, index, '벤치까지 휩쓴 공격으로 프라이즈 3장을 모았습니다!');
        ackOk(ack);
        return;
      }
    }
  }
  if (card.passiveKey === 'refill') {
    const amount = heal(attacker, 6);
    if (amount) pushLog(room, `무한리필 특성으로 체력 ${amount} 회복.`, 'good');
  }
  if (card.passiveKey === 'suction') {
    const amount = heal(attacker, Math.floor(hit.actual * 0.2));
    if (amount) pushLog(room, `대빨 흡수 특성으로 체력 ${amount} 회복.`, 'good');
  }
  if (checkActiveKO(room, enemyIndex, index)) {
    ackOk(ack);
    return;
  }
  ackOk(ack);
  nextTurn(room, index);
}

io.on('connection', socket => {
  socket.on('create-room', ({ name } = {}, ack) => {
    const code = makeCode();
    const player = createPlayer(cleanName(name), socket.id);
    const room = {
      code, phase: 'lobby', players: [player], current: 0, over: false,
      winner: null, reason: '', logs: [], createdAt: Date.now()
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    ackOk(ack, { code, token: player.token, seat: 0 });
    broadcastRoom(room);
  });

  socket.on('join-room', ({ code, name } = {}, ack) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return ackError(ack, '방을 찾을 수 없습니다. 방 코드를 확인해 주세요.');
    if (room.phase !== 'lobby' || room.players.length >= 2) return ackError(ack, '이미 시작했거나 인원이 가득 찬 방입니다.');
    const player = createPlayer(cleanName(name), socket.id);
    room.players.push(player);
    room.phase = 'select';
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    ackOk(ack, { code: roomCode, token: player.token, seat: 1 });
    pushLog(room, `${player.name}이(가) 방에 입장했습니다.`, 'gold');
    broadcastRoom(room);
  });

  socket.on('resume-room', ({ code, token: resumeToken } = {}, ack) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return ackError(ack, '이전 대전 방이 만료되었거나 존재하지 않습니다.');
    const index = room.players.findIndex(p => p.token === resumeToken);
    if (index < 0) return ackError(ack, '재접속 정보를 확인할 수 없습니다.');
    const player = room.players[index];
    clearTimeout(player.reconnectTimer);
    player.socketId = socket.id;
    player.connected = true;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    ackOk(ack, { code: roomCode, seat: index, phase: room.phase });
    pushLog(room, `${player.name}이(가) 다시 접속했습니다.`, 'good');
    broadcastRoom(room);
  });

  socket.on('select-team', ({ uids } = {}, ack) => {
    const found = playerForSocket(socket);
    if (!found) return ackError(ack, '방 연결을 찾을 수 없습니다.');
    const { room, index, player } = found;
    if (room.phase !== 'select' || player.ready) return ackError(ack, '현재 카드를 선택할 수 없습니다.');
    if (!Array.isArray(uids) || uids.length < 1 || uids.length > 3 || new Set(uids).size !== uids.length) return ackError(ack, '시작 카드를 1~3장 선택해 주세요.');
    if (uids.some(id => !player.startingHand.some(m => m.uid === id))) return ackError(ack, '선택한 카드 정보가 올바르지 않습니다.');
    player.selection = uids;
    player.ready = true;
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.players.forEach(p => {
        p.side = {
          deck: p.remainingDeck,
          hand: p.startingHand.filter(m => !p.selection.includes(m.uid)),
          active: p.startingHand.find(m => m.uid === p.selection[0]),
          bench: p.selection.slice(1).map(id => p.startingHand.find(m => m.uid === id)),
          prizes: 0, attachAvailable: true, turn: 0
        };
      });
      room.phase = 'battle';
      pushLog(room, '두 플레이어의 준비 완료! 대전을 시작합니다.', 'gold');
      beginTurn(room, 0);
    } else {
      pushLog(room, `${player.name}이(가) 팀 구성을 완료했습니다. 상대의 준비를 기다립니다.`);
      broadcastRoom(room);
    }
    ackOk(ack);
  });

  socket.on('leave-room', (_payload, ack) => {
    const found = playerForSocket(socket);
    if (!found) return ackOk(ack);
    const { room, index, player } = found;
    clearTimeout(player.reconnectTimer);
    player.connected = false;
    player.socketId = null;
    if (room.phase === 'battle' && !room.over) {
      finish(room, 1 - index, `${player.name}이(가) 방을 나갔습니다. 상대방이 승리했습니다.`);
    } else {
      pushLog(room, `${player.name}이(가) 방을 나갔습니다.`, 'bad');
      broadcastRoom(room);
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    ackOk(ack);
  });

  socket.on('game-action', (action = {}, ack) => {
    const found = playerForSocket(socket);
    if (!found) return ackError(ack, '방 연결을 찾을 수 없습니다.');
    const { room, index } = found;
    if (!validateTurn(room, index, ack)) return;
    const side = sideFor(room, index);
    const type = String(action.type || '');

    if (type === 'attach') {
      if (!side.attachAvailable) return ackError(ack, '이번 턴의 일반 에너지 부착은 이미 사용했습니다.');
      const target = findMon(side, action.targetUid);
      if (!target) return ackError(ack, '에너지를 붙일 내 카드를 선택해 주세요.');
      target.energy += 1;
      side.attachAvailable = false;
      pushLog(room, `${room.players[index].name}이(가) ${BY_ID[target.id].name}에게 에너지 1개를 부착했습니다.`, 'good');
      ackOk(ack); broadcastRoom(room); return;
    }
    if (type === 'discard') {
      const cardIndex = side.hand.findIndex(m => m.uid === action.cardUid);
      const target = findMon(side, action.targetUid);
      if (cardIndex < 0 || !target) return ackError(ack, '버릴 카드와 에너지를 받을 카드를 확인해 주세요.');
      const [discarded] = side.hand.splice(cardIndex, 1);
      target.energy += 1;
      pushLog(room, `${room.players[index].name}이(가) ${BY_ID[discarded.id].name}을(를) 버리고 ${BY_ID[target.id].name}에게 에너지 1개를 부착했습니다.`, 'good');
      ackOk(ack); broadcastRoom(room); return;
    }
    if (type === 'bench') {
      if (side.bench.length >= 3) return ackError(ack, '벤치에는 최대 3장까지 배치할 수 있습니다.');
      const handIndex = side.hand.findIndex(m => m.uid === action.cardUid);
      if (handIndex < 0) return ackError(ack, '손패에서 카드를 찾을 수 없습니다.');
      const [mon] = side.hand.splice(handIndex, 1);
      side.bench.push(mon);
      pushLog(room, `${room.players[index].name}이(가) ${BY_ID[mon.id].name}을(를) 벤치에 배치했습니다.`, 'good');
      ackOk(ack); broadcastRoom(room); return;
    }
    if (type === 'switch') {
      const benchIndex = side.bench.findIndex(m => m.uid === action.targetUid);
      if (benchIndex < 0) return ackError(ack, '교체할 벤치 몬을 선택해 주세요.');
      const [incoming] = side.bench.splice(benchIndex, 1);
      const outgoing = side.active;
      side.active = incoming;
      side.bench.push(outgoing);
      pushLog(room, `${BY_ID[incoming.id].name}이(가) 배틀 몬으로 교체 출전했습니다. ${BY_ID[outgoing.id].name}은(는) 벤치로 이동했습니다. (에너지 소모 없음)`, 'gold');
      ackOk(ack); broadcastRoom(room); return;
    }
    if (type === 'attack') {
      performAttack(room, index, action.moveIndex, ack); return;
    }
    if (type === 'end-turn') {
      pushLog(room, `${room.players[index].name}의 턴 종료.`, 'gold');
      ackOk(ack); nextTurn(room, index); return;
    }
    ackError(ack, '알 수 없는 행동입니다.');
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = roomCode && rooms.get(roomCode);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    player.connected = false;
    pushLog(room, `${player.name}의 연결이 끊겼습니다. 재접속을 기다립니다.`, 'bad');
    player.reconnectTimer = setTimeout(() => {
      const currentRoom = rooms.get(roomCode);
      if (currentRoom && currentRoom.players.every(p => !p.connected)) rooms.delete(roomCode);
    }, 30 * 60 * 1000);
    broadcastRoom(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Monster VMAX Online listening on ${PORT}`);
});
