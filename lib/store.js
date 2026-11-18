/**
 * Acesso a dados: usuários, canais, mensagens, DMs, menções e leitura.
 * "scope" identifica onde está uma mensagem: { type: 'channel', id: 'geral' } ou { type: 'dm', id: 12 }.
 */
const fs = require('fs');
const path = require('path');

const COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];
const PAGE_SIZE = 50;
const EVERYONE = new Set(['todos', 'everyone', 'here', 'aqui']);
const MENTION_RE = /(^|[^\w@])@([a-z0-9._-]{2,32})/gi;

const DEFAULT_CHANNELS = [
  { id: 'geral', name: 'geral', type: 'text', topic: 'Avisos e conversas gerais da Unicopag' },
  { id: 'comercial', name: 'comercial', type: 'text', topic: 'Time comercial' },
  { id: 'suporte', name: 'suporte', type: 'text', topic: 'Atendimento e suporte' },
  { id: 'sala-geral', name: 'Sala Geral', type: 'voice' },
  { id: 'reuniao', name: 'Reunião', type: 'voice' },
  { id: 'daily', name: 'Daily', type: 'voice' },
];

const scopeKey = (scope) => `${scope.type === 'dm' ? 'd' : 'c'}:${scope.id}`;

class Store {
  constructor(pool) {
    this.pool = pool;
    this.users = new Map(); // cache: id -> usuário público
    this.usernames = new Map(); // username -> id
    this.lastSeenAt = new Map(); // id -> ms (ou null)
    this.readFloor = new Map(); // id -> id da última mensagem existente quando a conta foi criada
    this.channels = new Map(); // cache: id -> { id, name, type, topic } na ordem de exibição
    this.dms = new Map(); // cache: id -> linha de dm_conversations (os membros nunca mudam)
    this.lastIds = new Map(); // 'c:<id>' | 'd:<id>' -> maior id de mensagem (pode ficar acima do real após exclusões)
  }

  // ---------------------------------------------------------------- usuários
  publicUser(row) {
    return { id: row.id, username: row.username, displayName: row.display_name, color: row.color };
  }

  async loadUsers() {
    const [rows] = await this.pool.query('SELECT id, username, display_name, color, last_seen_at, read_floor_id FROM users');
    this.users.clear();
    this.usernames.clear();
    this.lastSeenAt.clear();
    this.readFloor.clear();
    for (const r of rows) {
      this.cacheUser(this.publicUser(r));
      this.lastSeenAt.set(r.id, r.last_seen_at ? Number(r.last_seen_at) : null);
      this.readFloor.set(r.id, Number(r.read_floor_id || 0));
    }
  }

  cacheUser(u) {
    this.users.set(u.id, u);
    this.usernames.set(u.username.toLowerCase(), u.id);
  }

  async findUserForLogin(username) {
    const [rows] = await this.pool.query('SELECT * FROM users WHERE username = ?', [username]);
    return rows[0] || null;
  }

  async createUser({ username, displayName, passwordHash }) {
    const [[{ maxId }]] = await this.pool.query('SELECT COALESCE(MAX(id), 0) AS maxId FROM messages');
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const [res] = await this.pool.query(
      'INSERT INTO users (username, display_name, color, password_hash, read_floor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [username, displayName, color, passwordHash, maxId, Date.now()],
    );
    const user = { id: res.insertId, username, displayName, color };
    this.cacheUser(user);
    this.lastSeenAt.set(user.id, null);
    this.readFloor.set(user.id, Number(maxId));
    return user;
  }

  async setPassword(userId, passwordHash) {
    await this.pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
    await this.pool.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  async touchUser(userId) {
    const now = Date.now();
    this.lastSeenAt.set(userId, now); // antes do await: o "init" de outra conexão já enxerga o valor
    await this.pool.query('UPDATE users SET last_seen_at = ? WHERE id = ?', [now, userId]);
  }

  // ----------------------------------------------------------------- canais
  async seedChannels(legacyFile) {
    const [[{ n }]] = await this.pool.query('SELECT COUNT(*) AS n FROM channels');
    if (n > 0) return;
    let legacy = null;
    try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { /* sem dados antigos */ }
    const channels = Array.isArray(legacy?.channels) && legacy.channels.length ? legacy.channels : DEFAULT_CHANNELS;
    let position = 0;
    for (const c of channels) {
      await this.pool.query(
        'INSERT INTO channels (id, name, type, topic, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [String(c.id).slice(0, 48), String(c.name).slice(0, 40), c.type === 'voice' ? 'voice' : 'text', c.topic || null, position++, Date.now()],
      );
    }
    if (legacy?.messages) {
      let imported = 0;
      for (const [channelId, list] of Object.entries(legacy.messages)) {
        if (!channels.some((c) => c.id === channelId)) continue;
        for (const m of list) {
          await this.pool.query(
            'INSERT INTO messages (channel_id, author_name, author_color, body, created_at) VALUES (?, ?, ?, ?, ?)',
            [channelId, String(m.author?.name || 'Anônimo').slice(0, 40), m.author?.color || '#5865f2', String(m.text || ''), Number(m.ts) || Date.now()],
          );
          imported++;
        }
      }
      console.log(`[uvoz] ${imported} mensagens importadas de ${legacyFile}`);
    }
    if (legacy) {
      try { fs.renameSync(legacyFile, legacyFile + '.migrado'); } catch { /* ignore */ }
    }
  }

  /** Carrega canais e o maior id de mensagem por conversa. Chamar depois de seedChannels. */
  async loadChannels() {
    const [rows] = await this.pool.query('SELECT id, name, type, topic FROM channels ORDER BY position, created_at');
    this.channels.clear();
    for (const r of rows) this.channels.set(r.id, { id: r.id, name: r.name, type: r.type, topic: r.topic || '' });
    this.lastIds.clear();
    const [c] = await this.pool.query('SELECT channel_id AS k, MAX(id) AS last_id FROM messages WHERE channel_id IS NOT NULL GROUP BY channel_id');
    for (const r of c) this.lastIds.set(`c:${r.k}`, Number(r.last_id));
    const [d] = await this.pool.query('SELECT dm_id AS k, MAX(id) AS last_id FROM messages WHERE dm_id IS NOT NULL GROUP BY dm_id');
    for (const r of d) this.lastIds.set(`d:${r.k}`, Number(r.last_id));
  }

  listChannels() {
    return [...this.channels.values()].map((c) => ({ ...c }));
  }

  getChannel(id) {
    const c = this.channels.get(String(id ?? ''));
    return c ? { ...c } : null;
  }

  async createChannel({ id, name, type, topic, createdBy }) {
    const [[{ pos }]] = await this.pool.query('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM channels');
    await this.pool.query(
      'INSERT INTO channels (id, name, type, topic, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, type, topic || null, pos, createdBy, Date.now()],
    );
    const channel = { id, name, type, topic: topic || '' };
    this.channels.set(id, channel); // a posição nova é sempre a última, como no Map
    return { ...channel };
  }

  /** Compara sem diferenciar maiúsculas, como a collation do banco. */
  channelIdExists(id) {
    const wanted = String(id).toLowerCase();
    for (const k of this.channels.keys()) if (k.toLowerCase() === wanted) return true;
    return false;
  }

  countChannels(type) {
    if (!type) return this.channels.size;
    let n = 0;
    for (const c of this.channels.values()) if (c.type === type) n++;
    return n;
  }

  async deleteChannel(id) {
    await this.pool.query("DELETE FROM read_states WHERE scope = ?", [`c:${id}`]);
    await this.pool.query('DELETE FROM channels WHERE id = ?', [id]);
    this.channels.delete(id);
    this.lastIds.delete(`c:${id}`);
  }

  // -------------------------------------------------------------------- DMs
  async getDm(dmId) {
    const id = Number(dmId) || 0;
    const cached = this.dms.get(id);
    if (cached) return cached;
    const [rows] = await this.pool.query('SELECT * FROM dm_conversations WHERE id = ?', [id]);
    if (rows[0]) this.dms.set(id, rows[0]); // não guarda resultado nulo
    return rows[0] || null;
  }

  dmMembers(dm) {
    return [dm.user_low, dm.user_high];
  }

  async openDm(userA, userB) {
    const low = Math.min(userA, userB);
    const high = Math.max(userA, userB);
    await this.pool.query(
      'INSERT IGNORE INTO dm_conversations (user_low, user_high, created_at) VALUES (?, ?, ?)',
      [low, high, Date.now()],
    );
    const [rows] = await this.pool.query('SELECT * FROM dm_conversations WHERE user_low = ? AND user_high = ?', [low, high]);
    if (rows[0]) this.dms.set(rows[0].id, rows[0]);
    return rows[0];
  }

  async listDms(userId) {
    const [rows] = await this.pool.query(
      `SELECT id, user_low, user_high, created_at, last_message_at FROM dm_conversations
       WHERE user_low = ? OR user_high = ? ORDER BY COALESCE(last_message_at, created_at) DESC`,
      [userId, userId],
    );
    return rows.map((d) => this.publicDm(d, userId));
  }

  publicDm(d, userId) {
    return {
      id: d.id,
      userId: d.user_low === userId ? d.user_high : d.user_low,
      lastMessageAt: d.last_message_at ? Number(d.last_message_at) : Number(d.created_at),
    };
  }

  // -------------------------------------------------------------- mensagens
  parseMentions(text, allowEveryone) {
    const ids = new Set();
    let everyone = false;
    for (const m of text.matchAll(MENTION_RE)) {
      const name = m[2].toLowerCase().replace(/[.,;:!?-]+$/, '');
      if (EVERYONE.has(name)) { if (allowEveryone) everyone = true; continue; }
      const id = this.usernames.get(name);
      if (id) ids.add(id);
    }
    return { ids: [...ids], everyone };
  }

  rowToMessage(r, mentionMap) {
    const author = r.author_id ? this.users.get(r.author_id) : null;
    return {
      id: Number(r.id),
      scope: r.dm_id ? { type: 'dm', id: r.dm_id } : { type: 'channel', id: r.channel_id },
      author: author
        ? { id: author.id, name: author.displayName, username: author.username, color: author.color }
        : { id: null, name: r.author_name || 'Usuário removido', username: null, color: r.author_color || '#80848e' },
      text: r.body,
      ts: Number(r.created_at),
      editedTs: r.edited_at ? Number(r.edited_at) : null,
      mentions: mentionMap.get(Number(r.id)) || [],
      mentionsEveryone: !!r.mentions_everyone,
      attachments: r.attachments || [],
    };
  }

  async attachmentsFor(messageIds) {
    if (!messageIds.length) return new Map();
    const [rows] = await this.pool.query(
      'SELECT id, message_id, original_name, mime_type, size_bytes FROM message_attachments WHERE message_id IN (?) ORDER BY created_at, id',
      [messageIds],
    );
    const map = new Map();
    for (const row of rows) {
      const key = Number(row.message_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        id: row.id, name: row.original_name, type: row.mime_type, size: Number(row.size_bytes),
      });
    }
    return map;
  }

  async mentionMapFor(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const [rows] = await this.pool.query('SELECT message_id, user_id FROM message_mentions WHERE message_id IN (?)', [ids]);
    for (const r of rows) {
      const k = Number(r.message_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r.user_id);
    }
    return map;
  }

  async getMessages(scope, beforeId) {
    const col = scope.type === 'dm' ? 'dm_id' : 'channel_id';
    const params = [scope.id];
    let sql = `SELECT * FROM messages WHERE ${col} = ?`;
    if (beforeId) { sql += ' AND id < ?'; params.push(Number(beforeId)); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(PAGE_SIZE + 1);
    const [rows] = await this.pool.query(sql, params);
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE).reverse();
    const ids = page.map((r) => Number(r.id));
    const [mentionMap, attachmentMap] = await Promise.all([this.mentionMapFor(ids), this.attachmentsFor(ids)]);
    return {
      messages: page.map((r) => this.rowToMessage({ ...r, attachments: attachmentMap.get(Number(r.id)) || [] }, mentionMap)),
      hasMore,
    };
  }

  async getMessage(id) {
    const [rows] = await this.pool.query('SELECT * FROM messages WHERE id = ?', [Number(id) || 0]);
    if (!rows.length) return null;
    const messageId = Number(rows[0].id);
    const [mentionMap, attachmentMap] = await Promise.all([
      this.mentionMapFor([messageId]), this.attachmentsFor([messageId]),
    ]);
    const row = { ...rows[0], attachments: attachmentMap.get(messageId) || [] };
    return { row, message: this.rowToMessage(row, mentionMap) };
  }

  async createPendingAttachment(attachment) {
    await this.pool.query(
      `INSERT INTO message_attachments
        (id, message_id, uploader_id, original_name, mime_type, size_bytes, storage_name, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      [attachment.id, attachment.uploaderId, attachment.originalName, attachment.mimeType,
        attachment.size, attachment.storageName, Date.now()],
    );
  }

  async getAttachment(id) {
    const [rows] = await this.pool.query('SELECT * FROM message_attachments WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async purgePendingAttachments(uploadDir, olderThan) {
    const [rows] = await this.pool.query(
      'SELECT id, storage_name FROM message_attachments WHERE message_id IS NULL AND created_at < ?',
      [olderThan],
    );
    if (!rows.length) return;
    for (const row of rows) {
      const [result] = await this.pool.query(
        'DELETE FROM message_attachments WHERE id = ? AND message_id IS NULL AND created_at < ?',
        [row.id, olderThan],
      );
      if (!result.affectedRows) continue;
      await fs.promises.unlink(path.join(uploadDir, row.storage_name)).catch((err) => {
        if (err.code !== 'ENOENT') console.error('[uvoz] erro removendo anexo pendente:', err);
      });
    }
  }

  async createMessage(scope, authorId, text, attachmentIds = []) {
    if (!Array.isArray(attachmentIds)
      || attachmentIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      || new Set(attachmentIds).size !== attachmentIds.length) {
      return { error: 'Lista de arquivos inválida.' };
    }
    const now = Date.now();
    const mentions = this.parseMentions(text, scope.type === 'channel');
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      if (attachmentIds.length) {
        const [rows] = await conn.query(
          'SELECT id, size_bytes, mime_type FROM message_attachments WHERE id IN (?) AND uploader_id = ? AND message_id IS NULL FOR UPDATE',
          [attachmentIds, authorId],
        );
        if (rows.length !== attachmentIds.length) {
          await conn.rollback();
          return { error: 'Um ou mais arquivos não estão disponíveis. Anexe-os novamente.' };
        }
        const totalSize = rows.reduce((total, row) => total + Number(row.size_bytes), 0);
        if (totalSize > 10 * 1024 * 1024) {
          await conn.rollback();
          return { error: 'O limite total por mensagem é 10 MB.' };
        }
        const imageCount = rows.filter((row) => row.mime_type.startsWith('image/')).length;
        if (imageCount > 5) {
          await conn.rollback();
          return { error: 'Você pode enviar no máximo 5 imagens por mensagem.' };
        }
      }
      const [res] = await conn.query(
        'INSERT INTO messages (channel_id, dm_id, author_id, body, mentions_everyone, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [scope.type === 'channel' ? scope.id : null, scope.type === 'dm' ? scope.id : null, authorId, text, mentions.everyone ? 1 : 0, now],
      );
      const id = Number(res.insertId);
      if (attachmentIds.length) {
        await conn.query(
          'UPDATE message_attachments SET message_id = ? WHERE id IN (?) AND uploader_id = ? AND message_id IS NULL',
          [id, attachmentIds, authorId],
        );
      }
      if (mentions.ids.length) {
        await conn.query('INSERT IGNORE INTO message_mentions (message_id, user_id) VALUES ?', [mentions.ids.map((u) => [id, u])]);
      }
      if (scope.type === 'dm') await conn.query('UPDATE dm_conversations SET last_message_at = ? WHERE id = ?', [now, scope.id]);
      // Quem envia já leu a própria mensagem.
      await conn.query(
        'INSERT INTO read_states (user_id, scope, last_read_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, ?)',
        [authorId, scopeKey(scope), id, id],
      );
      await conn.commit();
      const key = scopeKey(scope);
      this.lastIds.set(key, Math.max(this.lastIds.get(key) || 0, id));
      // Monta a mensagem com o que já está em mãos (sem reler do banco).
      const attachmentMap = await this.attachmentsFor([id]);
      return this.rowToMessage(
        { id, channel_id: scope.type === 'channel' ? scope.id : null, dm_id: scope.type === 'dm' ? scope.id : null,
          author_id: authorId, body: text, created_at: now, edited_at: null, mentions_everyone: mentions.everyone,
          attachments: attachmentMap.get(id) || [] },
        new Map([[id, mentions.ids]]),
      );
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async editMessage(id, text, isChannel) {
    const mentions = this.parseMentions(text, isChannel);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('UPDATE messages SET body = ?, mentions_everyone = ?, edited_at = ? WHERE id = ?', [text, mentions.everyone ? 1 : 0, Date.now(), id]);
      await conn.query('DELETE FROM message_mentions WHERE message_id = ?', [id]);
      if (mentions.ids.length) {
        await conn.query('INSERT IGNORE INTO message_mentions (message_id, user_id) VALUES ?', [mentions.ids.map((u) => [id, u])]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return (await this.getMessage(id)).message;
  }

  async deleteMessage(id) {
    const [rows] = await this.pool.query('SELECT storage_name FROM message_attachments WHERE message_id = ?', [id]);
    await this.pool.query('DELETE FROM messages WHERE id = ?', [id]);
    return rows.map((row) => row.storage_name);
  }

  // ---------------------------------------------------------------- leitura
  async markRead(userId, scope, messageId) {
    await this.pool.query(
      'INSERT INTO read_states (user_id, scope, last_read_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, ?)',
      [userId, scopeKey(scope), messageId, messageId],
    );
  }

  /**
   * Não lidas e menções por canal/DM: { 'c:geral': { unread, mentions, lastReadId } }.
   * Uma contagem indexada por conversa (messages_channel / messages_dm), só nas conversas que
   * têm mensagem mais nova que o ponto de leitura — no caso comum, nenhuma consulta de contagem.
   * `dms` é a lista devolvida por listDms(userId).
   */
  async unreadSummary(userId, dms) {
    const floor = this.readFloor.get(userId) || 0;
    const [reads] = await this.pool.query('SELECT scope, last_read_id FROM read_states WHERE user_id = ?', [userId]);
    const readMap = new Map(reads.map((r) => [r.scope, Number(r.last_read_id)]));

    const branches = [];
    const params = [];
    const limits = new Map();
    for (const c of this.channels.values()) {
      const key = `c:${c.id}`;
      const limit = Math.max(readMap.get(key) || 0, floor);
      if ((this.lastIds.get(key) || 0) <= limit) continue;
      limits.set(key, limit);
      branches.push(`(SELECT ? AS k, COUNT(*) AS unread,
          COALESCE(SUM(m.mentions_everyone = 1 OR mm.user_id IS NOT NULL), 0) AS mentions
        FROM messages m
        LEFT JOIN message_mentions mm ON mm.message_id = m.id AND mm.user_id = ?
        WHERE m.channel_id = ? AND m.id > ? AND (m.author_id IS NULL OR m.author_id <> ?))`);
      params.push(key, userId, c.id, limit, userId);
    }
    for (const d of dms) {
      const key = `d:${d.id}`;
      const limit = readMap.get(key) || 0;
      if ((this.lastIds.get(key) || 0) <= limit) continue;
      limits.set(key, limit);
      branches.push(`(SELECT ? AS k, COUNT(*) AS unread, COUNT(*) AS mentions
        FROM messages m WHERE m.dm_id = ? AND m.id > ? AND m.author_id <> ?)`);
      params.push(key, d.id, limit, userId);
    }
    const out = {};
    if (!branches.length) return out;
    const [rows] = await this.pool.query(branches.join(' UNION ALL '), params);
    for (const r of rows) {
      const unread = Number(r.unread);
      if (!unread) continue;
      out[r.k] = { unread, mentions: Number(r.mentions), lastReadId: limits.get(r.k) };
    }
    return out;
  }
}

module.exports = { Store, scopeKey, DEFAULT_CHANNELS };
