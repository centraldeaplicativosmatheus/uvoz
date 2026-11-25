#!/usr/bin/env node
/**
 * Define quem atende os clientes (seção "Atendimento") e quem atende os leads do site (seção "Leads").
 * Uso (na pasta do site):
 *   node scripts/support-agent.js <usuario>                     atende o suporte
 *   node scripts/support-agent.js <usuario> --leads             atende os leads do site
 *   node scripts/support-agent.js <usuario> [--leads] --remover deixa de atender
 *   node scripts/support-agent.js                               lista quem atende cada fila
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
  const leads = args.includes('--leads');
  const column = leads ? 'is_leads' : 'is_support';
  const queue = leads ? 'os leads do site' : 'o suporte';
  const pool = createPool();
  await migrate(pool);

  if (!username) {
    const [rows] = await pool.query(
      'SELECT username, display_name, is_support, is_leads FROM users WHERE is_support = 1 OR is_leads = 1 ORDER BY username');
    const list = (title, users) => `${title}:\n${users.length
      ? users.map((r) => `  ${r.username} (${r.display_name})`).join('\n') : '  ninguém definido'}`;
    console.log(list('Suporte', rows.filter((r) => r.is_support)));
    console.log(list('Leads do site', rows.filter((r) => r.is_leads)));
    await pool.end();
    return;
  }

  const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]);
  if (!rows.length) { console.error(`Usuário "${username}" não encontrado.`); process.exit(1); }
  await pool.query(`UPDATE users SET ${column} = ? WHERE id = ?`, [remove ? 0 : 1, rows[0].id]);
  console.log(remove
    ? `"${username}" não atende mais ${queue}. Reinicie o processo do UVoz.`
    : `"${username}" agora atende ${queue}. Reinicie o processo do UVoz.`);
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
