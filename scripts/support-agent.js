#!/usr/bin/env node
/**
 * Define quem atende os clientes (abre as conversas da seção "Atendimento" e responde).
 * Uso (na pasta do site):
 *   node scripts/support-agent.js <usuario>             torna atendente
 *   node scripts/support-agent.js <usuario> --remover   deixa de ser atendente
 *   node scripts/support-agent.js                       lista os atendentes
 * Reinicie o processo do UVoz depois de alterar.
 */
const path = require('path');
const { loadDotEnv } = require('../lib/env');
loadDotEnv(path.join(__dirname, '..'));
const { createPool, migrate } = require('../lib/db');

(async () => {
  const args = process.argv.slice(2);
  const username = args.find((a) => !a.startsWith('--'));
  const remove = args.includes('--remover');
  const pool = createPool();
  await migrate(pool);

  if (!username) {
    const [rows] = await pool.query('SELECT username, display_name FROM users WHERE is_support = 1 ORDER BY username');
    console.log(rows.length ? rows.map((r) => `${r.username} (${r.display_name})`).join('\n') : 'Nenhum atendente definido.');
    await pool.end();
    return;
  }

  const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]);
  if (!rows.length) { console.error(`Usuário "${username}" não encontrado.`); process.exit(1); }
  await pool.query('UPDATE users SET is_support = ? WHERE id = ?', [remove ? 0 : 1, rows[0].id]);
  console.log(remove
    ? `"${username}" não atende mais o suporte. Reinicie o processo do UVoz.`
    : `"${username}" agora atende o suporte. Reinicie o processo do UVoz.`);
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
