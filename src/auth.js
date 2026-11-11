// Usuários, sessões e permissões do painel.
// O token de administração (config.json) continua valendo como acesso total: serve para o primeiro acesso,
// para criar os usuários e para os scripts de implantação/verificação.
import crypto from 'node:crypto';
import { db, ADMIN_TOKEN } from './db.js';

// Módulos do painel que podem ser liberados por usuário
export const MODULES = {
  dashboard: 'Dashboard',
  produtos: 'Produtos (cadastro, mesclagem, edição em massa)',
  atualizacao: 'Atualização (fila, planilha, busca automática)',
  parametros: 'Parâmetros',
  empresas: 'Empresas',
  dcb: 'DCB (lista de princípios ativos)',
  ncm: 'NCM e regras tributárias',
  cobranca: 'Cobrança (planos e faturas)',
  usuarios: 'Usuários e permissões',
};

const SESSION_DAYS = 30;
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(sha256(token), userId);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return token;
}

export const endSession = (token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));

export function publicUser(u) {
  const perms = u.is_admin ? Object.keys(MODULES) : JSON.parse(u.permissions || '[]').filter((p) => p in MODULES);
  return { id: u.id, name: u.name, login: u.login, is_admin: !!u.is_admin, active: !!u.active, permissions: perms,
    master: !!u.master, created_at: u.created_at, last_login_at: u.last_login_at };
}

const MASTER = { id: 0, name: 'Administrador (token)', login: '', is_admin: 1, active: 1, master: true };

// Token do header -> usuário (ou null)
export function authenticate(token) {
  if (!token) return null;
  if (token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return publicUser(MASTER);
  }
  const row = db.prepare(`SELECT u.*, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(sha256(token));
  if (!row) return null;
  // Atualiza "visto por último" no máximo a cada 5 minutos
  db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token_hash = ? AND last_seen < datetime('now', '-5 minutes')")
    .run(sha256(token));
  return publicUser(row);
}

// Permissões exigidas por rota de /api/admin (a primeira regra que casar vale; null = qualquer usuário logado).
// Sem regra: só administrador.
const RULES = [
  [null, /^\/(check|me)(\/|$)/, null],
  [null, /^\/dashboard$/, ['dashboard']],
  [null, /^\/summary$/, ['produtos', 'dashboard']],
  [null, /^\/(merge|bulk|product-names)$/, ['produtos']],
  ['DELETE', /^\/products\/\d+$/, ['produtos']],
  [null, /^\/(lookup|import|autofill|xml-import)(\/|$)/, ['atualizacao']],
  ['GET', /^\/ai\/status$/, ['atualizacao', 'produtos']],
  [null, /^\/settings$/, ['parametros']],
  ['GET', /^\/(ncm|tax-classes)$/, ['ncm', 'produtos', 'atualizacao']], // o cadastro do produto escolhe NCM e classificação
  [null, /^\/tax\/resolve$/, ['ncm', 'produtos', 'atualizacao']],
  [null, /^\/(ncm|tax-classes)(\/|$)/, ['ncm']],
  ['GET', /^\/dcb$/, ['dcb', 'produtos', 'atualizacao']], // o cadastro do produto escolhe os princípios ativos
  [null, /^\/dcb(\/|$)/, ['dcb']],
  ['GET', /^\/plans$/, ['empresas', 'cobranca']],
  [null, /^\/(companies|cnpj)(\/|$)/, ['empresas']],
  [null, /^\/(plans|invoices|billing)(\/|$)/, ['cobranca']],
  [null, /^\/users(\/|$)/, ['usuarios']],
  [null, /^\/(products|barcodes|images|pending|product-ids)(\/|$)/, ['produtos', 'atualizacao']],
];

export function allowed(user, method, path) {
  if (user.is_admin) return true;
  for (const [m, re, perms] of RULES) {
    if (m && m !== method) continue;
    if (!re.test(path)) continue;
    return !perms || perms.some((p) => user.permissions.includes(p));
  }
  return false;
}

// Bloqueio simples contra tentativa de senha: 8 erros em 15 min por login+IP
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
export function loginBlocked(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= 8;
}
export function loginFailed(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
export const loginOk = (key) => failures.delete(key);
