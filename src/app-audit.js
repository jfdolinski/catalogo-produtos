// Auditoria das alterações feitas pelo aplicativo de celular.
// Toda requisição de escrita (POST/PUT/DELETE) com token de aparelho que dá certo vira uma linha em app_audit,
// com o usuário, o aparelho, o produto, a ação e a posição que o celular informou nos cabeçalhos:
//   X-Geo-Lat, X-Geo-Lon (graus), X-Geo-Precisao (metros), X-Geo-Momento (ISO 8601, quando a posição foi lida).
import { db } from './db.js';
import { iso } from './business.js';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Ação legível a partir da rota (o caminho completo também fica gravado)
const ACTIONS = [
  ['POST', /^\/products$/, 'cadastro'],
  ['PUT', /^\/products\/\d+$/, 'edicao'],
  ['POST', /^\/products\/\d+\/resolve$/, 'revisado'],
  ['POST', /^\/products\/\d+\/images$/, 'fotos'],
  ['POST', /^\/products\/\d+\/images\/from-url$/, 'foto_url'],
  ['PUT', /^\/products\/\d+\/images\/order$/, 'foto_principal'],
  ['DELETE', /^\/images\/\d+$/, 'foto_apagada'],
  ['DELETE', /^\/me\/device$/, 'desvinculo'],
];
const actionOf = (method, path) => ACTIONS.find(([m, re]) => m === method && re.test(path))?.[2] ?? 'outra';

function number(v, min, max) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function geoFromHeaders(req) {
  const lat = number(req.get('x-geo-lat'), -90, 90);
  const lon = number(req.get('x-geo-lon'), -180, 180);
  if (lat === null || lon === null) return { latitude: null, longitude: null, accuracy_m: null, located_at: null };
  const when = Date.parse(req.get('x-geo-momento') || '');
  return {
    latitude: lat,
    longitude: lon,
    accuracy_m: number(req.get('x-geo-precisao'), 0, 1e6),
    located_at: Number.isFinite(when) ? new Date(when).toISOString().replace('T', ' ').slice(0, 19) : null,
  };
}

/** Middleware do /api/admin, depois da autenticação: registra as escritas do aplicativo que deram certo. */
export function auditAppWrites(req, res, next) {
  if (!req.user?.device_id || !WRITE.has(req.method)) return next();
  const path = req.path;
  const geo = geoFromHeaders(req);
  const fromPath = Number(path.match(/^\/products\/(\d+)/)?.[1]) || null;
  // O produto de uma foto apagada ou de um cadastro novo só aparece na resposta
  let productId = fromPath;
  const json = res.json.bind(res);
  res.json = (body) => {
    if (!productId && body && typeof body === 'object') productId = Number(body.id ?? body.product?.id) || null;
    return json(body);
  };
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    db.run(`INSERT INTO app_audit (user_id, device_id, product_id, action, method, path, status, latitude, longitude, accuracy_m, located_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, req.user.device_id, productId, actionOf(req.method, path), req.method, path.slice(0, 200), res.statusCode,
    geo.latitude, geo.longitude, geo.accuracy_m, geo.located_at).catch((err) => console.error('auditoria do app:', err.message));
  });
  next();
}

/** Consulta (só administrador): GET /api/admin/app-audit?product_id=&user_id=&limit= */
export function mountAppAudit(admin) {
  admin.get('/app-audit', async (req, res) => {
    const where = [];
    const params = [];
    for (const f of ['product_id', 'user_id', 'device_id']) {
      if (req.query[f]) { where.push(`a.${f} = ?`); params.push(Number(req.query[f])); }
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const rows = await db.all(`SELECT a.*, u.name AS user_name, u.login AS user_login, d.name AS device_name
      FROM app_audit a JOIN users u ON u.id = a.user_id LEFT JOIN app_devices d ON d.id = a.device_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`, ...params, limit);
    res.json({ items: rows.map((r) => ({ ...r, created_at: iso(r.created_at), located_at: iso(r.located_at) })) });
  });
}
