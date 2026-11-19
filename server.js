/**
 * UVoz — servidor de comunicação interna da Unicopag.
 *
 * - Express serve o front-end (pasta /public) e a API de contas (/api/*).
 * - MySQL guarda usuários, sessões, canais, mensagens, DMs, menções e leitura.
 * - Socket.io cuida de presença, mensagens em tempo real e sinalização WebRTC.
 * - Áudio, vídeo e tela trafegam P2P entre os navegadores (com TURN quando preciso).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const { loadDotEnv } = require('./lib/env');
loadDotEnv(__dirname);

const { createPool, migrate } = require('./lib/db');
const { Store, scopeKey } = require('./lib/store');
const auth = require('./lib/auth');

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // em produção atrás do Nginx: 127.0.0.1
const ACCESS_CODE = process.env.ACCESS_CODE || ''; // exigido para criar conta (vazio = livre)
const LEGACY_DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM) || 8;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_MESSAGE_ATTACHMENTS = 10 * 1024 * 1024;
const MAX_PROFILE_AVATAR_SIZE = 10 * 1024 * 1024;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
const ATTACHMENT_RETENTION_MS = 30 * 24 * 3600 * 1000;
const ATTACHMENT_TYPES = {
  txt: { mime: 'text/plain' },
  csv: { mime: 'text/csv' },
  xls: { mime: 'application/vnd.ms-excel' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  doc: { mime: 'application/msword' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  odt: { mime: 'application/vnd.oasis.opendocument.text' },
  ppt: { mime: 'application/vnd.ms-powerpoint' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  jpg: { mime: 'image/jpeg' },
  jpeg: { mime: 'image/jpeg' },
  png: { mime: 'image/png' },
  gif: { mime: 'image/gif' },
  webp: { mime: 'image/webp' },
  avif: { mime: 'image/avif' },
  bmp: { mime: 'image/bmp' },
  mp4: { mime: 'video/mp4', video: true },
  webm: { mime: 'video/webm', video: true },
  mov: { mime: 'video/quicktime', video: true },
  m4v: { mime: 'video/x-m4v', video: true },
  avi: { mime: 'video/x-msvideo', video: true },
  mkv: { mime: 'video/x-matroska', video: true },
};
const RESERVED_USERNAMES = new Set(['todos', 'everyone', 'here', 'aqui', 'admin', 'sistema', 'uvoz']);
const PASSWORD_RESET_MASTER_CODE = String(process.env.PASSWORD_RESET_MASTER_CODE || '');

function parseIceServers() {
  const fallback = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (!process.env.ICE_SERVERS) return fallback;
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (err) {
    console.warn('[uvoz] ICE_SERVERS inválido, usando STUN padrão:', err.message);
  }
  return fallback;
}
const ICE_SERVERS = parseIceServers();

// TURN com credenciais temporárias (coturn com use-auth-secret / static-auth-secret).
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS) || 12 * 3600;

function iceServersFor(id) {
  if (!TURN_SECRET || !TURN_URLS.length) return ICE_SERVERS;
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}:${id}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [...ICE_SERVERS, { urls: TURN_URLS, username, credential }];
}

function sanitizeText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function slugify(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'canal';
}

// ---------------------------------------------------------------------------
// Infra
// ---------------------------------------------------------------------------
const pool = createPool();
const store = new Store(pool);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// ----- Arquivos estáticos ----------------------------------------------------
// O index.html é sempre revalidado e aponta para os arquivos com "?v=<hash do conteúdo>";
// com o hash certo na URL eles são servidos com cache de 1 ano (o hash muda a cada deploy).
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSIONED = ['styles.css', 'rtc.js', 'app.js'];
const SIO_VERSION = require('socket.io/package.json').version;
const assets = { stamp: '', html: '', hash: {} };

function loadAssets() {
  const files = ['index.html', ...VERSIONED].map((f) => path.join(PUBLIC_DIR, f));
  const stamp = files.map((f) => fs.statSync(f).mtimeMs).join(':');
  if (stamp === assets.stamp) return assets;
  let html = fs.readFileSync(files[0], 'utf8');
  let replaced = 0;
  for (const f of VERSIONED) {
    const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC_DIR, f))).digest('hex').slice(0, 12);
    assets.hash[f] = hash;
    html = html.replace(new RegExp(`(["'])/${f.replace('.', '\\.')}\\1`), (_m, q) => { replaced++; return `${q}/${f}?v=${hash}${q}`; });
  }
  html = html.replace('%SIO_VERSION%', () => { replaced++; return SIO_VERSION; });
  if (replaced !== VERSIONED.length + 1) console.warn('[uvoz] index.html: nem todas as referências de arquivos foram versionadas');
  assets.stamp = stamp;
  assets.html = html;
  return assets;
}

app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(loadAssets().html);
});
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    const name = path.basename(filePath);
    const v = res.req.query.v;
    if (VERSIONED.includes(name) && v && v === loadAssets().hash[name]) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
// Cliente Socket.io minificado (a URL leva a versão do pacote).
app.use('/vendor/socket.io', express.static(
  path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist'),
  { maxAge: '365d', immutable: true },
));
// Supressão de ruído (GTCRN em WebAssembly) usada pelo navegador nas chamadas.
app.use('/vendor/noise', express.static(
  path.dirname(require.resolve('@sapphi-red/web-noise-suppressor')), // .../dist
  { maxAge: '7d' },
));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, serveClient: false });

/** socketId -> { socketId, userId, channelId, media } */
const voiceStates = new Map();
/** userId -> Set(socketId) */
const userSockets = new Map();

const isOnline = (userId) => (userSockets.get(userId)?.size || 0) > 0;
const emptyMedia = () => ({ mic: false, cam: false, screen: false, cameraStreamId: null, screenStreamId: null });

// ---------------------------------------------------------------------------
// API HTTP de contas
// ---------------------------------------------------------------------------
const loginByUser = new auth.RateLimiter(10, 15 * 60 * 1000);
const loginByIp = new auth.RateLimiter(50, 15 * 60 * 1000);
const registerByIp = new auth.RateLimiter(10, 60 * 60 * 1000);

const clientIp = (req) =>
  String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '').slice(0, 64);

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error('[uvoz] erro na API:', err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, online: userSockets.size, db: 'ok' });
}));

app.get('/api/config', (_req, res) => res.json({ requiresAccessCode: !!ACCESS_CODE }));

app.post('/api/register', asyncRoute(async (req, res) => {
  const ip = clientIp(req);
  if (registerByIp.blocked(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco.' });
  registerByIp.hit(ip);

  const username = String(req.body?.username || '').trim().toLowerCase();
  const displayName = sanitizeText(req.body?.displayName, 40);
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 255);
  const password = String(req.body?.password || '');
  const accessCode = String(req.body?.accessCode || '');

  if (ACCESS_CODE && accessCode !== ACCESS_CODE) return res.status(403).json({ error: 'Código de acesso inválido.' });
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Usuário deve ter 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou _.' });
  }
  if (RESERVED_USERNAMES.has(username)) return res.status(400).json({ error: 'Esse nome de usuário é reservado.' });
  if (!displayName) return res.status(400).json({ error: 'Informe seu nome.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um email válido.' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  if (store.usernames.has(username)) return res.status(409).json({ error: 'Esse usuário já existe.' });

  let user;
  try {
    user = await store.createUser({ username, displayName, email, passwordHash: await auth.hashPassword(password) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('users_email_unique')) {
      return res.status(409).json({ error: 'Esse email já está vinculado a outra conta.' });
    }
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esse usuário já existe.' });
    throw err;
  }
  const token = await auth.createSession(pool, user.id, req.headers['user-agent']);
  io.emit('user:new', { ...user, online: false, lastSeen: null });
  res.status(201).json({ token, user });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const ip = clientIp(req);
  const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 32);
  const password = String(req.body?.password || '').slice(0, 200);
  const key = `u:${username}`;
  if (loginByIp.blocked(ip) || loginByUser.blocked(key)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  }
  const row = username ? await store.findUserForLogin(username) : null;
  const ok = row ? await auth.verifyPassword(password, row.password_hash) : await auth.verifyAgainstDummy(password);
  if (!ok) {
    loginByIp.hit(ip);
    loginByUser.hit(key);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  loginByUser.reset(key);
  const token = await auth.createSession(pool, row.id, req.headers['user-agent']);
  res.json({ token, user: store.publicUser(row) });
}));

const resetPasswordByIp = new auth.RateLimiter(5, 60 * 60 * 1000);

app.post('/api/password-reset/confirm', asyncRoute(async (req, res) => {
  const ip = clientIp(req);
  if (resetPasswordByIp.blocked(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde antes de tentar novamente.' });
  resetPasswordByIp.hit(ip);
  const username = String(req.body?.username || '').trim().toLowerCase();
  const masterCode = String(req.body?.masterCode || '');
  const password = String(req.body?.password || '');
  const confirmation = String(req.body?.confirmation || '');
  if (!PASSWORD_RESET_MASTER_CODE) return res.status(503).json({ error: 'A recuperação de senha não está configurada no servidor.' });
  if (!username || !masterCode) return res.status(400).json({ error: 'Informe o usuário e o código mestre.' });
  if (masterCode !== PASSWORD_RESET_MASTER_CODE) return res.status(401).json({ error: 'Código mestre incorreto.' });
  if (!password || password !== confirmation) return res.status(400).json({ error: 'As duas senhas devem ser iguais.' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  const user = await store.findUserForLogin(username);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (await auth.verifyPassword(password, user.password_hash)) {
    return res.status(400).json({ error: 'A nova senha deve ser diferente da senha anterior.' });
  }
  const passwordHash = await auth.hashPassword(password);
  await store.resetPassword(user.id, passwordHash);
  res.json({ ok: true, message: 'Senha redefinida com sucesso.' });
}));

app.post('/api/profile/email', asyncRoute(async (req, res) => {
  const userId = await auth.userIdFromToken(pool, bearer(req));
  if (!userId || !store.users.has(userId)) return res.status(401).json({ error: 'Sessão inválida.' });
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 255);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um email válido.' });
  try {
    await store.setUserEmail(userId, email);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esse email já está vinculado a outra conta.' });
    throw err;
  }
  res.json({ ok: true, email });
}));

app.post('/api/logout', asyncRoute(async (req, res) => {
  await auth.deleteSession(pool, bearer(req));
  res.json({ ok: true });
}));

app.post('/api/profile/avatar', express.raw({ type: 'application/octet-stream', limit: MAX_PROFILE_AVATAR_SIZE }), asyncRoute(async (req, res) => {
  const userId = await auth.userIdFromToken(pool, bearer(req));
  if (!userId || !store.users.has(userId)) return res.status(401).json({ error: 'Sessão inválida.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Selecione uma imagem válida.' });

  let originalName;
  try { originalName = decodeURIComponent(String(req.headers['x-file-name'] || '')); }
  catch { return res.status(400).json({ error: 'Nome de arquivo inválido.' }); }
  originalName = path.basename(originalName.replace(/[\\/]/g, path.sep))
    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
  const extension = path.extname(originalName).slice(1).toLowerCase();
  const mimeType = extension === 'png' ? 'image/png' : ['jpg', 'jpeg'].includes(extension) ? 'image/jpeg' : null;
  const validSignature = mimeType === 'image/png'
    ? req.body.length >= 8 && req.body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : mimeType === 'image/jpeg' && req.body.length >= 3 && req.body[0] === 0xff && req.body[1] === 0xd8 && req.body[2] === 0xff;
  if (!mimeType || !validSignature) return res.status(400).json({ error: 'Use uma imagem PNG ou JPEG válida.' });
  if (req.body.length > MAX_PROFILE_AVATAR_SIZE) return res.status(413).json({ error: 'A imagem deve ter no máximo 10 MB.' });

  const updatedAt = Math.max(Date.now(), Number(store.users.get(userId).avatarVersion || 0) + 1);
  const result = await store.setUserAvatar(userId, { data: req.body, mimeType, updatedAt });
  if (!result) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }
  if (result.previousStorageName) {
    await fs.promises.unlink(path.join(AVATAR_DIR, result.previousStorageName)).catch((err) => {
      if (err.code !== 'ENOENT') console.error('[uvoz] erro removendo avatar anterior:', err);
    });
  }
  const user = {
    ...result.user,
    online: isOnline(userId),
    lastSeen: store.lastSeenAt.get(userId) || null,
  };
  io.emit('user:updated', user);
  res.json({ user });
}));

app.get('/api/users/:id/avatar', asyncRoute(async (req, res) => {
  const userId = await auth.userIdFromToken(pool, bearer(req));
  if (!userId || !store.users.has(userId)) return res.status(401).json({ error: 'Sessão inválida.' });
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return res.status(404).json({ error: 'Foto não encontrada.' });
  const avatar = await store.getUserAvatar(targetId);
  if (!avatar || !['image/png', 'image/jpeg'].includes(avatar.mimeType)) {
    return res.status(404).json({ error: 'Foto não encontrada.' });
  }
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Type': avatar.mimeType,
  });
  if (Buffer.isBuffer(avatar.data)) return res.send(avatar.data);
  if (!avatar.storageName || !/^[0-9a-f-]{36}$/i.test(avatar.storageName)) {
    return res.status(404).json({ error: 'Foto não encontrada.' });
  }
  let legacyData;
  try {
    const filePath = path.join(AVATAR_DIR, avatar.storageName);
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_PROFILE_AVATAR_SIZE) {
      console.error('[uvoz] avatar legado excede o limite permitido:', avatar.storageName);
      return res.status(500).json({ error: 'Não foi possível carregar a foto.' });
    }
    legacyData = await fs.promises.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Foto não encontrada.' });
    throw err;
  }
  if (!legacyData.length) return res.status(404).json({ error: 'Foto não encontrada.' });
  const migrated = await store.persistLegacyAvatar(targetId, avatar.storageName, legacyData);
  if (!migrated) {
    const refreshedAvatar = await store.getUserAvatar(targetId);
    if (Buffer.isBuffer(refreshedAvatar?.data)) {
      res.set('Content-Type', refreshedAvatar.mimeType);
      return res.send(refreshedAvatar.data);
    }
  }
  res.send(legacyData);
}));

app.post('/api/attachments', express.raw({ type: 'application/octet-stream', limit: MAX_MESSAGE_ATTACHMENTS }), asyncRoute(async (req, res) => {
  const userId = await auth.userIdFromToken(pool, bearer(req));
  if (!userId || !store.users.has(userId)) return res.status(401).json({ error: 'Sessão inválida.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Arquivo vazio ou inválido.' });

  let originalName;
  try { originalName = decodeURIComponent(String(req.headers['x-file-name'] || '')); }
  catch { return res.status(400).json({ error: 'Nome de arquivo inválido.' }); }
  originalName = path.basename(originalName.replace(/[\\/]/g, path.sep))
    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
  const extension = path.extname(originalName).slice(1).toLowerCase();
  const type = ATTACHMENT_TYPES[extension];
  if (!originalName || !type) return res.status(400).json({ error: 'Formato de arquivo não permitido.' });
  if (req.body.length > MAX_MESSAGE_ATTACHMENTS) return res.status(413).json({ error: 'O limite total por mensagem é 10 MB.' });

  const id = crypto.randomUUID();
  const storageName = crypto.randomUUID();
  const filePath = path.join(UPLOAD_DIR, storageName);
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.promises.writeFile(filePath, req.body, { flag: 'wx' });
  try {
    await store.createPendingAttachment({
      id, storageName, uploaderId: userId, originalName,
      mimeType: type.mime, size: req.body.length,
    });
  } catch (err) {
    await fs.promises.unlink(filePath).catch(() => {});
    throw err;
  }
  res.status(201).json({ attachment: { id, name: originalName, size: req.body.length, type: type.mime } });
}));

app.get('/api/attachments/:id', asyncRoute(async (req, res) => {
  const userId = await auth.userIdFromToken(pool, bearer(req));
  if (!userId || !store.users.has(userId)) return res.status(401).json({ error: 'Sessão inválida.' });
  const attachment = await store.getAttachment(req.params.id);
  if (!attachment || !attachment.message_id) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  const message = await store.getMessage(attachment.message_id);
  const scope = message && await resolveScope(message.message.scope, userId);
  if (!scope) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  const filePath = path.join(UPLOAD_DIR, attachment.storage_name);
  res.set('X-Content-Type-Options', 'nosniff');
  res.download(filePath, attachment.original_name, (err) => {
    if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Não foi possível baixar o arquivo.' });
  });
}));

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.use(async (socket, next) => {
  try {
    const userId = await auth.userIdFromToken(pool, socket.handshake.auth?.token);
    if (!userId || !store.users.has(userId)) return next(new Error('SESSAO_INVALIDA'));
    socket.data.userId = userId;
    next();
  } catch (err) {
    console.error('[uvoz] erro na autenticação do socket:', err);
    next(new Error('ERRO_SERVIDOR'));
  }
});

/** Resolve e autoriza um scope vindo do cliente. */
async function resolveScope(scope, userId) {
  if (scope?.type === 'channel') {
    const channel = store.getChannel(scope.id);
    return channel && channel.type === 'text' ? { type: 'channel', id: channel.id } : null;
  }
  if (scope?.type === 'dm') {
    const dm = await store.getDm(scope.id);
    if (!dm || !store.dmMembers(dm).includes(userId)) return null;
    return { type: 'dm', id: dm.id, dm };
  }
  return null;
}

/** Envia um evento para quem pode ver o scope. */
function emitToScope(scope, event, payload) {
  if (scope.type === 'channel') return io.emit(event, payload);
  const [a, b] = store.dmMembers(scope.dm);
  io.to(`user:${a}`).to(`user:${b}`).emit(event, payload);
}

io.on('connection', async (socket) => {
  const userId = socket.data.userId;
  const me = store.users.get(userId);
  socket.join(`user:${userId}`);

  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  const firstSocket = userSockets.get(userId).size === 0;
  userSockets.get(userId).add(socket.id);
  if (firstSocket) socket.broadcast.emit('presence', { userId, online: true });

  // Registrado antes de qualquer await para não perder uma desconexão rápida.
  socket.on('disconnect', () => {
    leaveVoice(socket);
    const set = userSockets.get(userId);
    if (set) {
      set.delete(socket.id);
      if (!set.size) {
        userSockets.delete(userId);
        io.emit('presence', { userId, online: false, lastSeen: Date.now() });
        store.touchUser(userId).catch(() => {});
      }
    }
  });

  // Handler com tratamento de erro e resposta padrão.
  const on = (event, fn) => socket.on(event, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const result = await fn(payload || {});
      reply(result ?? { ok: true });
    } catch (err) {
      console.error(`[uvoz] erro em ${event}:`, err);
      reply({ error: 'Erro interno. Tente novamente.' });
    }
  });

  // ----- Canais ------------------------------------------------------------
  on('channel:create', async (p) => {
    const name = sanitizeText(p.name, 40);
    const type = p.type === 'voice' ? 'voice' : 'text';
    if (!name) return { error: 'Nome do canal obrigatório.' };
    if (store.countChannels() >= 100) return { error: 'Limite de canais atingido.' };
    const base = slugify(name);
    let id = base;
    for (let i = 2; store.channelIdExists(id); i++) id = `${base}-${i}`;
    const channel = await store.createChannel({
      id,
      name: type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name,
      type,
      topic: type === 'text' ? sanitizeText(p.topic, 120) : '',
      createdBy: userId,
    });
    io.emit('channel:created', channel);
    return { channel };
  });

  on('channel:delete', async (p) => {
    const channel = store.getChannel(p.channelId);
    if (!channel) return { error: 'Canal não encontrado.' };
    if (channel.type === 'text' && store.countChannels('text') <= 1) {
      return { error: 'É preciso manter ao menos um canal de texto.' };
    }
    for (const vs of [...voiceStates.values()]) {
      if (vs.channelId === channel.id) {
        const s = io.sockets.sockets.get(vs.socketId);
        if (s) leaveVoice(s);
      }
    }
    await store.deleteChannel(channel.id);
    io.emit('channel:deleted', { channelId: channel.id });
    return { ok: true };
  });

  // ----- Mensagens ---------------------------------------------------------
  on('messages:get', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    return store.getMessages(scope, p.before);
  });

  on('message:send', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    const text = sanitizeText(p.text, MAX_MESSAGE_LENGTH);
    const attachmentIds = Array.isArray(p.attachmentIds) ? p.attachmentIds : [];
    const replyToId = p.replyToId == null ? null : Number(p.replyToId);
    if (p.replyToId != null && (!Number.isSafeInteger(replyToId) || replyToId <= 0)) {
      return { error: 'Mensagem respondida inválida.' };
    }
    if (!text && !attachmentIds.length) return { error: 'Mensagem vazia.' };
    const message = await store.createMessage(scope, userId, text, attachmentIds, replyToId);
    if (message.error) return message;
    if (scope.type === 'dm') {
      for (const member of store.dmMembers(scope.dm)) {
        io.to(`user:${member}`).emit('dm:upsert', store.publicDm({ ...scope.dm, last_message_at: message.ts }, member));
      }
    }
    emitToScope(scope, 'message:new', message);
    return { message };
  });

  on('message:edit', async (p) => {
    const found = await store.getMessage(p.id);
    if (!found || found.row.author_id !== userId) return { error: 'Você só pode editar suas mensagens.' };
    const scope = await resolveScope(found.message.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    const text = sanitizeText(p.text, MAX_MESSAGE_LENGTH);
    if (!text) return { error: 'Mensagem vazia.' };
    const message = await store.editMessage(found.message.id, text, scope.type === 'channel');
    emitToScope(scope, 'message:updated', message);
    return { message };
  });

  on('message:delete', async (p) => {
    const found = await store.getMessage(p.id);
    if (!found || found.row.author_id !== userId) return { error: 'Você só pode apagar suas mensagens.' };
    const scope = await resolveScope(found.message.scope, userId);
    if (!scope) return { error: 'Conversa não encontrada.' };
    const storedFiles = await store.deleteMessage(found.message.id);
    for (const storageName of storedFiles) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, storageName)).catch((err) => {
        if (err.code !== 'ENOENT') console.error('[uvoz] erro removendo anexo:', err);
      });
    }
    emitToScope(scope, 'message:deleted', { id: found.message.id, scope: found.message.scope });
    return { ok: true };
  });

  on('read:mark', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    const messageId = Number(p.messageId) || 0;
    if (!scope || !messageId) return { ok: false };
    await store.markRead(userId, scope, messageId);
    socket.to(`user:${userId}`).emit('read:updated', { scope: scopeKey(scope), lastReadId: messageId });
    return { ok: true };
  });

  on('typing', async (p) => {
    const scope = await resolveScope(p.scope, userId);
    if (!scope) return { ok: false };
    const payload = { scope: { type: scope.type, id: scope.id }, userId };
    if (scope.type === 'channel') socket.broadcast.emit('typing', payload);
    else {
      const other = store.dmMembers(scope.dm).find((m) => m !== userId);
      if (other) io.to(`user:${other}`).emit('typing', payload);
    }
    return { ok: true };
  });

  // ----- Mensagens diretas -------------------------------------------------
  on('dm:open', async (p) => {
    const otherId = Number(p.userId);
    if (!store.users.has(otherId) || otherId === userId) return { error: 'Usuário não encontrado.' };
    const dm = await store.openDm(userId, otherId);
    io.to(`user:${userId}`).emit('dm:upsert', store.publicDm(dm, userId));
    return { dm: store.publicDm(dm, userId) };
  });

  // ----- Salas de voz / vídeo ---------------------------------------------
  on('voice:join', async (p) => {
    const channel = store.getChannel(p.channelId);
    if (!channel || channel.type !== 'voice') return { error: 'Sala não encontrada.' };
    // Reentrada após queda de rede: o socket antigo do mesmo usuário pode ainda constar na sala.
    const ghost = typeof p.replaces === 'string' && p.replaces !== socket.id ? voiceStates.get(p.replaces) : null;
    if (ghost && ghost.userId === userId) {
      const old = io.sockets.sockets.get(p.replaces);
      if (old) { leaveVoice(old); old.disconnect(true); }
      else { voiceStates.delete(p.replaces); io.emit('voice:state', { socketId: p.replaces, userId, channelId: null }); }
    }
    const current = [...voiceStates.values()].filter((v) => v.channelId === channel.id && v.socketId !== socket.id);
    const mine = voiceStates.get(socket.id);
    if (mine?.channelId === channel.id) return { peers: current, iceServers: iceServersFor(socket.id) };
    if (current.length >= MAX_PEERS_PER_ROOM) return { error: `Sala cheia (máx. ${MAX_PEERS_PER_ROOM} pessoas).` };
    leaveVoice(socket);
    const state = { socketId: socket.id, userId, channelId: channel.id, media: emptyMedia() };
    voiceStates.set(socket.id, state);
    socket.join(`voice:${channel.id}`);
    socket.to(`voice:${channel.id}`).emit('voice:peer-joined', state);
    io.emit('voice:state', state);
    return { peers: current, iceServers: iceServersFor(socket.id) };
  });

  on('voice:leave', async () => {
    leaveVoice(socket);
    return { ok: true };
  });

  socket.on('voice:media', (p) => {
    const state = voiceStates.get(socket.id);
    if (!state) return;
    state.media = {
      mic: !!p?.mic,
      cam: !!p?.cam,
      screen: !!p?.screen,
      cameraStreamId: sanitizeText(p?.cameraStreamId, 100) || null,
      screenStreamId: sanitizeText(p?.screenStreamId, 100) || null,
    };
    io.emit('voice:state', state);
  });

  // Repasse de sinalização WebRTC — apenas entre sockets na mesma sala.
  socket.on('signal', (p) => {
    const mine = voiceStates.get(socket.id);
    const target = voiceStates.get(p?.to);
    if (!mine || !target || mine.channelId !== target.channelId) return;
    io.to(target.socketId).emit('signal', { from: socket.id, data: p.data });
  });

  // ----- Estado inicial ------------------------------------------------------
  // Enviado depois de registrar os handlers: o que o cliente emitir logo após conectar não se perde.
  try {
    const dms = await store.listDms(userId);
    const [unread, initial, ownEmail] = await Promise.all([
      store.unreadSummary(userId, dms),
      initialMessages(socket.handshake.auth?.view, userId),
      store.getUserEmail(userId),
    ]);
    socket.emit('init', {
      me: { ...me, email: ownEmail },
      socketId: socket.id,
      channels: store.listChannels(),
      users: [...store.users.values()].map((u) => ({ ...u, online: isOnline(u.id), lastSeen: store.lastSeenAt.get(u.id) || null })),
      voice: [...voiceStates.values()],
      dms,
      unread,
      initial, // mensagens da conversa que o cliente vai abrir (economiza uma ida e volta)
      iceServers: iceServersFor(socket.id),
      maxPeersPerRoom: MAX_PEERS_PER_ROOM,
    });
  } catch (err) {
    console.error('[uvoz] erro ao iniciar sessão:', err);
    socket.emit('fatal', { error: 'Não foi possível carregar seus dados.' });
    socket.disconnect(true);
  }
});

/** Primeira página da conversa que o cliente tinha aberta; null em qualquer problema. */
async function initialMessages(view, userId) {
  try {
    if (!view || typeof view !== 'object' || !['channel', 'dm'].includes(view.type)) return null;
    if (!['string', 'number'].includes(typeof view.id)) return null;
    const scope = await resolveScope({ type: view.type, id: view.id }, userId);
    if (!scope) return null;
    const page = await store.getMessages(scope);
    return { key: scopeKey(scope), messages: page.messages, hasMore: page.hasMore };
  } catch {
    return null;
  }
}

function leaveVoice(socket) {
  const state = voiceStates.get(socket.id);
  if (!state) return;
  voiceStates.delete(socket.id);
  socket.leave(`voice:${state.channelId}`);
  socket.to(`voice:${state.channelId}`).emit('voice:peer-left', { socketId: socket.id });
  io.emit('voice:state', { socketId: socket.id, userId: state.userId, channelId: null });
}

app.use((err, req, res, next) => {
  if (req.path === '/api/attachments' && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'O limite total por mensagem é 10 MB.' });
  }
  if (req.path === '/api/profile/avatar' && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'A imagem deve ter no máximo 10 MB.' });
  }
  console.error('[uvoz] erro HTTP:', err);
  next(err);
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
async function main() {
  await migrate(pool);
  await store.loadUsers();
  await store.seedChannels(LEGACY_DATA_FILE);
  await store.loadChannels();
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  const runAttachmentCleanup = async () => {
    await store.purgePendingAttachments(UPLOAD_DIR, Date.now() - 24 * 3600 * 1000);
    await store.purgeExpiredAttachments(UPLOAD_DIR, Date.now() - ATTACHMENT_RETENTION_MS);
  };
  await runAttachmentCleanup().catch((err) => console.error('[uvoz] erro limpando anexos:', err));
  setInterval(() => runAttachmentCleanup()
    .catch((err) => console.error('[uvoz] erro limpando anexos:', err)), 60 * 60 * 1000).unref();
  loadAssets();
  await auth.purgeExpiredSessions(pool);
  setInterval(() => auth.purgeExpiredSessions(pool).catch(() => {}), 6 * 3600 * 1000).unref();

  server.listen(PORT, HOST, () => {
    console.log(`[uvoz] rodando em http://${HOST}:${PORT}`);
    if (!ACCESS_CODE) console.log('[uvoz] ATENÇÃO: ACCESS_CODE não definido — qualquer pessoa pode criar conta.');
    console.log(`[uvoz] TURN ${TURN_SECRET && TURN_URLS.length ? 'ativo: ' + TURN_URLS.join(', ') : 'desativado (apenas STUN)'}`);
  });
}

main().catch((err) => {
  console.error('[uvoz] falha ao iniciar:', err);
  process.exit(1);
});
