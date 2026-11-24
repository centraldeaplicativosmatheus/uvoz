/**
 * Suporte a clientes: aplicativos conectados, token assinado do cliente, contatos,
 * conversas de atendimento e horário de funcionamento.
 *
 * Cada cliente (contato) tem uma única conversa. "Resolver" encerra o atendimento; a
 * próxima mensagem do cliente reabre a mesma conversa, com o histórico inteiro.
 */
const crypto = require('crypto');

const CONTACT_COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c', '#e67e22'];
const MAX_TOKEN_LIFETIME_S = 24 * 3600;
const CLOCK_SKEW_S = 60;
const APP_CACHE_MS = 60 * 1000;
const RESOLVED_LIST_LIMIT = 50;
const AUTO_NOTICE_INTERVAL_MS = 6 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Token do cliente (JWT HS256 assinado pelo servidor da aplicação)
// ---------------------------------------------------------------------------
const b64url = (value) => Buffer.from(value).toString('base64url');

/** Gera um token; usado pelos scripts de teste. Em produção quem assina é a aplicação do cliente. */
function signToken(claims, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const signature = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

/**
 * Confere assinatura e validade. Devolve { identity: { id, name, email } } ou { error }.
 * Exigências: alg HS256; "sub" (id da conta); "name"; "exp" no futuro e a no máximo 24 h.
 */
function verifyToken(token, secret) {
  const invalid = { error: 'TOKEN_INVALIDO' };
  if (typeof token !== 'string' || token.length > 4096) return invalid;
  const parts = token.split('.');
  if (parts.length !== 3) return invalid;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return invalid;
  }
  if (!header || header.alg !== 'HS256' || !claims || typeof claims !== 'object') return invalid;

  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return invalid;

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) return invalid;
  if (exp <= now - CLOCK_SKEW_S) return { error: 'TOKEN_EXPIRADO' };
  if (exp > now + MAX_TOKEN_LIFETIME_S + CLOCK_SKEW_S) return invalid;

  const id = ['string', 'number'].includes(typeof claims.sub) ? String(claims.sub).trim() : '';
  const name = cleanText(claims.name, 80);
  if (!id || id.length > 128 || !name) return invalid;
  const email = typeof claims.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
    ? claims.email.trim().toLowerCase().slice(0, 255) : null;
  return { identity: { id, name, email } };
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Horário de atendimento
// ---------------------------------------------------------------------------
const DAY_NAMES = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
const WEEKDAY_NUMBER = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * Lê "1-5 09:00-18:00" (dias de 1 = segunda a 7 = domingo, e o intervalo de horas).
 * Devolve null quando não há horário configurado ou o valor é inválido.
 */
function parseHours(value, timeZone = 'America/Sao_Paulo') {
  if (!value) return null;
  const match = String(value).trim().match(/^([1-7])(?:-([1-7]))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) {
    console.warn('[uvoz] SUPPORT_HOURS inválido; use o formato "1-5 09:00-18:00".');
    return null;
  }
  const firstDay = Number(match[1]);
  const lastDay = Number(match[2] || match[1]);
  const open = Number(match[3]) * 60 + Number(match[4]);
  const close = Number(match[5]) * 60 + Number(match[6]);
  if (lastDay < firstDay || close <= open || close > 24 * 60) {
    console.warn('[uvoz] SUPPORT_HOURS inválido; use o formato "1-5 09:00-18:00".');
    return null;
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    console.warn(`[uvoz] SUPPORT_TIMEZONE inválido: ${timeZone}.`);
    return null;
  }
  const clock = (minutes) => `${Math.floor(minutes / 60)}h${minutes % 60 ? String(minutes % 60).padStart(2, '0') : ''}`;
  const days = firstDay === 1 && lastDay === 7 ? 'todos os dias'
    : firstDay === lastDay ? `${firstDay >= 6 ? 'aos' : 'às'} ${DAY_NAMES[firstDay]}s`
      : lastDay === firstDay + 1 ? `${DAY_NAMES[firstDay]} e ${DAY_NAMES[lastDay]}`
        : `de ${DAY_NAMES[firstDay]} a ${DAY_NAMES[lastDay]}`;
  return { firstDay, lastDay, open, close, formatter, text: `${days}, das ${clock(open)} às ${clock(close)}` };
}

/** Sem horário configurado, o atendimento é considerado sempre aberto. */
function isOpen(hours, now = Date.now()) {
  if (!hours) return true;
  const parts = Object.fromEntries(hours.formatter.formatToParts(now).map((p) => [p.type, p.value]));
  const day = WEEKDAY_NUMBER[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return day >= hours.firstDay && day <= hours.lastDay && minutes >= hours.open && minutes < hours.close;
}

// ---------------------------------------------------------------------------
// Arquivos enviados por clientes
// ---------------------------------------------------------------------------
const CONTACT_FILE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const startsWith = (data, hex) => data.length >= hex.length / 2 && data.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));

/** Tipo do arquivo, se a extensão é aceita e o conteúdo corresponde a ela; senão null. */
function contactFileType(extension, data) {
  const mime = CONTACT_FILE_TYPES[extension];
  if (!mime) return null;
  let matches;
  switch (extension) {
    case 'png': matches = startsWith(data, '89504e470d0a1a0a'); break;
    case 'jpg': case 'jpeg': matches = startsWith(data, 'ffd8ff'); break;
    case 'gif': matches = startsWith(data, '474946383761') || startsWith(data, '474946383961'); break;
    case 'webp': matches = startsWith(data, '52494646') && data.length >= 12 && data.subarray(8, 12).toString('latin1') === 'WEBP'; break;
    case 'pdf': matches = startsWith(data, '255044462d'); break;
    case 'xlsx': case 'docx': matches = startsWith(data, '504b0304'); break;
    case 'xls': case 'doc': matches = startsWith(data, 'd0cf11e0a1b11ae1'); break;
    default: matches = !data.subarray(0, 8192).includes(0); // texto: sem bytes nulos
  }
  return matches ? mime : null;
}

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------
const CONVERSATION_SELECT = `
  SELECT c.id, c.status, c.assignee_id, c.created_at, c.last_message_at, c.contact_last_read_id, c.auto_notice_at,
         c.resolved_count,
         k.id AS contact_id, k.external_id, k.name AS contact_name, k.email AS contact_email, k.color AS contact_color,
         a.id AS app_id, a.name AS app_name
  FROM support_conversations c
  JOIN support_contacts k ON k.id = c.contact_id
  JOIN support_apps a ON a.id = k.app_id`;

class SupportStore {
  /** `store` é o Store principal: daqui usamos o cache do último id de mensagem por conversa. */
  constructor(pool, store) {
    this.pool = pool;
    this.store = store;
    this.agents = new Set(); // ids dos usuários que atendem o suporte
    this.apps = new Map(); // id -> { app, loadedAt }
  }

  async loadAgents() {
    const [rows] = await this.pool.query('SELECT id FROM users WHERE is_support = 1');
    this.agents = new Set(rows.map((r) => r.id));
  }

  isAgent(userId) {
    return this.agents.has(userId);
  }

  /** Aplicativo conectado, com cache curto: criar um aplicativo novo não exige reiniciar o servidor. */
  async getApp(id) {
    const key = String(id || '');
    if (!/^[a-z0-9-]{1,48}$/.test(key)) return null;
    const cached = this.apps.get(key);
    if (cached && Date.now() - cached.loadedAt < APP_CACHE_MS) return cached.app;
    const [rows] = await this.pool.query('SELECT id, name, secret FROM support_apps WHERE id = ?', [key]);
    const app = rows[0] || null;
    this.apps.set(key, { app, loadedAt: Date.now() });
    return app;
  }

  /** Autentica o cliente do widget: { app: { id, name }, identity } ou { error }. */
  async authenticate(appId, token) {
    const app = await this.getApp(appId);
    if (!app) return { error: 'APP_INVALIDO' };
    const result = verifyToken(token, app.secret);
    if (result.error) return result;
    return { app: { id: app.id, name: app.name }, identity: result.identity };
  }

  // ---------------------------------------------------------------- contatos
  async findContact(appId, externalId) {
    const [rows] = await this.pool.query(
      'SELECT * FROM support_contacts WHERE app_id = ? AND external_id = ?', [appId, externalId],
    );
    return rows[0] || null;
  }

  /** Cria o contato na primeira interação e mantém nome e email atualizados. */
  async ensureContact(appId, identity, conn = this.pool) {
    const now = Date.now();
    const color = CONTACT_COLORS[crypto.randomInt(CONTACT_COLORS.length)];
    await conn.query(
      `INSERT INTO support_contacts (app_id, external_id, name, email, color, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email), last_seen_at = VALUES(last_seen_at)`,
      [appId, identity.id, identity.name, identity.email, color, now, now],
    );
    const [rows] = await conn.query(
      'SELECT * FROM support_contacts WHERE app_id = ? AND external_id = ?', [appId, identity.id],
    );
    return rows[0];
  }

  // --------------------------------------------------------------- conversas
  publicConversation(row) {
    return {
      id: row.id,
      status: row.status,
      assigneeId: row.assignee_id || null,
      createdAt: Number(row.created_at),
      lastMessageAt: Number(row.last_message_at || row.created_at),
      resolvedCount: Number(row.resolved_count || 0), // atendimentos já concluídos com este cliente
      contactLastReadId: Number(row.contact_last_read_id || 0),
      autoNoticeAt: row.auto_notice_at ? Number(row.auto_notice_at) : null,
      contact: {
        id: row.contact_id, externalId: row.external_id, name: row.contact_name,
        email: row.contact_email || null, color: row.contact_color,
      },
      app: { id: row.app_id, name: row.app_name },
    };
  }

  /**
   * O que toda a equipe vê na fila de atendimento: quem é o cliente e em que situação está.
   * Dados de contato e o conteúdo da conversa ficam só com quem atende.
   */
  queueItem(conversation) {
    return {
      id: conversation.id,
      status: conversation.status,
      lastMessageAt: conversation.lastMessageAt,
      resolvedCount: conversation.resolvedCount,
      contact: { name: conversation.contact.name, color: conversation.contact.color },
      app: { name: conversation.app.name },
    };
  }

  async getConversation(id) {
    const [rows] = await this.pool.query(`${CONVERSATION_SELECT} WHERE c.id = ?`, [Number(id) || 0]);
    return rows[0] ? this.publicConversation(rows[0]) : null;
  }

  async getConversationByContact(contactId) {
    const [rows] = await this.pool.query(`${CONVERSATION_SELECT} WHERE c.contact_id = ?`, [contactId]);
    return rows[0] ? this.publicConversation(rows[0]) : null;
  }

  /** Para a fila de atendimento: todas as abertas e as resolvidas mais recentes. */
  async listConversations() {
    const [open] = await this.pool.query(
      `${CONVERSATION_SELECT} WHERE c.status = 'open' ORDER BY c.last_message_at DESC`,
    );
    const [resolved] = await this.pool.query(
      `${CONVERSATION_SELECT} WHERE c.status = 'resolved' ORDER BY c.last_message_at DESC LIMIT ?`,
      [RESOLVED_LIST_LIMIT],
    );
    return [...open, ...resolved].map((row) => this.publicConversation(row));
  }

  /** Maior id de mensagem de cada conversa, para a contagem de não lidas. */
  async loadLastIds() {
    const [rows] = await this.pool.query(
      'SELECT support_id AS k, MAX(id) AS last_id FROM messages WHERE support_id IS NOT NULL GROUP BY support_id',
    );
    for (const r of rows) this.store.lastIds.set(`s:${r.k}`, Number(r.last_id));
  }

  /**
   * Grava a mensagem de um cliente. Cria o contato e a conversa se for a primeira, e reabre a
   * conversa se estava resolvida. Repetir o mesmo clientId devolve a mensagem já gravada.
   * Devolve { messageId, conversationId, duplicate } ou { error }.
   */
  async createContactMessage({ app, identity, text, attachmentIds, clientId }) {
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 5
      || attachmentIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      || new Set(attachmentIds).size !== attachmentIds.length) {
      return { error: 'Lista de arquivos inválida.' };
    }
    const now = Date.now();
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const contact = await this.ensureContact(app.id, identity, conn);
      await conn.query(
        'INSERT IGNORE INTO support_conversations (contact_id, status, created_at) VALUES (?, ?, ?)',
        [contact.id, 'open', now],
      );
      const [[conversation]] = await conn.query(
        'SELECT id FROM support_conversations WHERE contact_id = ? FOR UPDATE', [contact.id],
      );

      if (clientId) {
        const [existing] = await conn.query(
          'SELECT id FROM messages WHERE support_id = ? AND contact_id = ? AND client_id = ? LIMIT 1',
          [conversation.id, contact.id, clientId],
        );
        if (existing.length) {
          await conn.commit();
          return { messageId: Number(existing[0].id), conversationId: conversation.id, duplicate: true };
        }
      }

      if (attachmentIds.length) {
        const [files] = await conn.query(
          'SELECT id, size_bytes FROM message_attachments WHERE id IN (?) AND contact_id = ? AND message_id IS NULL FOR UPDATE',
          [attachmentIds, contact.id],
        );
        if (files.length !== attachmentIds.length) {
          await conn.rollback();
          return { error: 'Um ou mais arquivos não estão disponíveis. Anexe-os novamente.' };
        }
        if (files.reduce((total, f) => total + Number(f.size_bytes), 0) > 10 * 1024 * 1024) {
          await conn.rollback();
          return { error: 'O limite total por mensagem é 10 MB.' };
        }
      }

      const [res] = await conn.query(
        `INSERT INTO messages (support_id, contact_id, author_name, author_color, body, created_at, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [conversation.id, contact.id, contact.name.slice(0, 40), contact.color, text, now, clientId || null],
      );
      const messageId = Number(res.insertId);
      if (attachmentIds.length) {
        await conn.query(
          'UPDATE message_attachments SET message_id = ? WHERE id IN (?) AND contact_id = ? AND message_id IS NULL',
          [messageId, attachmentIds, contact.id],
        );
      }
      await conn.query(
        `UPDATE support_conversations
         SET status = 'open', last_message_at = ?, resolved_at = NULL, resolved_by = NULL,
             contact_last_read_id = GREATEST(contact_last_read_id, ?)
         WHERE id = ?`,
        [now, messageId, conversation.id],
      );
      await conn.commit();
      this.touchLastId(conversation.id, messageId);
      return { messageId, conversationId: conversation.id, duplicate: false };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Aviso do sistema dentro da conversa (encerramento, fora do horário). Devolve o id da mensagem. */
  async createSystemMessage(conversationId, text) {
    const [res] = await this.pool.query(
      "INSERT INTO messages (support_id, author_name, body, kind, created_at) VALUES (?, 'Sistema', ?, 'system', ?)",
      [conversationId, text, Date.now()],
    );
    const messageId = Number(res.insertId);
    this.touchLastId(conversationId, messageId);
    return messageId;
  }

  touchLastId(conversationId, messageId) {
    const key = `s:${conversationId}`;
    this.store.lastIds.set(key, Math.max(this.store.lastIds.get(key) || 0, messageId));
  }

  /** Muda a situação da conversa. Devolve false se ela já estava nessa situação. */
  async setStatus(conversationId, status, userId) {
    const resolved = status === 'resolved';
    const [res] = await this.pool.query(
      `UPDATE support_conversations
       SET status = ?, resolved_at = ?, resolved_by = ?, resolved_count = resolved_count + ?
       WHERE id = ? AND status <> ?`,
      [status, resolved ? Date.now() : null, resolved ? userId : null, resolved ? 1 : 0, conversationId, status],
    );
    return res.affectedRows > 0;
  }

  /** Registra que o aviso de fora do horário foi enviado; false se outro envio recente já registrou. */
  async claimAutoNotice(conversationId) {
    const now = Date.now();
    const [res] = await this.pool.query(
      'UPDATE support_conversations SET auto_notice_at = ? WHERE id = ? AND (auto_notice_at IS NULL OR auto_notice_at < ?)',
      [now, conversationId, now - AUTO_NOTICE_INTERVAL_MS],
    );
    return res.affectedRows > 0;
  }

  async markContactRead(conversationId, messageId) {
    await this.pool.query(
      'UPDATE support_conversations SET contact_last_read_id = GREATEST(contact_last_read_id, ?) WHERE id = ?',
      [messageId, conversationId],
    );
  }

  /** O anexo pertence a uma mensagem da conversa deste contato? */
  async contactCanReadAttachment(contactId, attachment) {
    if (!attachment?.message_id) return false;
    const [rows] = await this.pool.query(
      `SELECT 1 FROM messages m JOIN support_conversations c ON c.id = m.support_id
       WHERE m.id = ? AND c.contact_id = ? LIMIT 1`,
      [attachment.message_id, contactId],
    );
    return rows.length > 0;
  }
}

module.exports = { SupportStore, signToken, verifyToken, parseHours, isOpen, contactFileType, cleanText };
