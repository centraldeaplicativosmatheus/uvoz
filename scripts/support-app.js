#!/usr/bin/env node
/**
 * Cadastra uma aplicação que pode instalar o widget de suporte e mostra o segredo dela.
 * O segredo fica no servidor da aplicação e assina o token de cada cliente.
 * Uso (na pasta do site):
 *   node scripts/support-app.js <id> "<Nome>"            cria (id: letras minúsculas, números e hífen)
 *   node scripts/support-app.js <id> --novo-segredo      troca o segredo (o anterior para de valer em até 1 minuto)
 *   node scripts/support-app.js                          lista as aplicações
 */
const path = require('path');
const crypto = require('crypto');
const { loadDotEnv } = require('../lib/env');
loadDotEnv(path.join(__dirname, '..'));
const { createPool, migrate } = require('../lib/db');

(async () => {
  const args = process.argv.slice(2);
  const rotate = args.includes('--novo-segredo');
  const [id, name] = args.filter((a) => !a.startsWith('--'));
  const pool = createPool();
  await migrate(pool);

  if (!id) {
    const [rows] = await pool.query('SELECT id, name FROM support_apps ORDER BY id');
    console.log(rows.length ? rows.map((r) => `${r.id} (${r.name})`).join('\n') : 'Nenhuma aplicação cadastrada.');
    await pool.end();
    return;
  }
  if (!/^[a-z0-9-]{1,48}$/.test(id)) {
    console.error('O id deve ter até 48 caracteres: letras minúsculas, números e hífen.');
    process.exit(1);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  const [existing] = await pool.query('SELECT id FROM support_apps WHERE id = ?', [id]);
  if (rotate) {
    if (!existing.length) { console.error(`Aplicação "${id}" não encontrada.`); process.exit(1); }
    await pool.query('UPDATE support_apps SET secret = ? WHERE id = ?', [secret, id]);
    console.log(`Segredo de "${id}" trocado.`);
  } else {
    if (existing.length) { console.error(`A aplicação "${id}" já existe. Use --novo-segredo para trocar o segredo.`); process.exit(1); }
    if (!name) { console.error('Uso: node scripts/support-app.js <id> "<Nome>"'); process.exit(1); }
    await pool.query('INSERT INTO support_apps (id, name, secret, created_at) VALUES (?, ?, ?, ?)', [id, name.slice(0, 80), secret, Date.now()]);
    console.log(`Aplicação "${id}" criada.`);
  }
  console.log(`Segredo (guarde no servidor da aplicação; não aparece de novo):\n${secret}`);
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
