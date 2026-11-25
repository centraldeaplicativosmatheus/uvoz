/**
 * Conexão com o MySQL e migrações do esquema.
 * Compatível com MySQL 8 e MariaDB 10.6+.
 */
const mysql = require('mysql2/promise');

function createPool() {
  const url = process.env.DATABASE_URL;
  const base = url
    ? { uri: url }
    : {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USERNAME || 'uvoz',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || 'uvoz',
      };
  return mysql.createPool({
    ...base,
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    waitForConnections: true,
    enableKeepAlive: true,
  });
}

// Cada migração roda uma única vez, em ordem. Nunca altere uma já publicada: crie outra.
const MIGRATIONS = [
  {
    id: 1,
    name: 'esquema inicial',
    sql: [
      `CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(32) NOT NULL,
        display_name VARCHAR(40) NOT NULL,
        color VARCHAR(9) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        read_floor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        created_at BIGINT UNSIGNED NOT NULL,
        last_seen_at BIGINT UNSIGNED NULL,
        UNIQUE KEY users_username_unique (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        expires_at BIGINT UNSIGNED NOT NULL,
        user_agent VARCHAR(255) NULL,
        KEY sessions_user_id (user_id),
        CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS channels (
        id VARCHAR(48) NOT NULL PRIMARY KEY,
        name VARCHAR(40) NOT NULL,
        type VARCHAR(8) NOT NULL,
        topic VARCHAR(120) NULL,
        position INT NOT NULL DEFAULT 0,
        created_by INT UNSIGNED NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        CONSTRAINT channels_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS dm_conversations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_low INT UNSIGNED NOT NULL,
        user_high INT UNSIGNED NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        last_message_at BIGINT UNSIGNED NULL,
        UNIQUE KEY dm_pair_unique (user_low, user_high),
        KEY dm_user_high (user_high),
        CONSTRAINT dm_low_fk FOREIGN KEY (user_low) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT dm_high_fk FOREIGN KEY (user_high) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS messages (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        channel_id VARCHAR(48) NULL,
        dm_id INT UNSIGNED NULL,
        author_id INT UNSIGNED NULL,
        author_name VARCHAR(40) NULL,
        author_color VARCHAR(9) NULL,
        body TEXT NOT NULL,
        mentions_everyone TINYINT(1) NOT NULL DEFAULT 0,
        created_at BIGINT UNSIGNED NOT NULL,
        edited_at BIGINT UNSIGNED NULL,
        KEY messages_channel (channel_id, id),
        KEY messages_dm (dm_id, id),
        KEY messages_author (author_id),
        CONSTRAINT messages_channel_fk FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE,
        CONSTRAINT messages_dm_fk FOREIGN KEY (dm_id) REFERENCES dm_conversations (id) ON DELETE CASCADE,
        CONSTRAINT messages_author_fk FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS message_mentions (
        message_id BIGINT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        PRIMARY KEY (message_id, user_id),
        KEY mentions_user (user_id, message_id),
        CONSTRAINT mentions_message_fk FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
        CONSTRAINT mentions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS read_states (
        user_id INT UNSIGNED NOT NULL,
        scope VARCHAR(64) NOT NULL,
        last_read_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, scope),
        CONSTRAINT read_states_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 2,
    name: 'anexos de mensagens',
    sql: [
      `CREATE TABLE IF NOT EXISTS message_attachments (
        id CHAR(36) NOT NULL PRIMARY KEY,
        message_id BIGINT UNSIGNED NULL,
        uploader_id INT UNSIGNED NULL,
        original_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        size_bytes INT UNSIGNED NOT NULL,
        storage_name CHAR(36) NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        KEY attachments_message (message_id),
        KEY attachments_pending (uploader_id, message_id, created_at),
        CONSTRAINT attachments_message_fk FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
        CONSTRAINT attachments_uploader_fk FOREIGN KEY (uploader_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 3,
    name: 'fotos de perfil',
    sql: [
      `ALTER TABLE users
        ADD COLUMN avatar_storage_name CHAR(36) NULL,
        ADD COLUMN avatar_mime_type VARCHAR(32) NULL,
        ADD COLUMN avatar_updated_at BIGINT UNSIGNED NULL`,
    ],
  },
  {
    id: 4,
    name: 'respostas a mensagens',
    sql: [
      `ALTER TABLE messages
        ADD COLUMN reply_to_id BIGINT UNSIGNED NULL,
        ADD KEY messages_reply_to (reply_to_id),
        ADD CONSTRAINT messages_reply_to_fk FOREIGN KEY (reply_to_id) REFERENCES messages (id) ON DELETE SET NULL`,
    ],
  },
  {
    id: 5,
    name: 'avatares persistentes no banco',
    sql: [
      `ALTER TABLE users
        ADD COLUMN avatar_data MEDIUMBLOB NULL`,
    ],
  },
  {
    id: 6,
    name: 'emails e redefinicao de senha',
    sql: [
      `ALTER TABLE users
        ADD COLUMN email VARCHAR(255) NULL,
        ADD UNIQUE KEY users_email_unique (email)`,
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        expires_at BIGINT UNSIGNED NOT NULL,
        used_at BIGINT UNSIGNED NULL,
        KEY password_reset_user (user_id),
        KEY password_reset_expiry (expires_at),
        CONSTRAINT password_reset_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 7,
    name: 'anexos persistentes por 30 dias',
    sql: [
      `ALTER TABLE message_attachments
        ADD COLUMN file_data MEDIUMBLOB NULL,
        ADD KEY attachments_expiry (created_at)`,
    ],
  },
  // Suporte a clientes: uma migração por tabela alterada, para que uma falha no meio não
  // deixe alterações pela metade.
  {
    id: 8,
    name: 'suporte: aplicativos, contatos e conversas',
    sql: [
      `CREATE TABLE IF NOT EXISTS support_apps (
        id VARCHAR(48) NOT NULL PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        secret VARCHAR(128) NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS support_contacts (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        app_id VARCHAR(48) NOT NULL,
        external_id VARCHAR(128) NOT NULL,
        name VARCHAR(80) NOT NULL,
        email VARCHAR(255) NULL,
        color VARCHAR(9) NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        last_seen_at BIGINT UNSIGNED NULL,
        UNIQUE KEY support_contact_unique (app_id, external_id),
        CONSTRAINT support_contact_app_fk FOREIGN KEY (app_id) REFERENCES support_apps (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS support_conversations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        contact_id INT UNSIGNED NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'open',
        assignee_id INT UNSIGNED NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        last_message_at BIGINT UNSIGNED NULL,
        resolved_at BIGINT UNSIGNED NULL,
        resolved_by INT UNSIGNED NULL,
        contact_last_read_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        auto_notice_at BIGINT UNSIGNED NULL,
        UNIQUE KEY support_conversation_contact (contact_id),
        KEY support_conversation_status (status, last_message_at),
        CONSTRAINT support_conversation_contact_fk FOREIGN KEY (contact_id) REFERENCES support_contacts (id) ON DELETE CASCADE,
        CONSTRAINT support_conversation_assignee_fk FOREIGN KEY (assignee_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT support_conversation_resolver_fk FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 9,
    name: 'suporte: atendentes',
    sql: ['ALTER TABLE users ADD COLUMN is_support TINYINT(1) NOT NULL DEFAULT 0'],
  },
  {
    id: 10,
    name: 'suporte: mensagens de atendimento',
    sql: [
      `ALTER TABLE messages
        ADD COLUMN support_id INT UNSIGNED NULL,
        ADD COLUMN contact_id INT UNSIGNED NULL,
        ADD COLUMN kind VARCHAR(12) NULL,
        ADD COLUMN client_id VARCHAR(40) NULL,
        ADD KEY messages_support (support_id, id)`,
    ],
  },
  {
    id: 11,
    name: 'suporte: vínculo das mensagens com a conversa',
    sql: [
      `ALTER TABLE messages
        ADD CONSTRAINT messages_support_fk FOREIGN KEY (support_id) REFERENCES support_conversations (id) ON DELETE CASCADE`,
    ],
  },
  {
    id: 12,
    name: 'suporte: anexos enviados por clientes',
    // Só a coluna, sem índice nem chave estrangeira: assim a tabela (que guarda os arquivos) não é reescrita.
    sql: ['ALTER TABLE message_attachments ADD COLUMN contact_id INT UNSIGNED NULL'],
  },
  {
    id: 13,
    name: 'suporte: contagem de atendimentos concluídos',
    sql: ['ALTER TABLE support_conversations ADD COLUMN resolved_count INT UNSIGNED NOT NULL DEFAULT 0'],
  },
  {
    id: 14,
    name: 'suporte: contagem inicial a partir do histórico',
    // Pode rodar mais de uma vez sem efeito colateral: recalcula a partir dos avisos de encerramento.
    sql: [
      `UPDATE support_conversations c
       SET c.resolved_count = (
         SELECT COUNT(*) FROM messages m
         WHERE m.support_id = c.id AND m.kind = 'system' AND m.body = 'Atendimento encerrado')`,
    ],
  },
  // Leads do site: visitantes sem conta conversam pelo widget e caem em uma fila própria.
  {
    id: 15,
    name: 'leads: tipo da aplicação',
    // 'support' = clientes logados, com token assinado pela aplicação; 'leads' = visitantes do site.
    sql: ["ALTER TABLE support_apps ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'support'"],
  },
  {
    id: 16,
    name: 'leads: contato do visitante',
    sql: [
      `ALTER TABLE support_contacts
        ADD COLUMN phone VARCHAR(32) NULL,
        ADD COLUMN source VARCHAR(500) NULL,
        ADD COLUMN visitor_token_hash CHAR(64) NULL,
        ADD UNIQUE KEY support_contact_visitor (visitor_token_hash)`,
    ],
  },
  {
    id: 17,
    name: 'leads: quem atende',
    sql: ['ALTER TABLE users ADD COLUMN is_leads TINYINT(1) NOT NULL DEFAULT 0'],
  },
  {
    id: 18,
    name: 'leads: aplicação do site',
    // O segredo não é usado por aplicações de leads (o visitante não traz token assinado); fica só preenchido.
    sql: [
      `INSERT IGNORE INTO support_apps (id, name, secret, kind, created_at)
       VALUES ('site', 'Site Unicopag', SHA2(CONCAT(UUID(), RAND(), NOW(6)), 256), 'leads', UNIX_TIMESTAMP() * 1000)`,
    ],
  },
];

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INT UNSIGNED NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    applied_at BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [rows] = await pool.query('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    for (const statement of m.sql) await pool.query(statement);
    await pool.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, Date.now()]);
    console.log(`[uvoz] migração ${m.id} aplicada: ${m.name}`);
  }
}

module.exports = { createPool, migrate };
