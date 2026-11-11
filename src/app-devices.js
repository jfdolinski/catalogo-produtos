// Aplicativo de celular (atualização de cadastros pela câmera).
// Vínculo como no Flow: o usuário logado gera no painel um código de uso único (QR code), o app o troca por um token
// de aparelho, que vale como o login daquele usuário (mesmas permissões) até ser desvinculado ou o usuário ser desativado.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { db, DATA_DIR } from './db.js';
import { sha256, publicUser, loginBlocked, loginFailed, loginOk, APP_TOKEN_PREFIX } from './auth.js';
import { HttpError, iso, tx } from './business.js';
import { cleanLine } from './text.js';

// Sem 0/O e 1/I, que se confundem para quem digita o código; 32 símbolos: o sorteio por byte não tem viés
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const CODE_MINUTES = 10;
export { APP_TOKEN_PREFIX };
export const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
export const APK_NAME = 'catalogo-app.apk';

const newCode = () => [...crypto.randomBytes(CODE_LENGTH)].map((b) => ALPHABET[b % 32]).join('');
export const cleanCode = (c) => String(c || '').replace(/[\s-]/g, '').toUpperCase();

// Versão publicada do app (arquivo gravado junto do APK) ou null
export function publishedApp() {
  try {
    if (!fs.existsSync(path.join(DOWNLOADS_DIR, APK_NAME))) return null;
    const version = fs.readFileSync(path.join(DOWNLOADS_DIR, 'app-versao.txt'), 'utf8').trim();
    return { version, url: `/downloads/${APK_NAME}` };
  } catch { return null; }
}

const deviceOut = (d, currentId) => ({
  id: d.id, name: d.name, platform: d.platform, app_version: d.app_version,
  created_at: iso(d.created_at), last_seen: iso(d.last_seen), current: d.id === currentId,
});

export function mountAppDevices(app, admin, baseUrl) {
  // Painel: gera o código (e o QR code) para vincular um celular ao usuário logado
  admin.post('/me/app-link', async (req, res) => {
    if (req.user.master) throw new HttpError(400, 'O acesso por token não vincula celular; entre com um usuário');
    if (req.user.device_id) throw new HttpError(403, 'Gere o código no computador');
    const code = newCode();
    await tx(async () => {
      await db.run("UPDATE app_link_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", req.user.id);
      await db.run(`INSERT INTO app_link_codes (user_id, code_hash, expires_at) VALUES (?, ?, datetime('now', '+${CODE_MINUTES} minutes'))`, req.user.id, sha256(code));
    });
    await db.run("DELETE FROM app_link_codes WHERE expires_at < datetime('now', '-1 day')");
    const server = baseUrl(req);
    const link = `catalogo://vincular?servidor=${encodeURIComponent(server)}&codigo=${code}`;
    res.json({
      code, server, link, minutes: CODE_MINUTES,
      qr_svg: await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
      app: publishedApp(),
    });
  });

  admin.get('/me/devices', async (req, res) => {
    const rows = req.user.master ? [] : await db.all('SELECT * FROM app_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC, id', req.user.id);
    res.json({ items: rows.map((d) => deviceOut(d, req.user.device_id)), app: publishedApp() });
  });

  admin.delete('/me/devices/:id', async (req, res) => {
    const r = await db.run("UPDATE app_devices SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL", Number(req.params.id), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Aparelho não encontrado');
    res.status(204).end();
  });

  // O próprio app ao sair: desvincula o aparelho que fez a chamada
  admin.delete('/me/device', async (req, res) => {
    if (!req.user.device_id) throw new HttpError(400, 'Só o aplicativo se desvincula por aqui');
    await db.run("UPDATE app_devices SET revoked_at = datetime('now') WHERE id = ?", req.user.device_id);
    res.status(204).end();
  });

  // Administração de usuários: ver e desvincular os celulares de qualquer usuário
  admin.get('/users/:id/devices', async (req, res) => {
    const rows = await db.all('SELECT * FROM app_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC, id', Number(req.params.id));
    res.json({ items: rows.map((d) => deviceOut(d)) });
  });
  admin.delete('/users/:id/devices/:device', async (req, res) => {
    const r = await db.run("UPDATE app_devices SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL", Number(req.params.device), Number(req.params.id));
    if (!r.changes) throw new HttpError(404, 'Aparelho não encontrado');
    res.status(204).end();
  });

  // App: troca o código pelo token do aparelho (sem login; o código é a prova)
  app.post('/api/app/link', async (req, res) => {
    const key = `app-link|${req.ip}`;
    if (loginBlocked(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e gere um código novo.');
    const code = cleanCode(req.body?.codigo);
    const name = cleanLine(String(req.body?.nome || '')).slice(0, 80) || 'Celular';
    const platform = ['ANDROID', 'IOS'].includes(req.body?.plataforma) ? req.body.plataforma : 'ANDROID';
    const version = cleanLine(String(req.body?.versao || '')).slice(0, 20) || null;
    const invalid = () => { loginFailed(key); return new HttpError(401, 'Código inválido ou vencido. Gere outro no painel, em Aplicativo do celular.'); };
    if (!/^[A-Z0-9]{10}$/.test(code)) throw invalid();
    const token = APP_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const user = await tx(async () => {
      const u = await db.get(`SELECT u.* FROM app_link_codes c JOIN users u ON u.id = c.user_id
        WHERE c.code_hash = ? AND c.used_at IS NULL AND c.expires_at > datetime('now') AND u.active = 1`, sha256(code));
      if (!u) return null;
      // Uso único mesmo com dois aparelhos lendo o mesmo QR ao mesmo tempo
      const used = await db.run("UPDATE app_link_codes SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL", sha256(code));
      if (!used.changes) return null;
      await db.run('INSERT INTO app_devices (user_id, name, platform, app_version, token_hash) VALUES (?, ?, ?, ?, ?)', u.id, name, platform, version, sha256(token));
      return u;
    });
    if (!user) throw invalid();
    loginOk(key);
    res.status(201).json({ token, user: publicUser(user) });
  });
}
