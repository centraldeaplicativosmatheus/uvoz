#!/usr/bin/env node
/**
 * Gera um token de cliente para testar o widget (vale 1 hora).
 * Em produção, quem gera o token é o servidor da aplicação, com o segredo dela.
 * Uso (na pasta do site): node scripts/support-token.js <app> <id-do-cliente> "<Nome>" [email]
 * Depois abra /widget/demo.html?app=<app>&token=<token>
 */
const path = require('path');
const { loadDotEnv } = require('../lib/env');
loadDotEnv(path.join(__dirname, '..'));
const { createPool } = require('../lib/db');
const { signToken } = require('../lib/support');

(async () => {
  const [appId, sub, name, email] = process.argv.slice(2);
  if (!appId || !sub || !name) {
    console.error('Uso: node scripts/support-token.js <app> <id-do-cliente> "<Nome>" [email]');
    process.exit(1);
  }
  const pool = createPool();
  const [rows] = await pool.query('SELECT secret FROM support_apps WHERE id = ?', [appId]);
  await pool.end();
  if (!rows.length) { console.error(`Aplicação "${appId}" não encontrada. Crie com scripts/support-app.js.`); process.exit(1); }
  const now = Math.floor(Date.now() / 1000);
  console.log(signToken({ sub, name, ...(email ? { email } : {}), iat: now, exp: now + 3600 }, rows[0].secret));
})().catch((err) => { console.error(err); process.exit(1); });
