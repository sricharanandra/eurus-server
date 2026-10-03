// Run: node --import tsx --test scripts/voice-review.cjs
// Audit checks assert desired behavior and intentionally fail on unfixed bugs.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { WebSocket } = require('ws');
const { OpusEncoder } = require('@discordjs/opus');
const { RoomVoiceEngine, VoiceSession } = require('../src/voice');

function socket() {
  return {
    readyState: WebSocket.OPEN,
    messages: [],
    handlers: new Map(),
    send(text) { this.messages.push(JSON.parse(text)); },
    on(event, handler) { this.handlers.set(event, handler); },
    terminate() { this.readyState = WebSocket.CLOSED; this.handlers.get('close')?.(); },
  };
}

function user(id, ws = socket()) {
  return { userId: id, username: id, ws, currentRoomId: null, isAuthenticated: true };
}

// Load the actual handler declarations and connection callback, without executing
// the HTTP listener or importing a live database. Only I/O boundaries are faked.
function handlers() {
  const source = readFileSync(join(__dirname, '../src/server.ts'), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(ts.isFunctionDeclaration);
  const connection = ast.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'wss.on'
    && node.expression.arguments[0].text === 'connection');
  assert.ok(connection, 'server connection callback must be present');
  const context = {
    RoomVoiceEngine, WebSocket, Buffer, URL,
    console: { log() {}, error() {} },
    activeRooms: new Map(), connectedUsers: new Map(),
    verifyToken: id => ({ userId: id, username: id }),
    prisma: { room: { findFirst: async () => context.dbRoom }, roomMember: { upsert: async () => ({}) } },
    wss: { on(event, callback) { context.connect = callback; } },
  };
  const code = [...declarations, connection].map(node => node.getText(ast)).join('\n');
  vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context;
}

function room(id, users) {
  return { id, name: id, displayName: id, roomType: 'private', encryptedKey: '', users };
}

function tone() {
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 48000)), i * 2);
  return pcm;
}

test('voice resumes after mute/unmute with packet sequence paused by the client', () => {
  const session = new VoiceSession('speaker', 'speaker', 'room', socket());
  const encoder = new OpusEncoder(48000, 1);
  const pcm = tone();
  const push = () => session.processAudio(encoder.encode(pcm));
  push();
  assert.ok(session.popMixedFrame().some(sample => Math.abs(sample) > 0.01));
  // Muted sender skips packets and does not increment seq. Mixer still ticks.
  for (let tick = 0; tick < 50; tick++) session.popMixedFrame();
  let audible = 0;
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (let seq = 1; seq <= 100; seq++) {
      push();
      if (session.popMixedFrame().some(sample => Math.abs(sample) > 0.01)) audible++;
    }
  } finally { console.log = originalLog; session.destroy(); }
  assert.ok(audible > 90, `audible frames after unmute: ${audible}/100`);
});

test('single-side leave/rejoin keeps audio reaching every other participant', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const engine = new RoomVoiceEngine('room');
  t.after(() => engine.destroy());
  const a = socket(), b = socket(), c = socket();
  engine.addUser('a', 'a', a); engine.addUser('b', 'b', b); engine.addUser('c', 'c', c);
  for (let cycle = 0; cycle < 3; cycle++) {
    const encoder = new OpusEncoder(48000, 1);
    engine.processAudio('a', encoder.encode(tone()));
    t.mock.timers.tick(20);
    for (const target of [b, c]) {
      const packet = target.messages.at(-1).payload.payload;
      const decoded = new OpusEncoder(48000, 1).decode(Buffer.from(packet, 'base64'));
      assert.ok(Array.from({ length: 960 }, (_, i) => decoded.readInt16LE(i * 2)).some(n => Math.abs(n) > 100));
    }
    engine.removeUser('a'); engine.addUser('a', 'a', a);
  }
});

test('replacement connection receives room broadcasts on the new socket', async () => {
  const ctx = handlers();
  ctx.dbRoom = { ...room('r', []), members: [{}], messages: [] };
  const oldSocket = socket();
  await ctx.connect(oldSocket, { url: '/ws?token=a', headers: { host: 'localhost' }, socket: {} });
  await ctx.handleJoinRoom(ctx.connectedUsers.get(oldSocket), { roomId: 'r' });
  const replacement = socket();
  await ctx.connect(replacement, { url: '/ws?token=a', headers: { host: 'localhost' }, socket: {} });
  await ctx.handleJoinRoom(ctx.connectedUsers.get(replacement), { roomId: 'r' });
  ctx.broadcastToRoom('r', { type: 'info', payload: { message: 'broadcast-check' } });
  assert.ok(replacement.messages.some(message => message.payload.message === 'broadcast-check'), 'room still holds the terminated socket');
});

test('replacement connection cleans voice membership in the previous room', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ctx = handlers();
  const oldSocket = socket();
  await ctx.connect(oldSocket, { url: '/ws?token=a', headers: { host: 'localhost' }, socket: {} });
  const old = ctx.connectedUsers.get(oldSocket);
  old.currentRoomId = 'r';
  const r = room('r', [old, user('b')]);
  r.voiceManager = new RoomVoiceEngine('r');
  t.after(() => r.voiceManager?.destroy());
  r.voiceManager.addUser('a', 'a', old.ws);
  ctx.activeRooms.set('r', r);
  await ctx.connect(socket(), { url: '/ws?token=a', headers: { host: 'localhost' }, socket: {} });
  assert.equal(r.voiceManager.getVoiceUserIds().has('a'), false, 'replaced user remains in old voice roster');
});

test('voice join requires active chat-room membership', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ctx = handlers();
  const r = room('private-room', [user('owner')]);
  ctx.activeRooms.set(r.id, r);
  t.after(() => r.voiceManager?.destroy());
  await ctx.handleJoinVoice(user('outsider'), { roomId: r.id });
  assert.equal(r.voiceManager?.getVoiceUserIds().has('outsider') ?? false, false, 'non-member was admitted to private voice');
});

test('chat join completing after disconnect cannot resurrect a stale connection', async () => {
  const ctx = handlers();
  let resolveRoom;
  ctx.prisma.room.findFirst = () => new Promise(resolve => { resolveRoom = resolve; });
  const ws = socket();
  await ctx.connect(ws, { url: '/ws?token=a', headers: { host: 'localhost' }, socket: {} });
  const current = ctx.connectedUsers.get(ws);
  const joining = ctx.handleJoinRoom(current, { roomId: 'r' });
  ws.terminate();
  resolveRoom({ ...room('r', []), members: [{}], messages: [] });
  await joining;
  assert.equal(ctx.activeRooms.get('r')?.users.some(u => u.ws === ws) ?? false, false, 'closed socket inserted after disconnect cleanup');
});
