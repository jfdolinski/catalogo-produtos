import express from 'express';
import 'express-async-errors';
import compression from 'compression';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, IMAGES_DIR, ADMIN_TOKEN, SETTINGS_DEFAULTS, SECRET_SETTINGS, REFORM_FIELDS, getSettings, getSecret, getFlag, reloadSettings, mapSeries } from './db.js';
import { generateProductImage, AI_PROVIDERS } from './ai-image.js';
import { mountDcb, replaceProductDcb, activesOf, searchText } from './dcb.js';
import { mountTax, productTax, checkUf, cleanNcmCode, checkTaxClass, fiscalValue } from './tax.js';
import { mountTaxImport } from './tax-import.js';
import { mountNfceImport } from './nfce-import.js';
import { mountCatalog } from './catalog-cache.js';
import { cleanBody, cleanField, cleanLine } from './text.js';
import { textCleanupSummary } from './text-cleanup.js';
import { mountAppDevices, DOWNLOADS_DIR } from './app-devices.js';
import { auditAppWrites, mountAppAudit } from './app-audit.js';
import { mountSignup } from './signup.js';
import { analyzeBarcode } from './barcode.js';
import { readSpreadsheet, FIELD_LABELS } from './importer.js';
import { providers, lookupOne } from './lookup.js';
import { authenticate, allowed, createSession, endSession, verifyPassword, publicUser, loginBlocked, loginFailed, loginOk } from './auth.js';
import { mountBusiness, companyByKey, countUsage, HttpError, tx, iso } from './business.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined; // ex.: 172.17.0.1 para aceitar só o proxy (Traefik) na VPS
const AUTO_REGISTER = process.env.AUTO_CADASTRO !== '0';
const DEFAULT_IMAGES_DIR = path.join(ROOT, 'assets', 'padrao');
const DEFAULT_IMAGE_OPTIONS = 10;
const AUTO_NAME = 'PRODUTO NÃO CADASTRADO';

const app = express();
app.set('trust proxy', true);
app.use(compression()); // só comprime o que vale a pena: texto e JSON, nunca imagem
app.use(express.json({ limit: '30mb' })); // importação de planilha envia as linhas em JSON

const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Montagem dos dados de produto
// ---------------------------------------------------------------------------

function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
}

// Prazo de atualização: data base + N dias (0 = sem prazo)
function review(since, days) {
  if (!days) return { updated_at: iso(since), due_at: null, overdue: false };
  const due = new Date(since.replace(' ', 'T') + 'Z');
  due.setUTCDate(due.getUTCDate() + days);
  return { updated_at: iso(since), due_at: due.toISOString(), overdue: due < new Date() };
}

// Campos das abas Dados gerais, Tributação e Medicamento (texto; números ficam com ponto decimal)
const EXTRA_FIELDS = ['manufacturer', 'gross_weight', 'net_weight', 'height', 'width', 'depth', 'pack_qty',
  'ncm', 'cest', 'cfop', 'tax_origin', 'cst_icms', 'icms_rate', 'cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', 'tax_notes', ...REFORM_FIELDS,
  'anvisa_registry', 'med_type', 'med_stripe', 'med_controlled', 'med_form', 'med_presentation', 'med_therapeutic_class', 'med_notes'];

// Carrega códigos e imagens de vários produtos de uma vez (em blocos de 500, para a consulta não ficar enorme)
async function hydrate(products, base) {
  const settings = getSettings();
  const barcodes = [];
  const images = [];
  const fieldDates = [];
  const actives = [];
  const pending = new Set();
  const taxClasses = new Map((await db.prepare('SELECT id, code, name FROM tax_classes').all()).map((c) => [c.id, c]));
  for (let i = 0; i < products.length; i += 500) {
    const ids = products.slice(i, i + 500).map((p) => p.id);
    const ph = ids.map(() => '?').join(',');
    barcodes.push(...(await db.prepare(`SELECT * FROM barcodes WHERE product_id IN (${ph}) ORDER BY id`).all(...ids)));
    images.push(...(await db.prepare(`SELECT * FROM images WHERE product_id IN (${ph}) ORDER BY position, id`).all(...ids)));
    fieldDates.push(...(await db.prepare(`SELECT * FROM field_dates WHERE product_id IN (${ph})`).all(...ids)));
    if (ids.length) actives.push(...(await activesOf(ids)));
    (await db.prepare(`SELECT DISTINCT product_id FROM barcode_requests WHERE status = 'pendente' AND product_id IN (${ph})`)
      .all(...ids)).forEach((r) => pending.add(r.product_id));
  }
  const bcBy = groupBy(barcodes, 'product_id');
  const imgBy = groupBy(images, 'product_id');
  const fdBy = groupBy(fieldDates, 'product_id');
  const activesBy = groupBy(actives, 'product_id');

  return products.map((p) => {
    const field_dates = {};
    for (const fd of fdBy.get(p.id) || []) field_dates[fd.field] = { created_at: iso(fd.created_at), updated_at: iso(fd.updated_at) };
    const bcs = (bcBy.get(p.id) || []).map((b) => ({
      id: b.id,
      code: b.code,
      type: b.type,
      note: b.note,
      created_at: iso(b.created_at),
      updated_at: iso(b.updated_at),
      links: {
        product: `${base}/api/v1/barcodes/${encodeURIComponent(b.code)}`,
        main_image: `${base}/img/${encodeURIComponent(b.code)}`,
      },
    }));
    const imgs = (imgBy.get(p.id) || []).map((im, idx) => ({
      id: im.id,
      position: idx + 1,
      url: `${base}/files/${im.filename}`,
      mime: im.mime,
      size: im.size,
      original_name: im.original_name,
      placeholder: !!im.is_placeholder,
      ai_generated: !!im.is_ai,
      created_at: iso(im.created_at),
    }));
    // Sem imagem própria, vale a imagem padrão: um arquivo só, sem linha no banco, para qualquer produto
    if (!imgs.length) {
      imgs.push({
        id: null, position: 1, url: `${base}/padrao/${settings.imagem_padrao}.png`, mime: 'image/png', size: 0,
        original_name: 'imagem-padrao.png', placeholder: true, ai_generated: false, created_at: null,
      });
    }
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      brand: p.brand,
      category: p.category,
      unit: p.unit,
      ...Object.fromEntries(EXTRA_FIELDS.map((f) => [f, p[f]])),
      tax_class_id: p.tax_class_id ?? null,
      tax_class: taxClasses.get(p.tax_class_id) ?? null,
      is_medicine: !!p.is_medicine,
      actives: (activesBy.get(p.id) || []).map(({ product_id, ...a }) => a),
      active: !!p.active,
      pending: pending.has(p.id),
      barcodes: bcs,
      images: imgs,
      main_image: imgs[0]?.url ?? null,
      links: {
        api: `${base}/api/v1/products/${p.id}`,
        page: `${base}/p/${p.id}`,
      },
      created_at: iso(p.created_at),
      updated_at: iso(p.updated_at),
      field_dates,
      review: {
        data: review(p.data_updated_at || p.created_at, settings.prazo_cadastro_dias),
        images: review(p.images_updated_at || p.created_at, settings.prazo_imagens_dias),
      },
    };
  });
}

// Condições SQL de prazo vencido (dados ou imagens), conforme os parâmetros
// Momento em UTC (texto como nas colunas) da meia-noite local de hoje deslocada em N dias, calculado uma vez por consulta
const localMidnight = (days = 0) => `(SELECT datetime('now', 'localtime', 'start of day', '${days >= 0 ? '+' : ''}${days} days', 'utc'))`;

function overdueSql(group) {
  const s = getSettings();
  const parts = [];
  if (s.prazo_cadastro_dias && group !== 'images') parts.push(`COALESCE(p.data_updated_at, p.created_at) < (SELECT datetime('now', '-${Number(s.prazo_cadastro_dias)} days'))`);
  if (s.prazo_imagens_dias && group !== 'data') parts.push(`COALESCE(p.images_updated_at, p.created_at) < (SELECT datetime('now', '-${Number(s.prazo_imagens_dias)} days'))`);
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

// Prazo (dados ou imagens) que vence entre hoje e hoje + days-1, em data local
// O prazo vence entre hoje e hoje + days-1 (data local) quando a última revisão caiu entre
// a meia-noite local de (hoje - prazo) e a de (hoje + days - prazo)
function dueWithinSql(days) {
  const s = getSettings();
  const range = (col, n) => `(COALESCE(${col}, p.created_at) >= ${localMidnight(-Number(n))} AND COALESCE(${col}, p.created_at) < ${localMidnight(days - Number(n))})`;
  const parts = [];
  if (s.prazo_cadastro_dias) parts.push(range('p.data_updated_at', s.prazo_cadastro_dias));
  if (s.prazo_imagens_dias) parts.push(range('p.images_updated_at', s.prazo_imagens_dias));
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

const TODAY = "(SELECT date('now', 'localtime'))";
const PENDING_SQL = "EXISTS (SELECT 1 FROM barcode_requests r WHERE r.product_id = p.id AND r.status = 'pendente')";
// Foto real = nem imagem padrão nem ilustração gerada por IA
const NO_REAL_IMAGE_SQL = 'NOT EXISTS (SELECT 1 FROM images i WHERE i.product_id = p.id AND i.is_placeholder = 0 AND i.is_ai = 0)';

// Filtros da lista do painel (?nome=1); também usados pelos cards do dashboard
const LIST_FILTERS = {
  pending: () => PENDING_SQL,
  overdue: () => overdueSql(),
  due_today: () => dueWithinSql(1),
  due_week: () => dueWithinSql(7),
  created_today: () => `p.created_at >= ${localMidnight(0)}`,
  updated_today: () => `p.updated_at >= ${localMidnight(0)} AND p.created_at < ${localMidnight(0)}`,
  no_image: () => NO_REAL_IMAGE_SQL,
  inactive: () => 'p.active = 0',
  no_ncm: () => "p.ncm = ''",
  provisional: () => `p.name LIKE '${AUTO_NAME}%'`,
  ncm_unregistered: () => "p.ncm <> '' AND NOT EXISTS (SELECT 1 FROM ncm n WHERE n.code = p.ncm)",
};

async function getProduct(id, base, { onlyActive = false } = {}) {
  const row = await db.prepare(`SELECT * FROM products WHERE id = ? ${onlyActive ? 'AND active = 1' : ''}`).get(Number(id));
  return row ? (await hydrate([row], base))[0] : null;
}

// WHERE da busca de produtos (texto, categoria e filtros ?nome=1), compartilhado por lista, ids e edição em massa
// Filtro por valor exato de marca, fabricante ou categoria; EMPTY_VALUE = sem valor preenchido
const EMPTY_VALUE = '__vazio__';
const VALUE_FILTERS = ['brand', 'manufacturer', 'category'];

function buildWhere({ q, onlyActive, ...flags }) {
  const where = [];
  const params = [];
  if (onlyActive) where.push('p.active = 1');
  for (const [name, sql] of Object.entries(LIST_FILTERS)) {
    const v = flags[name];
    if (v === '1' || v === 'true' || v === true || v === 1) where.push(sql());
  }
  for (const f of VALUE_FILTERS) {
    const v = typeof flags[f] === 'string' ? flags[f] : '';
    if (v === EMPTY_VALUE) where.push(`p.${f} = ''`);
    else if (v) { where.push(`p.${f} = ?`); params.push(v); }
  }
  if (q) {
    const like = `%${q}%`;
    where.push(`(p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ? OR p.brand LIKE ? OR p.manufacturer LIKE ? OR p.category LIKE ? OR p.ncm LIKE ?
      OR EXISTS (SELECT 1 FROM barcodes b WHERE b.product_id = p.id AND b.code LIKE ?)
      OR EXISTS (SELECT 1 FROM product_dcb pd JOIN dcb d ON d.id = pd.dcb_id WHERE pd.product_id = p.id AND d.search LIKE ?))`);
    params.push(like, like, like, like, like, like, like, like, `%${searchText(q)}%`);
  }
  return { sqlWhere: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// Ids de todos os produtos de um filtro. order=requests: mais consultados primeiro (fila de atualização)
async function productIds(query, order) {
  const { sqlWhere, params } = buildWhere(query);
  const orderBy = order === 'requests'
    ? `(SELECT COALESCE(MAX(r.request_count), 0) FROM barcode_requests r WHERE r.product_id = p.id AND r.status = 'pendente') DESC, p.id`
    : 'p.name COLLATE NOCASE, p.id';
  return (await db.prepare(`SELECT p.id FROM products p ${sqlWhere} ORDER BY ${orderBy}`).all(...params)).map((r) => r.id);
}

async function searchProducts({ page = 1, limit = 50, ...query }) {
  const { sqlWhere, params } = buildWhere(query);
  limit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  page = Math.max(Number(page) || 1, 1);
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM products p ${sqlWhere}`).get(...params)).n;
  const rows = await db
    .prepare(`SELECT p.* FROM products p ${sqlWhere} ORDER BY p.name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);
  return { total, page, limit, rows };
}

// ---------------------------------------------------------------------------
// Validação / gravação
// ---------------------------------------------------------------------------

const PRODUCT_FIELDS = ['sku', 'name', 'description', 'brand', 'category', 'unit', ...EXTRA_FIELDS];
const NUMBER_FIELDS = { gross_weight: 'Peso bruto', net_weight: 'Peso líquido', height: 'Altura', width: 'Largura', depth: 'Profundidade', pack_qty: 'Quantidade na embalagem' };
const RATE_FIELDS = { icms_rate: 'Alíquota de ICMS', ipi_rate: 'Alíquota de IPI', pis_rate: 'Alíquota de PIS', cofins_rate: 'Alíquota de COFINS' };
const DIGIT_FIELDS = { ncm: ['NCM', 8], cest: ['CEST', 7], cfop: ['CFOP', 4] };

// Números aceitam vírgula; NCM, CEST e CFOP aceitam pontos; cada erro diz o campo, porque ele pode estar em outra aba
function checkExtraFields(out) {
  const num = (f, label, max) => {
    if (!out[f]) return;
    const v = out[f].replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(v) || Number(v) > max) throw new HttpError(400, `${label}: valor inválido (${out[f]})`);
    out[f] = v;
  };
  for (const [f, label] of Object.entries(NUMBER_FIELDS)) num(f, label, 1e7);
  for (const [f, label] of Object.entries(RATE_FIELDS)) num(f, label, 100);
  for (const [f, [label, len]] of Object.entries(DIGIT_FIELDS)) {
    if (!out[f]) continue;
    out[f] = out[f].replace(/\D/g, '');
    if (out[f].length !== len) throw new HttpError(400, `${label}: informe ${len} dígitos`);
  }
  for (const f of REFORM_FIELDS) if (out[f]) out[f] = fiscalValue(f, out[f]);
  if (out.tax_origin && !/^[0-8]$/.test(out.tax_origin)) throw new HttpError(400, 'Origem da mercadoria: use um código de 0 a 8');
  if (out.anvisa_registry) {
    out.anvisa_registry = out.anvisa_registry.replace(/\D/g, '');
    if (out.anvisa_registry.length < 9 || out.anvisa_registry.length > 13) throw new HttpError(400, 'Registro no Ministério da Saúde: informe de 9 a 13 dígitos');
  }
}

async function cleanProduct(body, partial) {
  const out = {};
  for (const f of PRODUCT_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f] === null ? '' : String(body[f]).trim();
  }
  if ('sku' in out && out.sku === '') out.sku = null;
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  if (body.is_medicine !== undefined) out.is_medicine = body.is_medicine ? 1 : 0;
  if (body.tax_class_id !== undefined) out.tax_class_id = await checkTaxClass(body.tax_class_id);
  checkExtraFields(out);
  if (!partial && !out.name) throw new HttpError(400, 'O nome do produto é obrigatório');
  if (partial && 'name' in out && !out.name) throw new HttpError(400, 'O nome do produto é obrigatório');
  return out;
}

async function checkBarcode(input, productId) {
  const r = analyzeBarcode(input.code, input.type);
  if (r.error) throw new HttpError(400, r.error);
  const owner = await db.prepare('SELECT b.product_id, p.name FROM barcodes b JOIN products p ON p.id = b.product_id WHERE b.code = ?').get(r.code);
  if (owner && owner.product_id !== productId) {
    throw new HttpError(409, `O código ${r.code} já pertence ao produto #${owner.product_id} (${owner.name})`);
  }
  return { ...r, note: String(input.note ?? '').trim() };
}

async function checkSku(sku, productId) {
  if (!sku) return;
  const other = await db.prepare('SELECT id FROM products WHERE sku = ? AND id <> ?').get(sku, productId ?? -1);
  if (other) throw new HttpError(409, `O SKU ${sku} já está em uso pelo produto #${other.id}`);
}

async function replaceBarcodes(productId, list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'barcodes deve ser uma lista');
  const checked = await mapSeries(list, (b) => checkBarcode(typeof b === 'string' ? { code: b } : b, productId));
  const codes = checked.map((b) => b.code);
  const dup = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dup) throw new HttpError(400, `Código ${dup} repetido na lista`);
  // Mantém os códigos que continuam (preserva as datas), altera só o que mudou
  const existing = new Map((await db.prepare('SELECT * FROM barcodes WHERE product_id = ?').all(productId)).map((b) => [b.code, b]));
  for (const [code, b] of existing) {
    if (!codes.includes(code)) await db.prepare('DELETE FROM barcodes WHERE id = ?').run(b.id);
  }
  for (const b of checked) {
    const old = existing.get(b.code);
    if (!old) await insertBarcode(productId, b);
    else if (old.type !== b.type || old.note !== b.note) {
      await db.prepare("UPDATE barcodes SET type = ?, note = ?, updated_at = datetime('now') WHERE id = ?").run(b.type, b.note, old.id);
    }
  }
}

async function insertBarcode(productId, b) {
  await db.prepare(`INSERT INTO barcodes (product_id, code, type, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`).run(productId, b.code, b.type, b.note);
}

// Registra data de cadastro/alteração de cada informação que mudou
async function trackFields(productId, before, data) {
  const upsert = db.prepare(`INSERT INTO field_dates (product_id, field) VALUES (?, ?)
    ON CONFLICT(product_id, field) DO UPDATE SET updated_at = datetime('now')`);
  for (const [field, value] of Object.entries(data)) {
    const changed = before ? String(before[field] ?? '') !== String(value ?? '') : value !== '' && value !== null;
    if (changed) await upsert.run(productId, field);
  }
}

// updated_at marca qualquer alteração do registro; 'data' ou 'images' também marcam a atualização daquele grupo
const touch = async (id, group) => await db.prepare(
  `UPDATE products SET updated_at = datetime('now')${group ? `, ${group}_updated_at = datetime('now')` : ''} WHERE id = ?`
).run(id);

async function requireProduct(id) {
  const row = await db.prepare('SELECT id FROM products WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'Produto não encontrado');
  return row.id;
}

function removeImageFile(filename) {
  fs.rm(path.join(IMAGES_DIR, filename), { force: true }, () => {});
}

// ---------------------------------------------------------------------------
// Cadastro automático de códigos consultados e não encontrados
// ---------------------------------------------------------------------------

// Identifica quem consultou: empresa da chave, ?origem=, header X-Origem, host do Referer ou IP
function requestSource(req) {
  if (req.company) return (req.company.nome_fantasia || req.company.razao_social).slice(0, 200);
  let src = req.query.origem || req.get('x-origem');
  if (!src && req.get('referer')) {
    try { src = new URL(req.get('referer')).host; } catch { /* referer inválido */ }
  }
  return cleanLine(src || req.ip).slice(0, 200);
}

async function noteRequest(code, source) {
  await db.prepare(`UPDATE barcode_requests
    SET request_count = request_count + 1, last_requested_at = datetime('now'),
        last_source = CASE WHEN ? <> '' THEN ? ELSE last_source END
    WHERE code = ? AND status = 'pendente'`).run(source, source, code);
}

// Cria produto provisório com o código e a imagem padrão, e coloca o código na lista de pendentes.
// Só aceita GTIN válido (EAN-8, UPC-A, EAN-13, DUN-14) para não cadastrar lixo.
async function autoRegister(rawCode, source, knownName = '') {
  const r = analyzeBarcode(rawCode);
  if (r.error || r.type === 'OUTRO') return null;
  return await tx(async () => {
    const name = cleanLine(knownName) || `${AUTO_NAME} ${r.code}`;
    const pid = Number((await db.prepare('INSERT INTO products (name) VALUES (?)').run(name)).lastInsertRowid);
    await trackFields(pid, null, { name, active: 1 });
    await insertBarcode(pid, { ...r, note: 'cadastro automático' });
    await db.prepare(`INSERT INTO barcode_requests (code, product_id, last_source) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET product_id = excluded.product_id, status = 'pendente', request_count = barcode_requests.request_count + 1,
        last_requested_at = datetime('now'), last_source = excluded.last_source, resolved_at = NULL`).run(r.code, pid, source);
    return pid;
  });
}

// Código exato ou o mesmo GTIN com outra quantidade de zeros à esquerda (o ERP costuma completar com zeros):
// 07896004801216 é o produto 7896004801216, não um cadastro novo. Código interno curto só vale exato.
async function findBarcode(code) {
  const q = db.prepare('SELECT b.code, b.product_id, p.active FROM barcodes b JOIN products p ON p.id = b.product_id WHERE b.code = ?');
  const exact = await q.get(code);
  const base = code.replace(/^0+/, '');
  if (exact || !/^\d+$/.test(code) || base.length < 7) return exact;
  for (const c of [base, ...[8, 12, 13, 14].map((n) => base.padStart(n, '0'))]) {
    const r = await q.get(c);
    if (r) return r;
  }
  return undefined;
}

// Localiza o produto de um código; se não existir, cadastra automaticamente.
// Retorna null se o código pertence a produto inativo ou não pôde ser cadastrado.
async function resolveBarcode(req) {
  const code = req.params.code.trim();
  const source = requestSource(req);
  const bc = await findBarcode(code);
  if (bc) {
    if (!bc.active) { await countLookup(source, 'not_found'); return null; }
    await noteRequest(bc.code, source);
    await countLookup(source);
    return bc.product_id;
  }
  const created = AUTO_REGISTER ? await autoRegister(code, source) : null;
  await countLookup(source, created ? 'created' : 'not_found');
  return created;
}

// Estatística de consultas por origem/dia (alimenta "conexão mais utilizada" no dashboard)
async function countLookup(source, outcome) {
  const extra = outcome === 'created' ? ', created = lookup_stats.created + 1' : outcome === 'not_found' ? ', not_found = lookup_stats.not_found + 1' : '';
  await db.prepare(`INSERT INTO lookup_stats (source, day, hits, created, not_found)
    VALUES (?, date('now', 'localtime'), 1, ?, ?)
    ON CONFLICT(source, day) DO UPDATE SET hits = lookup_stats.hits + 1, last_at = datetime('now')${extra}`)
    .run(source || 'desconhecida', outcome === 'created' ? 1 : 0, outcome === 'not_found' ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + MIME_EXT[file.mimetype]),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 30 },
  fileFilter: (_req, file, cb) =>
    MIME_EXT[file.mimetype] ? cb(null, true) : cb(new HttpError(400, `Formato não suportado: ${file.originalname}`)),
});

// ---------------------------------------------------------------------------
// Rotas públicas (catálogo para outros sistemas)
// ---------------------------------------------------------------------------

const pub = express.Router();
pub.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'X-Api-Key, X-Chave, X-Origem, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Chave de acesso da empresa (?chave=, header X-Api-Key ou X-Chave): identifica o cliente e conta o consumo para cobrança.
// Sem chave a API continua aberta, a não ser que o parâmetro "exigir chave" esteja ligado.
pub.use(['/api/v1', '/img'], async (req, _res, next) => {
  const key = String(req.query.chave || req.get('x-api-key') || req.get('x-chave') || '').trim();
  if (key) {
    const company = await companyByKey(key);
    if (!company) throw new HttpError(401, 'Chave de acesso inválida');
    if (company.status !== 'ativa') throw new HttpError(403, 'Acesso desta empresa está suspenso. Entre em contato com o fornecedor do catálogo.');
    req.company = company;
    await countUsage(company.id);
  } else if (getSettings().exigir_chave) {
    throw new HttpError(401, 'Informe a chave de acesso da empresa (?chave=... ou header X-Api-Key)');
  }
  next();
});

pub.get('/api/v1/products', async (req, res) => {
  const base = baseUrl(req);
  const r = await searchProducts({ ...req.query, onlyActive: true });
  res.json({ total: r.total, page: r.page, limit: r.limit, items: await hydrate(r.rows, base) });
});

// Produto removido por mesclagem -> id do produto que o absorveu (segue mesclagens encadeadas)
async function mergedInto(id) {
  let current = Number(id);
  for (let i = 0; i < 20; i++) {
    const m = await db.prepare('SELECT target_id FROM merges WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(current);
    if (!m) break;
    current = m.target_id;
  }
  return current !== Number(id) && (await db.prepare('SELECT 1 FROM products WHERE id = ?').get(current)) ? current : null;
}

pub.get('/api/v1/products/:id', async (req, res) => {
  const p = await getProduct(req.params.id, baseUrl(req), { onlyActive: true });
  if (!p) {
    const target = await mergedInto(req.params.id);
    if (target) return res.redirect(301, `/api/v1/products/${target}`);
    throw new HttpError(404, 'Produto não encontrado');
  }
  res.json(p);
});

pub.get('/api/v1/barcodes/:code', async (req, res) => {
  const productId = await resolveBarcode(req);
  if (!productId) throw new HttpError(404, 'Código de barras não encontrado');
  res.json(await getProduct(productId, baseUrl(req)));
});

// Tributação que vale para o produto: ?uf=SP (sem uf, só as regras gerais). Não cadastra código desconhecido.
pub.get('/api/v1/products/:id/tax', async (req, res) => {
  const p = await db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  res.json({ product_id: p.id, ...(await productTax(p, checkUf(req.query.uf))) });
});

pub.get('/api/v1/barcodes/:code/tax', async (req, res) => {
  const p = await db.prepare('SELECT p.* FROM products p JOIN barcodes b ON b.product_id = p.id WHERE b.code = ? AND p.active = 1').get(req.params.code.trim());
  if (!p) throw new HttpError(404, 'Código de barras não encontrado');
  res.json({ product_id: p.id, ...(await productTax(p, checkUf(req.query.uf))) });
});

pub.get('/api/v1/categories', async (_req, res) => {
  res.json(await db.prepare("SELECT category, COUNT(*) AS products FROM products WHERE active = 1 AND category <> '' GROUP BY category ORDER BY category").all());
});

mountCatalog(pub, { hydrate, baseUrl });

// Link direto de imagem pelo código de barras: /img/7891234567895 (principal) ou /img/7891234567895/2
pub.get(['/img/:code', '/img/:code/:n'], async (req, res) => {
  const n = Math.max(Number(req.params.n) || 1, 1);
  const productId = await resolveBarcode(req);
  const im = productId && (await db.prepare('SELECT filename FROM images WHERE product_id = ? ORDER BY position, id LIMIT 1 OFFSET ?')
    .get(productId, n - 1));
  res.set('Cache-Control', 'public, max-age=300');
  if (im) return res.redirect(302, `/files/${im.filename}`);
  const hasImages = productId && (await db.prepare('SELECT 1 FROM images WHERE product_id = ?').get(productId));
  if (!productId || hasImages || n > 1) throw new HttpError(404, 'Imagem não encontrada');
  res.redirect(302, `/padrao/${getSettings().imagem_padrao}.png`);
});

// Opções da imagem padrão
pub.get('/padrao/:n(\\d+).png', (req, res) => {
  const n = Number(req.params.n);
  if (n < 1 || n > DEFAULT_IMAGE_OPTIONS) throw new HttpError(404, 'Imagem não encontrada');
  res.sendFile(path.join(DEFAULT_IMAGES_DIR, `${String(n).padStart(2, '0')}.png`), { maxAge: '1d' });
});

// Arquivos de imagem (nome único e imutável -> cache longo)
pub.use('/files', express.static(IMAGES_DIR, { immutable: true, maxAge: '365d', index: false }));

// Página pública do produto
const html = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

pub.get('/p/:id', async (req, res) => {
  const p = await getProduct(req.params.id, baseUrl(req), { onlyActive: true });
  if (!p) {
    const target = await mergedInto(req.params.id);
    if (target) return res.redirect(301, `/p/${target}`);
    return res.status(404).send('Produto não encontrado');
  }
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(p.name)}</title>
<link rel="stylesheet" href="/admin/style.css"></head>
<body class="public"><main class="product-page">
  <div class="gallery">
    ${p.images.length ? `<img id="main" src="${p.images[0].url}" alt="${html(p.name)}">` : '<div class="no-image">Sem imagem</div>'}
    <div class="thumbs">${p.images.map((i) => `<img src="${i.url}" alt="" onclick="document.getElementById('main').src=this.src">`).join('')}</div>
    ${p.images.some((i) => i.ai_generated) ? `<p class="muted small">${p.images.every((i) => i.ai_generated || i.placeholder) ? 'Imagem ilustrativa gerada por IA; a embalagem real pode ser diferente.' : 'Há imagens ilustrativas geradas por IA.'}</p>` : ''}
  </div>
  <div class="info">
    <h1>${html(p.name)}</h1>
    <dl>
      ${p.sku ? `<dt>SKU</dt><dd>${html(p.sku)}</dd>` : ''}
      ${p.brand ? `<dt>Marca</dt><dd>${html(p.brand)}</dd>` : ''}
      ${p.category ? `<dt>Categoria</dt><dd>${html(p.category)}</dd>` : ''}
      ${p.unit ? `<dt>Unidade</dt><dd>${html(p.unit)}</dd>` : ''}
      ${p.manufacturer ? `<dt>Fabricante</dt><dd>${html(p.manufacturer)}</dd>` : ''}
      ${p.is_medicine && p.actives.length ? `<dt>Princípios ativos</dt><dd>${p.actives.map((a) => html(a.name + (a.concentration ? ` ${a.concentration}` : ''))).join('<br>')}</dd>` : ''}
      ${p.is_medicine && p.med_presentation ? `<dt>Apresentação</dt><dd>${html(p.med_presentation)}</dd>` : ''}
      ${p.is_medicine && p.anvisa_registry ? `<dt>Registro MS</dt><dd>${html(p.anvisa_registry)}</dd>` : ''}
      ${p.is_medicine && p.med_stripe ? `<dt>Tarja</dt><dd>${html(p.med_stripe)}</dd>` : ''}
      <dt>Códigos de barras</dt><dd>${p.barcodes.map((b) => `<a href="https://www.google.com/search?tbm=isch&amp;q=${encodeURIComponent(b.code)}" target="_blank" rel="noopener" title="Pesquisar no Google Imagens"><code>${html(b.code)}</code></a> <small>${html(b.type)}${b.note ? ' · ' + html(b.note) : ''}</small>`).join('<br>') || '—'}</dd>
    </dl>
    <p class="desc">${html(p.description).replace(/\n/g, '<br>')}</p>
    <p><a href="${p.links.api}">Ver JSON</a></p>
  </div>
</main></body></html>`);
});

app.use(pub);

// ---------------------------------------------------------------------------
// Consulta pública (tela /consulta): sem login, não conta consumo e não cadastra códigos desconhecidos
// ---------------------------------------------------------------------------

const consultaHits = new Map(); // limite por IP: 120 consultas por minuto
setInterval(() => consultaHits.clear(), 60000).unref();

app.get('/api/consulta', async (req, res) => {
  const n = (consultaHits.get(req.ip) || 0) + 1;
  consultaHits.set(req.ip, n);
  if (n > 120) throw new HttpError(429, 'Muitas consultas seguidas; aguarde um minuto');
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) throw new HttpError(400, 'Digite ao menos 2 caracteres');
  const base = baseUrl(req);
  let rows;
  if (/^\d{8,14}$/.test(q)) {
    rows = await db.prepare('SELECT p.* FROM products p JOIN barcodes b ON b.product_id = p.id WHERE b.code = ? AND p.active = 1').all(q);
  }
  let total = rows?.length || 0;
  if (!total) {
    const r = await searchProducts({ q, onlyActive: true, limit: 30 });
    rows = r.rows;
    total = r.total;
  }
  const items = (await hydrate(rows, base)).map((p) => ({
    id: p.id, name: p.name, brand: p.brand, category: p.category, unit: p.unit, description: p.description,
    barcodes: p.barcodes.map((b) => b.code), images: p.images.map((i) => i.url),
    main_image_ai: !!p.images.find((i) => !i.placeholder)?.ai_generated,
    actives: p.is_medicine ? p.actives.map((a) => a.name + (a.concentration ? ` ${a.concentration}` : '')) : [],
    pending: p.pending, page: p.links.page,
  }));
  res.set('Cache-Control', 'no-store');
  res.json({ q, total, items });
});

app.use('/consulta', express.static(path.join(ROOT, 'public', 'consulta')));
// APK do aplicativo e a versão publicada (gravados em DATA_DIR/downloads ao publicar o app)
app.use('/downloads', express.static(DOWNLOADS_DIR, { maxAge: 0 }));

// ---------------------------------------------------------------------------
// Login do painel
// ---------------------------------------------------------------------------

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() || req.get('x-api-key') || '';

app.post('/api/auth/login', async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = `${login}|${req.ip}`;
  if (loginBlocked(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
  const u = login && (await db.prepare('SELECT * FROM users WHERE login = ?').get(login));
  if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
    loginFailed(key);
    // Senha certa, cadastro pelo site ainda não aprovado: diz o motivo (só para quem sabe a senha)
    if (u && !u.active && u.signup_at && !u.last_login_at && verifyPassword(password, u.password_hash)) {
      throw new HttpError(403, 'Seu cadastro está aguardando a aprovação do administrador.');
    }
    throw new HttpError(401, 'Login ou senha incorretos');
  }
  loginOk(key);
  res.json({ token: await createSession(u.id), user: publicUser(u) });
});

mountSignup(app);

app.post('/api/auth/logout', async (req, res) => {
  const t = bearer(req);
  if (t && t !== ADMIN_TOKEN) await endSession(t);
  res.status(204).end();
});

// Tela de login: informa se ainda não há usuários (primeiro acesso é pelo token)
app.get('/api/auth/status', async (_req, res) => {
  res.json({ has_users: !!(await db.prepare('SELECT 1 FROM users LIMIT 1').get()) });
});

// ---------------------------------------------------------------------------
// Rotas administrativas (exigem login; cada módulo exige a permissão correspondente)
// ---------------------------------------------------------------------------

const admin = express.Router();
admin.use(async (req, _res, next) => {
  const user = await authenticate(bearer(req));
  if (!user) return next(new HttpError(401, 'Sessão expirada ou token inválido'));
  req.user = user;
  if (!allowed(user, req.method, req.path)) return next(new HttpError(403, 'Seu usuário não tem permissão para este módulo'));
  // Tudo que é digitado ou enviado ao painel passa pelo tratamento de espaços. O que entra por outro caminho
  // (planilha, busca externa, nota fiscal, cadastro automático) é tratado em readGrid, applyFields e autoRegister.
  if (req.body && typeof req.body === 'object') req.body = cleanBody(req.body);
  next();
});
// Alterações feitas pelo aplicativo: usuário, aparelho e posição para auditoria (app-audit.js)
admin.use(auditAppWrites);

admin.get('/check', (req, res) => res.json({ ok: true, user: req.user }));
admin.get('/text-cleanup', async (_req, res) => res.json(await textCleanupSummary())); // sem regra de permissão: só administrador
mountBusiness(admin);
mountTax(admin);
mountAppDevices(app, admin, baseUrl);
mountAppAudit(admin);

admin.get('/products', async (req, res) => {
  const r = await searchProducts(req.query);
  res.json({ total: r.total, page: r.page, limit: r.limit, items: await hydrate(r.rows, baseUrl(req)) });
});

// Valores já cadastrados de marca, categoria e unidade (sugestões nos campos do painel e do aplicativo), mais usados primeiro.
// ?q= filtra por trecho (sem diferenciar maiúsculas); sem q, devolve os mais usados.
const VALUE_FIELDS = { brand: 'brand', manufacturer: 'manufacturer', category: 'category', unit: 'unit' };
admin.get('/field-values/:field', async (req, res) => {
  const col = VALUE_FIELDS[req.params.field];
  if (!col) throw new HttpError(400, 'Campo sem sugestões: use brand, manufacturer, category ou unit');
  const q = cleanLine(req.query.q || '');
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 1000);
  const rows = await db.prepare(`SELECT ${col} AS value, COUNT(*) AS products FROM products
    WHERE ${col} <> ''${q ? ` AND ${col} LIKE ?` : ''} GROUP BY ${col}
    ORDER BY ${q ? `(lower(${col}) LIKE ?) DESC, ` : ''}COUNT(*) DESC, ${col} LIMIT ?`)
    .all(...(q ? [`%${q}%`, `${q.toLowerCase()}%`] : []), limit);
  if (req.query.empty === '1') {
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM products WHERE ${col} = ''`).get()).n;
    return res.json({ items: rows, empty: n });
  }
  res.json(rows);
});

// Renomeia (ou junta) um valor de marca, fabricante ou categoria em todos os produtos que o usam.
// "to" vazio tira o valor dos produtos. Cada produto passa pela gravação normal (datas por campo), sem renovar prazo.
admin.post('/field-values/:field/rename', async (req, res) => {
  const col = { brand: 'brand', manufacturer: 'manufacturer', category: 'category' }[req.params.field];
  if (!col) throw new HttpError(400, 'Só marca, fabricante e categoria podem ser renomeados');
  const from = cleanLine(String(req.body.from ?? ''));
  const to = cleanLine(String(req.body.to ?? ''));
  if (!from) throw new HttpError(400, 'Informe o valor atual');
  if (to.length > 120) throw new HttpError(400, 'Valor novo com mais de 120 caracteres');
  if (from === to) throw new HttpError(400, 'O valor novo é igual ao atual');
  const ids = (await db.prepare(`SELECT id FROM products WHERE ${col} = ? ORDER BY id`).all(from)).map((r) => r.id);
  if (!ids.length) throw new HttpError(404, 'Nenhum produto com esse valor (pode ter sido alterado por outra pessoa)');
  const merged = to ? (await db.prepare(`SELECT COUNT(*) AS n FROM products WHERE ${col} = ?`).get(to)).n : 0;
  await tx(async () => { for (const id of ids) await applyFields(id, { [col]: to }, { renew: false }); });
  res.json({ products: ids.length, merged_into_existing: merged > 0, existing: merged });
});

// Aplicativo: produto pelo código de barras lido na câmera ou digitado. Não conta como consulta nem cadastra.
// O leitor pode entregar o UPC-A com 12 dígitos para um código guardado como EAN-13 (com zero à esquerda), e vice-versa.
admin.get('/code/:code', async (req, res) => {
  const code = cleanLine(req.params.code);
  if (!/^\d{6,14}$/.test(code)) throw new HttpError(400, 'Informe um código de barras numérico');
  const variants = [...new Set([code, code.padStart(13, '0'), code.padStart(14, '0'), code.replace(/^0+(?=\d{8})/, '')])];
  const hit = await db.prepare(`SELECT product_id FROM barcodes WHERE code IN (${variants.map(() => '?').join(',')})
    ORDER BY code = ? DESC, product_id LIMIT 1`).get(...variants, code);
  if (!hit) return res.json({ found: false, code });
  const p = await getProduct(hit.product_id, baseUrl(req));
  p.pending = (await db.prepare("SELECT COUNT(*) AS n FROM barcode_requests WHERE product_id = ? AND status = 'pendente'").get(p.id)).n > 0;
  res.json({ found: true, code, product: p });
});

admin.get('/products/:id', async (req, res) => {
  const p = await getProduct(req.params.id, baseUrl(req));
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  p.requests = await db.prepare('SELECT * FROM barcode_requests WHERE product_id = ? ORDER BY first_requested_at, code').all(p.id);
  p.merges = await mergeHistory(p.id);
  const af = await db.prepare("SELECT source, fields, filled_at FROM autofill_log WHERE product_id = ? AND source <> ''").get(p.id);
  p.autofill = af ? { source: af.source, fields: JSON.parse(af.fields), filled_at: iso(af.filled_at) } : null;
  res.json(p);
});

async function mergeHistory(targetId) {
  return (await db.prepare('SELECT source_id, source_snapshot, merged_at FROM merges WHERE target_id = ? ORDER BY id').all(targetId))
    .map((m) => {
      const s = JSON.parse(m.source_snapshot);
      return { source_id: m.source_id, name: s.name, sku: s.sku, barcodes: s.barcodes.map((b) => b.code), merged_at: iso(m.merged_at) };
    });
}

// Planilha de nomes: uma linha leve por produto, em blocos, para rolar pelo catálogo inteiro
const NAME_SORTS = {
  id: 'p.id', code: 'code', name: 'p.name COLLATE NOCASE', brand: 'p.brand COLLATE NOCASE',
  manufacturer: 'p.manufacturer COLLATE NOCASE', category: 'p.category COLLATE NOCASE',
};
const MAX_NAME_LENGTH = 300;
// Colunas editáveis da planilha: nome (obrigatório) e os dados gerais de texto curto
const SHEET_FIELDS = { name: { label: 'nome', max: MAX_NAME_LENGTH, required: true }, brand: { label: 'marca', max: 120 }, manufacturer: { label: 'fabricante', max: 120 }, category: { label: 'categoria', max: 120 } };
const MAX_NAMES_PER_SAVE = 2000;

admin.get('/product-names', async (req, res) => {
  const { sqlWhere, params } = buildWhere(req.query);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const sort = NAME_SORTS[req.query.sort] ?? NAME_SORTS.name;
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM products p ${sqlWhere}`).get(...params)).n;
  const items = await db.prepare(`SELECT p.id, p.name, p.brand, p.manufacturer, p.category, p.active,
      (SELECT b.code FROM barcodes b WHERE b.product_id = p.id ORDER BY b.id LIMIT 1) AS code,
      (SELECT COUNT(*) FROM barcodes b WHERE b.product_id = p.id) AS codes,
      ${PENDING_SQL} AS pending
    FROM products p ${sqlWhere} ORDER BY ${sort} ${dir}, p.id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ total, offset, items });
});

// Grava células da planilha em lote: { id, field, value, original } (sem field = nome, como antes).
// "original" é o valor que a tela mostrava: se mudou no servidor, aquela célula não é gravada
// e volta como conflito, para ninguém apagar sem ver a alteração de outra pessoa.
admin.post('/product-names', async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Nada para gravar');
  if (items.length > MAX_NAMES_PER_SAVE) throw new HttpError(400, `Envie até ${MAX_NAMES_PER_SAVE} células de cada vez`);
  const clean = items.map((it) => {
    const field = it?.field ?? 'name';
    const spec = SHEET_FIELDS[field];
    if (!spec) throw new HttpError(400, `Coluna não editável: ${field}`);
    const value = cleanLine(String(it?.value ?? it?.name ?? ''));
    const id = Number(it?.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Produto inválido');
    if (spec.required && !value) throw new HttpError(400, `Produto #${id}: o ${spec.label} é obrigatório`);
    if (value.length > spec.max) throw new HttpError(400, `Produto #${id}: ${spec.label} com mais de ${spec.max} caracteres`);
    // original sem tratamento: é comparado com o valor gravado, que pode ser antigo e ter espaços sobrando
    return { id, field, value, original: String(it.original ?? '') };
  });
  const out = { saved: [], conflicts: [], missing: [] };
  await tx(async () => {
    for (const it of clean) {
      const row = await db.prepare(`SELECT ${it.field} AS v FROM products WHERE id = ?`).get(it.id);
      const cur = row ? String(row.v ?? '') : null;
      const item = { id: it.id, field: it.field, value: it.value, name: it.field === 'name' ? it.value : undefined };
      if (cur === null) out.missing.push(it.id);
      else if (cur === it.value) out.saved.push(item);
      else if (cur !== it.original) out.conflicts.push({ id: it.id, field: it.field, current: cur });
      else {
        // Corrigir na planilha não é revisar o cadastro: não renova o prazo de atualização
        await applyFields(it.id, { [it.field]: it.value }, { group: null, renew: false });
        out.saved.push(item);
      }
    }
  });
  res.json(out);
});

// Mesclagem: ids na ordem de seleção. O primeiro mantém todos os seus dados e recebe os códigos de barras
// e as imagens dos demais, com as datas originais; os demais produtos são removidos (ficam no histórico).
admin.post('/merge', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  if (ids.length < 2) throw new HttpError(400, 'Selecione ao menos dois produtos para mesclar');
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Produto repetido na seleção');
  for (const id of ids) await requireProduct(id);
  const [targetId, ...sourceIds] = ids;
  const base = baseUrl(req);
  const snapshots = await mapSeries(sourceIds, (id) => getProduct(id, base));
  const removedFiles = [];

  await tx(async () => {
    // Se o principal é um cadastro completo, os pedidos pendentes dos agregados ficam resolvidos
    const targetPending = !!(await db.prepare("SELECT 1 FROM barcode_requests WHERE product_id = ? AND status = 'pendente'").get(targetId));
    let pos = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM images WHERE product_id = ?').get(targetId)).n;

    for (const sid of sourceIds) {
      // Só troca o dono: created_at/updated_at de códigos e imagens permanecem os mesmos
      await db.prepare('UPDATE barcodes SET product_id = ? WHERE product_id = ?').run(targetId, sid);
      for (const im of await db.prepare('SELECT id FROM images WHERE product_id = ? ORDER BY position, id').all(sid)) {
        await db.prepare('UPDATE images SET product_id = ?, position = ? WHERE id = ?').run(targetId, pos++, im.id);
      }
      // Tributação por estado e dados de notas: o que o principal já tem continua valendo
      await db.prepare(`UPDATE product_tax_uf SET product_id = ? WHERE product_id = ?
        AND uf NOT IN (SELECT uf FROM product_tax_uf WHERE product_id = ?)`).run(targetId, sid, targetId);
      await db.prepare(`UPDATE xml_observations o SET product_id = ? WHERE o.product_id = ?
        AND NOT EXISTS (SELECT 1 FROM xml_observations t WHERE t.product_id = ? AND t.uf = o.uf AND t.emitter = o.emitter)`).run(targetId, sid, targetId);
      if (targetPending) {
        await db.prepare('UPDATE barcode_requests SET product_id = ? WHERE product_id = ?').run(targetId, sid);
      } else {
        await db.prepare(`UPDATE barcode_requests SET product_id = ?,
          resolved_at = CASE WHEN status = 'pendente' THEN datetime('now') ELSE resolved_at END,
          status = 'atualizado' WHERE product_id = ?`).run(targetId, sid);
      }
    }

    // Imagem padrão: some se houver imagem real; se só houver padrões, fica uma
    const imgs = await db.prepare('SELECT id, filename, is_placeholder FROM images WHERE product_id = ? ORDER BY position, id').all(targetId);
    const hasReal = imgs.some((i) => !i.is_placeholder);
    let keptPlaceholder = false;
    for (const im of imgs.filter((i) => i.is_placeholder)) {
      if (!hasReal && !keptPlaceholder) { keptPlaceholder = true; continue; }
      await db.prepare('DELETE FROM images WHERE id = ?').run(im.id);
      removedFiles.push(im.filename);
    }
    for (const [i, im] of (await db.prepare('SELECT id FROM images WHERE product_id = ? ORDER BY position, id').all(targetId)).entries()) {
      await db.prepare('UPDATE images SET position = ? WHERE id = ?').run(i, im.id);
    }

    const log = db.prepare('INSERT INTO merges (target_id, source_id, source_snapshot) VALUES (?, ?, ?)');
    for (const snap of snapshots) await log.run(targetId, snap.id, JSON.stringify(snap));
    // Mesclagens anteriores que apontavam para os removidos passam a apontar para o principal
    await db.prepare(`UPDATE merges SET target_id = ? WHERE target_id IN (${sourceIds.map(() => '?').join(',')})`).run(targetId, ...sourceIds);
    for (const sid of sourceIds) await db.prepare('DELETE FROM products WHERE id = ?').run(sid);
    await touch(targetId);
  });

  removedFiles.forEach(removeImageFile);
  const p = await getProduct(targetId, base);
  p.requests = await db.prepare('SELECT * FROM barcode_requests WHERE product_id = ? ORDER BY first_requested_at, code').all(targetId);
  p.merges = await mergeHistory(targetId);
  res.json({ merged: sourceIds, product: p });
});

// Princípios ativos do medicamento (com data de alteração, como os demais campos)
async function saveActives(id, list) {
  if (list !== undefined && (await replaceProductDcb(id, list))) await trackFields(id, {}, { dcb: JSON.stringify(list) });
}

admin.post('/products', async (req, res) => {
  const data = await cleanProduct(req.body, false);
  await checkSku(data.sku);
  const id = await tx(async () => {
    const cols = Object.keys(data);
    const r = await db.prepare(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data));
    const newId = Number(r.lastInsertRowid);
    await trackFields(newId, null, { active: 1, ...data });
    if (req.body.barcodes) await replaceBarcodes(newId, req.body.barcodes);
    await saveActives(newId, req.body.dcb);
    await touch(newId, 'data');
    return newId;
  });
  res.status(201).json(await getProduct(id, baseUrl(req)));
});

admin.put('/products/:id', async (req, res) => {
  const id = await requireProduct(req.params.id);
  const data = await cleanProduct(req.body, true);
  if ('sku' in data) await checkSku(data.sku, id);
  await tx(async () => {
    const before = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    const cols = Object.keys(data);
    if (cols.length) await db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(data), id);
    await trackFields(id, before, data);
    if (req.body.barcodes !== undefined) await replaceBarcodes(id, req.body.barcodes);
    await saveActives(id, req.body.dcb);
    // Salvar o cadastro conta como atualização/revisão dos dados, mesmo sem mudanças
    await touch(id, 'data');
  });
  res.json(await getProduct(id, baseUrl(req)));
});

admin.delete('/products/:id', async (req, res) => {
  const id = await requireProduct(req.params.id);
  const files = await db.prepare('SELECT filename FROM images WHERE product_id = ?').all(id);
  await db.prepare('DELETE FROM products WHERE id = ?').run(id);
  files.forEach((f) => removeImageFile(f.filename));
  res.status(204).end();
});

admin.post('/products/:id/barcodes', async (req, res) => {
  const id = await requireProduct(req.params.id);
  const b = await checkBarcode(req.body, id);
  if (await db.prepare('SELECT 1 FROM barcodes WHERE code = ?').get(b.code)) throw new HttpError(409, `O código ${b.code} já está cadastrado neste produto`);
  await insertBarcode(id, b);
  await touch(id, 'data');
  res.status(201).json(await getProduct(id, baseUrl(req)));
});

admin.delete('/barcodes/:id', async (req, res) => {
  const bc = await db.prepare('SELECT product_id FROM barcodes WHERE id = ?').get(Number(req.params.id));
  if (!bc) throw new HttpError(404, 'Código não encontrado');
  await db.prepare('DELETE FROM barcodes WHERE id = ?').run(Number(req.params.id));
  await touch(bc.product_id, 'data');
  res.json(await getProduct(bc.product_id, baseUrl(req)));
});

admin.post('/products/:id/images', async (req, res, next) => {
  let id;
  try { id = await requireProduct(req.params.id); } catch (e) { return next(e); }
  upload.array('images', 30)(req, res, async err => {
    if (err) {
      (req.files || []).forEach((f) => removeImageFile(f.filename));
      return next(err);
    }
    if (!req.files?.length) return next(new HttpError(400, 'Envie ao menos uma imagem no campo "images"'));
    // A primeira imagem real substitui a imagem padrão
    const placeholders = await db.prepare('SELECT id, filename FROM images WHERE product_id = ? AND is_placeholder = 1').all(id);
    const ins = db.prepare('INSERT INTO images (product_id, filename, original_name, mime, size, position) VALUES (?, ?, ?, ?, ?, ?)');
    await tx(async () => {
      for (const p of placeholders) await db.prepare('DELETE FROM images WHERE id = ?').run(p.id);
      const start = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM images WHERE product_id = ?').get(id)).n;
      for (const [i, file] of req.files.entries()) await ins.run(id, file.filename, file.originalname, file.mimetype, file.size, start + i);
      await realImagesFirst(id);
      await touch(id, 'images');
    });
    placeholders.forEach((p) => removeImageFile(p.filename));
    res.status(201).json(await getProduct(id, baseUrl(req)));
  });
});

// Lista de códigos cadastrados automaticamente, para atualização posterior
admin.get('/pending', async (req, res) => {
  const status = ['pendente', 'atualizado'].includes(req.query.status) ? req.query.status : null;
  const rows = await db.prepare(`
    SELECT r.*, p.name AS product_name FROM barcode_requests r
    LEFT JOIN products p ON p.id = r.product_id
    ${status ? 'WHERE r.status = ?' : ''}
    ORDER BY r.status = 'pendente' DESC, r.request_count DESC, r.last_requested_at DESC, r.code`).all(...(status ? [status] : []));
  const pendingCount = (await db.prepare("SELECT COUNT(*) AS n FROM barcode_requests WHERE status = 'pendente'").get()).n;
  res.json({ pending: pendingCount, items: rows });
});

// Marca o produto como atualizado: tira todos os seus códigos da lista de pendentes
admin.post('/products/:id/resolve', async (req, res) => {
  const id = await requireProduct(req.params.id);
  await db.prepare("UPDATE barcode_requests SET status = 'atualizado', resolved_at = datetime('now') WHERE product_id = ? AND status = 'pendente'").run(id);
  await touch(id, 'data');
  res.json(await getProduct(id, baseUrl(req)));
});

// Confirma que as imagens atuais continuam corretas (renova o prazo sem enviar novas)
admin.post('/products/:id/images/confirm', async (req, res) => {
  const id = await requireProduct(req.params.id);
  if (!(await db.prepare('SELECT 1 FROM images WHERE product_id = ?').get(id))) {
    throw new HttpError(400, 'O produto ainda está com a imagem padrão; envie as imagens reais');
  }
  await touch(id, 'images');
  res.json(await getProduct(id, baseUrl(req)));
});

// Período das conexões do dashboard: ?dias=7 (padrão; 0 = todo o período) ou ?de=AAAA-MM-DD&ate=AAAA-MM-DD.
// Os dias são calculados aqui porque lookup_stats grava a data local do servidor.
async function dashboardPeriod(query) {
  const validDay = (name) => {
    const value = String(query[name] ?? '').trim();
    if (!value) return null;
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new HttpError(400, `Data inválida em "${name}": use AAAA-MM-DD`);
    }
    return value;
  };
  const de = validDay('de');
  const ate = validDay('ate');
  if (de || ate) {
    if (de && ate && de > ate) throw new HttpError(400, 'A data inicial não pode ser depois da final');
    return { from: de, to: ate };
  }
  const dias = query.dias === undefined || query.dias === '' ? 7 : Number(query.dias);
  if (!Number.isInteger(dias) || dias < 0 || dias > 3660) throw new HttpError(400, 'Período inválido em "dias"');
  if (dias === 0) return { from: null, to: null };
  return await db.prepare(`SELECT date('now', 'localtime', ?) AS "from", ${TODAY} AS "to"`).get(`-${dias - 1} days`);
}

// Dashboard: indicadores gerais
admin.get('/dashboard', async (req, res) => {
  const period = await dashboardPeriod(req.query);
  const n = async (sql, ...params) => (await db.prepare(sql).get(...params)).n;
  const count = async where => await n(`SELECT COUNT(*) AS n FROM products p WHERE ${where}`);
  const settings = getSettings();
  const total = await n('SELECT COUNT(*) AS n FROM products');
  const barcodes = await n('SELECT COUNT(*) AS n FROM barcodes');

  // A coluna "hoje" não depende do período; a ordenação das colunas é feita na tela sobre esta lista
  const sources = (await db.prepare(`
    SELECT s.source, SUM(s.hits) AS hits, SUM(s.created) AS created, SUM(s.not_found) AS not_found,
           (SELECT COALESCE(SUM(t.hits), 0) FROM lookup_stats t WHERE t.source = s.source AND t.day = ${TODAY}) AS today,
           MAX(s.last_at) AS last_at
    FROM lookup_stats s
    WHERE (?::text IS NULL OR s.day >= ?) AND (?::text IS NULL OR s.day <= ?)
    GROUP BY s.source ORDER BY hits DESC, s.source LIMIT 500`).all(period.from, period.from, period.to, period.to))
    .map((s) => ({ ...s, last_at: iso(s.last_at) }));

  res.json({
    generated_at: new Date().toISOString(),
    settings,
    products: {
      total,
      active: await count('p.active = 1'),
      inactive: await count('p.active = 0'),
      pending: await count(PENDING_SQL),
      overdue: await count(overdueSql()),
      overdue_data: await count(overdueSql('data')),
      overdue_images: await count(overdueSql('images')),
      due_today: await count(dueWithinSql(1)),
      due_week: await count(dueWithinSql(7)),
      created_today: await count(LIST_FILTERS.created_today()),
      updated_today: await count(LIST_FILTERS.updated_today()),
      no_image: await count(NO_REAL_IMAGE_SQL),
    },
    barcodes: { total: barcodes, per_product: total ? +(barcodes / total).toFixed(2) : 0 },
    images: {
      total: await n('SELECT COUNT(*) AS n FROM images WHERE is_placeholder = 0 AND is_ai = 0'),
      ai: await n('SELECT COUNT(*) AS n FROM images WHERE is_ai = 1'),
      placeholders: await n('SELECT COUNT(*) AS n FROM products p WHERE NOT EXISTS (SELECT 1 FROM images i WHERE i.product_id = p.id)'),
    },
    pending_requests: await n("SELECT COALESCE(SUM(request_count), 0) AS n FROM barcode_requests WHERE status = 'pendente'"),
    merges: await n('SELECT COUNT(*) AS n FROM merges'),
    lookups: {
      today: await n(`SELECT COALESCE(SUM(hits), 0) AS n FROM lookup_stats WHERE day = ${TODAY}`),
      total: await n('SELECT COALESCE(SUM(hits), 0) AS n FROM lookup_stats'),
      sources_today: await n(`SELECT COUNT(DISTINCT source) AS n FROM lookup_stats WHERE day = ${TODAY}`),
      top_source: sources[0] || null,
      sources,
      period,
    },
    top_pending: (await db.prepare(`
      SELECT r.code, r.request_count, r.last_source, r.last_requested_at, r.product_id, p.name
      FROM barcode_requests r JOIN products p ON p.id = r.product_id
      WHERE r.status = 'pendente' ORDER BY r.request_count DESC, r.last_requested_at DESC, r.code LIMIT 8`).all())
      .map((r) => ({ ...r, last_requested_at: iso(r.last_requested_at) })),
    recent_updates: (await db.prepare(`SELECT id, name, updated_at, created_at FROM products ORDER BY updated_at DESC, id DESC LIMIT 8`).all())
      .map((r) => ({ ...r, updated_at: iso(r.updated_at), created_at: iso(r.created_at) })),
  });
});

// Contadores do painel
admin.get('/summary', async (_req, res) => {
  res.json({
    total: (await db.prepare('SELECT COUNT(*) AS n FROM products').get()).n,
    pending: (await db.prepare("SELECT COUNT(DISTINCT product_id) AS n FROM barcode_requests WHERE status = 'pendente'").get()).n,
    overdue: (await db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${overdueSql()}`).get()).n,
  });
});

// Parâmetros do sistema
const SETTINGS_INFO = {
  prazo_cadastro_dias: 'Prazo, em dias, para atualização do cadastro',
  prazo_imagens_dias: 'Prazo, em dias, para atualização das imagens',
  exigir_chave: 'Exigir chave de acesso na API pública',
  imagem_padrao: 'Imagem padrão',
};

const aiConfig = () => {
  const s = getSettings();
  return { provider: s.ia_provedor, model: s.ia_modelo, token: getSecret('ia_token') };
};
const aiReady = () => { const c = aiConfig(); return !!(AI_PROVIDERS[c.provider] && c.token); };

const settingsResponse = () => ({
  ...getSettings(),
  ia_provedores: AI_PROVIDERS,
  ...Object.fromEntries(SECRET_SETTINGS.map((k) => [`${k}_set`, !!getSecret(k)])),
});

admin.get('/settings', (_req, res) => res.json(settingsResponse()));

admin.put('/settings', async (req, res) => {
  const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const changes = [];
  // Tokens: string não vazia grava; string vazia remove; ausente mantém
  for (const key of SECRET_SETTINGS) {
    if (typeof req.body[key] !== 'string') continue;
    const v = req.body[key].trim();
    if (v.length > 500) throw new HttpError(400, 'Token muito longo');
    if (v) changes.push([key, v]);
    else await db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
  if (req.body.ia_provedor !== undefined) {
    const v = String(req.body.ia_provedor);
    if (v && !AI_PROVIDERS[v]) throw new HttpError(400, 'Provedor de IA inválido');
    changes.push(['ia_provedor', v]);
  }
  if (req.body.ia_modelo !== undefined) {
    const v = String(req.body.ia_modelo).trim();
    if (!/^[\w.:-]{0,100}$/.test(v)) throw new HttpError(400, 'Modelo de IA inválido');
    changes.push(['ia_modelo', v]);
  }
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (req.body[key] === undefined) continue;
    const n = Number(req.body[key]);
    if (key === 'exigir_chave') {
      if (n !== 0 && n !== 1) throw new HttpError(400, `${SETTINGS_INFO[key]}: use 0 ou 1`);
    } else if (key === 'imagem_padrao') {
      if (!Number.isInteger(n) || n < 1 || n > DEFAULT_IMAGE_OPTIONS) throw new HttpError(400, `${SETTINGS_INFO[key]}: escolha de 1 a ${DEFAULT_IMAGE_OPTIONS}`);
    } else if (!Number.isInteger(n) || n < 0 || n > 3650) {
      throw new HttpError(400, `${SETTINGS_INFO[key]}: informe um número inteiro de 0 a 3650`);
    }
    changes.push([key, String(n)]);
  }
  await tx(async () => { for (const [k, v] of changes) await upd.run(k, v); });
  await reloadSettings();
  res.json(settingsResponse());
});

// Reordena imagens; a primeira da lista vira a imagem principal
admin.put('/products/:id/images/order', async (req, res) => {
  const id = await requireProduct(req.params.id);
  const ids = (req.body.ids || []).map(Number);
  const current = (await db.prepare('SELECT id FROM images WHERE product_id = ?').all(id)).map((r) => r.id);
  if (ids.length !== current.length || !current.every((c) => ids.includes(c))) {
    throw new HttpError(400, 'A lista deve conter exatamente todas as imagens do produto');
  }
  const upd = db.prepare('UPDATE images SET position = ? WHERE id = ?');
  await tx(async () => { for (const [pos, imgId] of ids.entries()) await upd.run(pos, imgId); await touch(id, 'images'); });
  res.json(await getProduct(id, baseUrl(req)));
});

admin.delete('/images/:id', async (req, res) => {
  const im = await db.prepare('SELECT product_id, filename FROM images WHERE id = ?').get(Number(req.params.id));
  if (!im) throw new HttpError(404, 'Imagem não encontrada');
  await db.prepare('DELETE FROM images WHERE id = ?').run(Number(req.params.id));
  removeImageFile(im.filename);
  await touch(im.product_id, 'images');
  res.json(await getProduct(im.product_id, baseUrl(req)));
});

// ---------------------------------------------------------------------------
// Ferramentas de atualização: imagens por URL, busca externa, importação de planilha,
// preenchimento automático em lote e edição em massa
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lookupOpts = () => ({ cosmosToken: getSecret('cosmos_token') });
const hasRealImage = async id => !!(await db.prepare('SELECT 1 FROM images WHERE product_id = ? AND is_placeholder = 0 AND is_ai = 0').get(id));

// Fotos reais na frente das ilustrações de IA (mantendo a ordem entre elas)
async function realImagesFirst(productId) {
  const imgs = await db.prepare('SELECT id FROM images WHERE product_id = ? ORDER BY is_ai, position, id').all(productId);
  const upd = db.prepare('UPDATE images SET position = ? WHERE id = ?');
  for (const [i, im] of imgs.entries()) await upd.run(i, im.id);
}

// Aplica campos ao produto registrando as datas de cada campo alterado.
// group: qual prazo renovar ('data' ou null = só "última atualização do registro").
// renew: renovar mesmo sem mudanças (salvar = revisão).
async function applyFields(id, rawData, { group = 'data', renew = true } = {}) {
  const before = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  const data = Object.fromEntries(Object.entries(rawData).map(([k, v]) => [k, typeof v === 'string' ? cleanField(k, v) : v]));
  const changed = Object.fromEntries(Object.entries(data).filter(([k, v]) => String(before[k] ?? '') !== String(v ?? '')));
  const cols = Object.keys(changed);
  if (cols.length) await db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(changed), id);
  await trackFields(id, before, changed);
  if (cols.length || renew) await touch(id, group);
  return cols;
}

const resolvePending = async id => (await db.prepare(
  "UPDATE barcode_requests SET status = 'atualizado', resolved_at = datetime('now') WHERE product_id = ? AND status = 'pendente'",
).run(id)).changes;

// Baixa uma imagem http(s) para IMAGES_DIR
async function downloadImage(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('URL inválida'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('a URL deve começar com http:// ou https://');
  const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'RepositorioProdutos/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!MIME_EXT[mime]) throw new Error(`não é uma imagem suportada (${mime || 'sem tipo'})`);
  if (Number(r.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) throw new Error('imagem maior que 15 MB');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('imagem maior que 15 MB');
  if (buf.length < 100) throw new Error('arquivo vazio');
  const filename = crypto.randomUUID() + MIME_EXT[mime];
  fs.writeFileSync(path.join(IMAGES_DIR, filename), buf);
  return { filename, mime, size: buf.length, original_name: decodeURIComponent(path.basename(u.pathname)).slice(0, 200) || 'imagem' };
}

// Adiciona imagens de URLs ao produto; a primeira imagem real substitui a imagem padrão
async function addImagesFromUrls(productId, urls) {
  const results = [];
  const saved = [];
  for (const url of urls.slice(0, 20)) {
    try { saved.push(await downloadImage(url)); results.push({ url, ok: true }); }
    catch (e) { results.push({ url, ok: false, error: e.name === 'TimeoutError' ? 'tempo esgotado' : e.message }); }
  }
  if (!saved.length) return results;
  if (!(await db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId))) { // excluído durante o download
    saved.forEach((s) => removeImageFile(s.filename));
    return results;
  }
  const placeholders = await db.prepare('SELECT id, filename FROM images WHERE product_id = ? AND is_placeholder = 1').all(productId);
  await tx(async () => {
    for (const p of placeholders) await db.prepare('DELETE FROM images WHERE id = ?').run(p.id);
    let pos = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM images WHERE product_id = ?').get(productId)).n;
    const ins = db.prepare('INSERT INTO images (product_id, filename, original_name, mime, size, position) VALUES (?, ?, ?, ?, ?, ?)');
    for (const img of saved) await ins.run(productId, img.filename, img.original_name, img.mime, img.size, pos++);
    await realImagesFirst(productId);
    await touch(productId, 'images');
  });
  placeholders.forEach((p) => removeImageFile(p.filename));
  return results;
}

admin.post('/products/:id/images/from-url', async (req, res, next) => {
  try {
    const id = await requireProduct(req.params.id);
    const urls = (Array.isArray(req.body.urls) ? req.body.urls : [req.body.url]).filter(Boolean).map(String);
    if (!urls.length) throw new HttpError(400, 'Informe ao menos uma URL de imagem');
    const results = await addImagesFromUrls(id, urls);
    if (!results.some((r) => r.ok)) throw new HttpError(400, `Nenhuma imagem baixada: ${results.map((r) => r.error).join('; ')}`);
    res.json({ results, product: await getProduct(id, baseUrl(req)) });
  } catch (e) { next(e); }
});

// ---- Imagem ilustrativa por IA -----------------------------------------------
// O código de barras identifica o produto (cadastro ou bases externas); a IA desenha a partir do nome/marca/tamanho.

// Dados para o prompt: os informados (formulário ainda não salvo) > cadastro > primeira base externa que conhece o código
async function aiProductData(productId, given = {}) {
  const p = await db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const data = {};
  for (const f of ['name', 'brand', 'unit', 'category', 'description']) {
    const v = String(given[f] ?? '').trim() || String(p[f] ?? '').trim();
    if (v) data[f] = v;
  }
  if (data.name?.startsWith(AUTO_NAME)) delete data.name;
  if (!data.name) {
    const codes = (await db.prepare('SELECT code FROM barcodes WHERE product_id = ? ORDER BY id').all(productId)).map((r) => r.code).filter((c) => /^\d{8,14}$/.test(c));
    for (const code of codes) {
      const { result } = await lookupFirstCached(code, { useCosmos: false, skip: new Set() });
      if (result) {
        for (const f of ['name', 'brand', 'unit', 'category']) if (!data[f] && result[f]) data[f] = result[f];
        data.source = result.source_name;
        break;
      }
    }
  }
  return data.name ? data : null;
}

// Gera e grava a imagem; ela substitui a imagem padrão e entra depois das fotos reais
async function addAiImage(productId, data) {
  const img = await generateProductImage(data, aiConfig());
  const ext = MIME_EXT[img.mime] || '.png';
  const filename = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(IMAGES_DIR, filename), img.buffer);
  if (!(await db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId))) { removeImageFile(filename); return null; }
  const placeholders = await db.prepare('SELECT id, filename FROM images WHERE product_id = ? AND is_placeholder = 1').all(productId);
  await tx(async () => {
    for (const p of placeholders) await db.prepare('DELETE FROM images WHERE id = ?').run(p.id);
    const pos = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM images WHERE product_id = ?').get(productId)).n;
    await db.prepare(`INSERT INTO images (product_id, filename, original_name, mime, size, position, is_ai)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(productId, filename, `ia-${img.provider}-${img.model}${ext}`.slice(0, 200), img.mime, img.buffer.length, pos);
    await realImagesFirst(productId);
    await touch(productId); // não renova o prazo das imagens: não é foto real
  });
  placeholders.forEach((p) => removeImageFile(p.filename));
  return img;
}

admin.get('/ai/status', (_req, res) => {
  const c = aiConfig();
  res.json({ ready: aiReady(), provider: c.provider, provider_name: AI_PROVIDERS[c.provider]?.name || '',
    model: c.model || AI_PROVIDERS[c.provider]?.defaultModel || '' });
});

admin.post('/products/:id/images/ai', async (req, res, next) => {
  try {
    const id = await requireProduct(req.params.id);
    if (!aiReady()) throw new HttpError(400, 'Geração por IA não configurada: escolha o provedor e informe a chave em Parâmetros');
    const data = await aiProductData(id, req.body || {});
    if (!data) throw new HttpError(400, 'Não foi possível identificar o produto por este código de barras: informe ao menos o nome antes de gerar a imagem');
    let img;
    try { img = await addAiImage(id, data); }
    catch (e) { throw new HttpError(e.unauthorized ? 400 : 502, `Falha na geração por IA: ${e.message}`); }
    if (!img) throw new HttpError(404, 'Produto não encontrado');
    res.json({ product: await getProduct(id, baseUrl(req)), used: data, provider: img.provider, model: img.model });
  } catch (e) { next(e); }
});

// ---- Consultas externas com cache --------------------------------------------
// Achados valem 180 dias; "não encontrado" vale 30 (o produto pode ser cadastrado na base depois).
// Erros (limite, token, tempo esgotado) não são guardados.
const CACHE_DAYS = { found: 180, miss: 30 };

async function cachedResult(code, provider) {
  const row = await db.prepare(`SELECT found, result, fetched_at FROM lookup_cache WHERE code = ? AND source = ?
    AND fetched_at > datetime('now', CASE WHEN found = 1 THEN ? ELSE ? END)`)
    .get(code, provider.id, `-${CACHE_DAYS.found} days`, `-${CACHE_DAYS.miss} days`);
  if (!row) return null;
  return { source: provider.id, source_name: provider.name, ...JSON.parse(row.result), cached_at: iso(row.fetched_at) };
}

async function lookupProvider(code, provider) {
  const hit = await cachedResult(code, provider);
  if (hit) return hit;
  const r = await lookupOne(provider, code);
  if (!r.error) {
    const { source, source_name, ...data } = r;
    await db.prepare(`INSERT INTO lookup_cache (code, source, found, result) VALUES (?, ?, ?, ?)
      ON CONFLICT(code, source) DO UPDATE SET found = excluded.found, result = excluded.result, fetched_at = datetime('now')`)
      .run(code, provider.id, r.not_found ? 0 : 1, JSON.stringify(data));
  }
  return r;
}

// cosmos: 'live' (consulta), 'cache' (só se já guardada; senão devolve skipped), 'off' (ignora), 'only' (só a Cosmos)
async function lookupCodes(code, cosmos = 'cache') {
  const list = providers(cosmos === 'off' ? {} : lookupOpts()).filter((p) => (cosmos === 'only' ? p.id === 'cosmos' : true));
  return Promise.all(list.map(async p => {
    if (p.id === 'cosmos' && cosmos === 'cache') {
      return (await cachedResult(code, p)) || { source: p.id, source_name: p.name, skipped: true };
    }
    return await lookupProvider(code, p);
  }));
}

// Em sequência, para no primeiro achado (lote). skip: bases recusadas nesta execução
async function lookupFirstCached(code, { useCosmos, skip }) {
  const errors = [];
  for (const p of providers(useCosmos ? lookupOpts() : {})) {
    if (skip.has(p.id)) continue;
    const r = await lookupProvider(code, p);
    if (r.error) errors.push(r);
    else if (!r.not_found) return { result: r, errors };
  }
  return { result: null, errors };
}

// Busca o código nas bases externas. ?cosmos=cache (padrão: Cosmos só se já consultada), live, only, off (ou 0)
admin.get('/lookup/:code', async (req, res, next) => {
  try {
    const code = req.params.code.trim();
    if (!/^\d{8,14}$/.test(code)) throw new HttpError(400, 'Informe um código de barras numérico (8 a 14 dígitos)');
    const mode = req.query.cosmos === '0' ? 'off' : ['live', 'cache', 'off', 'only'].includes(req.query.cosmos) ? req.query.cosmos : 'cache';
    res.json({ code, cosmos_available: !!getSecret('cosmos_token'), results: await lookupCodes(code, mode) });
  } catch (e) { next(e); }
});

// Ids de produtos de um filtro (fila de atualização / "selecionar todos")
admin.get('/product-ids', async (req, res) => {
  const { order, ...query } = req.query;
  res.json({ ids: await productIds(query, order) });
});

// ---- Importação de planilha -------------------------------------------------

const IMPORT_FIELDS = ['sku', 'name', 'description', 'brand', 'category', 'unit'];
const bool = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 'true' || v === '1' || v === 1 || v === 'on');

function importOptions(b = {}) {
  return {
    create_missing: bool(b.create_missing, true),
    overwrite_empty: bool(b.overwrite_empty, false),
    resolve_pending: bool(b.resolve_pending, true),
    download_images: bool(b.download_images, true),
  };
}

// Calcula o que cada linha faria (sem gravar): create | update | unchanged | skip | error
async function planImport(rows, opts) {
  const seenCode = new Map();
  const seenSku = new Map();
  const ownerOf = db.prepare('SELECT product_id FROM barcodes WHERE code = ?');
  return mapSeries(rows, async row => {
    const item = { line: row.line, action: 'unchanged', product_id: null, changes: {}, add_barcodes: [], images: (row.images || []).slice(0, 20), warnings: [] };
    try {
      const codes = [];
      for (const raw of row.barcodes || []) {
        const r = analyzeBarcode(raw);
        if (r.error) throw new Error(r.error);
        if (seenCode.has(r.code)) throw new Error(`código ${r.code} repetido na planilha (linha ${seenCode.get(r.code)})`);
        seenCode.set(r.code, row.line);
        codes.push(r);
      }
      const sku = String(row.sku ?? '').trim() || null;
      if (sku) {
        if (seenSku.has(sku)) throw new Error(`SKU ${sku} repetido na planilha (linha ${seenSku.get(sku)})`);
        seenSku.set(sku, row.line);
      }
      if (!codes.length && !sku) throw new Error('linha sem código de barras e sem SKU');

      const owners = new Set();
      for (const c of codes) {
        const owner = (await ownerOf.get(c.code))?.product_id;
        if (owner) owners.add(owner);
      }
      if (owners.size > 1) throw new Error(`os códigos pertencem a produtos diferentes (#${[...owners].join(', #')}); mescle-os antes`);
      let pid = [...owners][0] || null;
      if (!pid && sku) pid = (await db.prepare('SELECT id FROM products WHERE sku = ?').get(sku))?.id || null;

      const values = {};
      for (const f of IMPORT_FIELDS) {
        if (row[f] === undefined) continue;
        const v = String(row[f]).trim();
        if (v === '' && (!opts.overwrite_empty || f === 'name')) continue; // nome nunca fica vazio
        values[f] = f === 'sku' && v === '' ? null : v;
      }
      if (row.active !== undefined) values.active = row.active ? 1 : 0;
      if (values.sku) {
        const other = await db.prepare('SELECT id FROM products WHERE sku = ? AND id <> ?').get(values.sku, pid ?? -1);
        if (other) throw new Error(`SKU ${values.sku} já usado pelo produto #${other.id}`);
      }

      if (pid) {
        const before = await db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
        item.product_id = pid;
        item.current_name = before.name;
        for (const [f, v] of Object.entries(values)) {
          if (String(before[f] ?? '') !== String(v ?? '')) item.changes[f] = { from: before[f], to: v };
        }
        const own = new Set((await db.prepare('SELECT code FROM barcodes WHERE product_id = ?').all(pid)).map((r) => r.code));
        item.add_barcodes = codes.filter((c) => !own.has(c.code)).map((c) => c.code);
        if (Object.keys(item.changes).length || item.add_barcodes.length || (opts.download_images && item.images.length)) item.action = 'update';
      } else if (!opts.create_missing) {
        item.action = 'skip';
        item.warnings.push('produto não encontrado (criação desativada)');
      } else {
        if (!values.name) throw new Error('produto novo sem nome');
        item.action = 'create';
        item.changes = Object.fromEntries(Object.entries(values).map(([f, v]) => [f, { from: null, to: v }]));
        item.add_barcodes = codes.map((c) => c.code);
      }
      item.name = values.name ?? item.current_name;
      item.codes = codes;
    } catch (e) {
      item.action = 'error';
      item.error = e.message;
    }
    return item;
  });
}

const countActions = (plan) => plan.reduce((acc, p) => ({ ...acc, [p.action]: (acc[p.action] || 0) + 1 }), {});

async function applyImport(plan, opts) {
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, resolved: 0, images: 0, image_errors: 0 };
  const imageJobs = [];
  const imageErrors = [];
  await tx(async () => {
    for (const it of plan) {
      if (it.action === 'error') { summary.errors++; continue; }
      if (it.action === 'skip') { summary.skipped++; continue; }
      if (it.action === 'unchanged') { summary.unchanged++; continue; }
      let pid = it.product_id;
      if (it.action === 'create') {
        const data = Object.fromEntries(Object.entries(it.changes).map(([f, c]) => [f, c.to]));
        const cols = Object.keys(data);
        pid = Number((await db.prepare(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data))).lastInsertRowid);
        await trackFields(pid, null, { active: 1, ...data });
        await touch(pid, 'data');
        summary.created++;
      } else {
        await applyFields(pid, Object.fromEntries(Object.entries(it.changes).map(([f, c]) => [f, c.to])));
        summary.updated++;
      }
      for (const code of it.add_barcodes) await insertBarcode(pid, { ...it.codes.find((c) => c.code === code), note: 'importação' });
      if (opts.resolve_pending && (await resolvePending(pid))) summary.resolved++;
      if (opts.download_images && it.images.length) imageJobs.push({ pid, line: it.line, urls: it.images });
      it.product_id = pid;
    }
  });
  // Imagens fora da transação, 4 downloads em paralelo
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < imageJobs.length) {
      const job = imageJobs[next++];
      for (const r of await addImagesFromUrls(job.pid, job.urls)) {
        if (r.ok) summary.images++;
        else { summary.image_errors++; if (imageErrors.length < 50) imageErrors.push({ line: job.line, url: r.url, error: r.error }); }
      }
    }
  }));
  return { summary, imageErrors };
}

const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const MAX_IMPORT_ROWS = 20000;
mountDcb(admin, sheetUpload);
mountTaxImport(admin, sheetUpload, { applyFields });
mountNfceImport(admin, { applyFields, autoRegister, findBarcode, insertBarcode, AUTO_NAME });

admin.post('/import/preview', sheetUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Envie a planilha no campo "file"');
    let sheet;
    try { sheet = await readSpreadsheet(req.file.buffer, req.file.originalname); }
    catch (e) { throw new HttpError(400, e.message); }
    if (sheet.rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Planilha com mais de ${MAX_IMPORT_ROWS} linhas; divida em partes`);
    const plan = await planImport(sheet.rows, importOptions(req.body));
    res.json({
      file: req.file.originalname,
      format: sheet.format,
      columns: sheet.columns.map((f) => ({ field: f, label: FIELD_LABELS[f] })),
      unknown_columns: sheet.unknown_columns,
      rows: sheet.rows,
      plan: plan.map(({ codes, ...p }) => p),
      summary: countActions(plan),
    });
  } catch (e) { next(e); }
});

// Recebe as linhas lidas na prévia e aplica (o plano é recalculado no servidor)
admin.post('/import/apply', async (req, res, next) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Nenhuma linha para importar');
    if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Máximo de ${MAX_IMPORT_ROWS} linhas por importação`);
    const opts = importOptions(req.body.options);
    const plan = await planImport(rows, opts);
    const { summary, imageErrors } = await applyImport(plan, opts);
    res.json({
      summary,
      errors: plan.filter((p) => p.action === 'error').map((p) => ({ line: p.line, error: p.error })),
      image_errors: imageErrors,
    });
  } catch (e) { next(e); }
});

// ---- Preenchimento automático em lote (busca externa) ----------------------

const autofill = {
  running: false, stopRequested: false, target: null, total: 0, done: 0,
  found: 0, applied: 0, not_found: 0, errors: 0, ai_generated: 0, ai_errors: 0,
  started_at: null, finished_at: null, message: '', last: [],
};
const autofillStatus = () => ({ ...autofill, last: autofill.last.slice(-20).reverse() });

// Só preenche o que está vazio (ou o nome provisório do cadastro automático)
function autofillData(p, found) {
  const data = {};
  if ((!p.name || p.name.startsWith(AUTO_NAME)) && found.name) data.name = found.name;
  for (const f of ['brand', 'category', 'description', 'unit']) if (!p[f] && found[f]) data[f] = found[f];
  return data;
}

async function logAutofill(id, source, fields) {
  await db.prepare(`INSERT INTO autofill_log (product_id, source, fields) VALUES (?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET source = excluded.source, fields = excluded.fields, filled_at = datetime('now')`)
    .run(id, source, JSON.stringify(fields));
}

async function runAutofill(ids, { useCosmos, useAi }) {
  const skip = new Set();
  let aiOn = useAi;
  const totalProviders = useCosmos ? 4 : 3;
  for (const id of ids) {
    if (autofill.stopRequested) { autofill.message = 'Interrompido a pedido'; break; }
    if (skip.size >= totalProviders) { autofill.message = 'Todas as bases recusaram (limite ou token); tente mais tarde'; break; }
    const p = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) { autofill.done++; continue; }
    const codes = (await db.prepare('SELECT code FROM barcodes WHERE product_id = ? ORDER BY id').all(id)).map((r) => r.code).filter((c) => /^\d{8,14}$/.test(c));
    let found = null;
    let hadError = false;
    for (const code of codes) {
      const { result, errors } = await lookupFirstCached(code, { useCosmos, skip });
      for (const e of errors) {
        hadError = true;
        if (e.rateLimited || e.unauthorized) { skip.add(e.source); autofill.message = `${e.source}: ${e.error} (base ignorada nesta execução)`; }
      }
      if (result) { found = { code, ...result }; break; }
    }
    const entry = { id, code: found?.code || codes[0] || '' };
    if (found) {
      autofill.found++;
      const data = autofillData(p, found);
      const changed = await tx(async () => await applyFields(id, data, { group: null, renew: false }));
      let images = 0;
      if (found.images.length && !(await hasRealImage(id))) images = (await addImagesFromUrls(id, found.images.slice(0, 1))).filter((r) => r.ok).length;
      const fields = [...changed, ...(images ? ['images'] : [])];
      await logAutofill(id, found.source_name, fields);
      if (fields.length) autofill.applied++;
      Object.assign(entry, { name: data.name || p.name, source: found.source_name, fields });
    } else {
      if (hadError) autofill.errors++; else autofill.not_found++;
      if (!hadError) await logAutofill(id, '', []); // consultado sem resultado: não repete nas próximas execuções
      entry.not_found = !hadError;
      entry.error = hadError;
      entry.name = p.name;
    }
    // Sem foto (nem real nem de IA) depois da busca: gera por IA, se pedido e se o produto foi identificado
    const hasAnyImage = await db.prepare('SELECT 1 FROM images WHERE product_id = ? AND is_placeholder = 0').get(id);
    if (aiOn && !hasAnyImage && !autofill.stopRequested) {
      const data = await aiProductData(id);
      if (data) {
        try {
          await addAiImage(id, data);
          autofill.ai_generated++;
          entry.ai = true;
          if (entry.fields) entry.fields = [...entry.fields, 'imagem IA'];
        } catch (e) {
          autofill.ai_errors++;
          entry.ai_error = e.message;
          if (e.unauthorized || e.rateLimited) { aiOn = false; autofill.message = `IA: ${e.message} (geração desligada nesta execução)`; }
        }
      }
    }
    autofill.last.push(entry);
    if (autofill.last.length > 100) autofill.last.shift();
    autofill.done++;
    await sleep(700); // respeita o limite das APIs públicas (~100 consultas/min)
  }
  autofill.running = false;
  autofill.finished_at = new Date().toISOString();
  if (!autofill.message) autofill.message = 'Concluído';
}

admin.get('/autofill', (_req, res) => res.json({ ...autofillStatus(), cosmos_token_set: !!getSecret('cosmos_token'), ai_ready: aiReady() }));

admin.post('/autofill/start', async (req, res) => {
  if (autofill.running) throw new HttpError(409, 'Já existe uma busca automática em andamento');
  const target = ['pending', 'no_image', 'overdue'].includes(req.body.target) ? req.body.target : 'pending';
  let ids = await productIds({ [target]: 1 }, target === 'pending' ? 'requests' : undefined);
  if (req.body.skip_checked !== false) {
    const checked = new Set((await db.prepare('SELECT product_id FROM autofill_log').all()).map((r) => r.product_id));
    ids = ids.filter((id) => !checked.has(id));
  }
  const limit = Number(req.body.limit) > 0 ? Math.min(Number(req.body.limit), 5000) : 5000;
  ids = ids.slice(0, limit);
  Object.assign(autofill, {
    running: true, stopRequested: false, target, total: ids.length, done: 0, found: 0, applied: 0,
    not_found: 0, errors: 0, ai_generated: 0, ai_errors: 0, started_at: new Date().toISOString(), finished_at: null, message: '', last: [],
  });
  // Cosmos só com opt-in explícito: o plano gratuito tem franquia diária pequena
  const useCosmos = req.body.use_cosmos === true && !!getSecret('cosmos_token');
  autofill.use_cosmos = useCosmos;
  // IA também só com opt-in: cada imagem gerada é cobrada pelo provedor
  const useAi = req.body.use_ai === true && aiReady();
  autofill.use_ai = useAi;
  runAutofill(ids, { useCosmos, useAi }).catch((e) => {
    autofill.running = false;
    autofill.message = `Erro: ${e.message}`;
    console.error(e);
  });
  res.json(autofillStatus());
});

admin.post('/autofill/stop', (_req, res) => {
  autofill.stopRequested = true;
  res.json(autofillStatus());
});

// ---- Edição em massa ---------------------------------------------------------

admin.post('/bulk', async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? [...new Set(req.body.ids.map(Number).filter(Boolean))]
    : req.body.filter && typeof req.body.filter === 'object' ? await productIds(req.body.filter) : [];
  if (!ids.length) throw new HttpError(400, 'Nenhum produto selecionado');
  const set = {};
  for (const f of ['category', 'brand', 'manufacturer', 'unit']) if (typeof req.body.set?.[f] === 'string') set[f] = req.body.set[f].trim();
  if (typeof req.body.set?.active === 'boolean') set.active = req.body.set.active ? 1 : 0;
  if (typeof req.body.set?.ncm === 'string') set.ncm = req.body.set.ncm.trim() ? cleanNcmCode(req.body.set.ncm) : '';
  if (req.body.set?.tax_class_id !== undefined) set.tax_class_id = await checkTaxClass(req.body.set.tax_class_id);
  const actions = req.body.actions || {};
  if (!Object.keys(set).length && !actions.resolve && !actions.confirm_images) throw new HttpError(400, 'Nenhuma alteração escolhida');

  const out = { products: ids.length, changed: 0, resolved: 0, images_confirmed: 0, images_skipped: 0 };
  await tx(async () => {
    for (const id of ids) {
      if (!(await db.prepare('SELECT 1 FROM products WHERE id = ?').get(id))) continue;
      if (Object.keys(set).length && (await applyFields(id, set, { renew: false })).length) out.changed++;
      if (actions.resolve && (await resolvePending(id))) out.resolved++;
      if (actions.confirm_images) {
        if ((await hasRealImage(id)) && !(await db.prepare('SELECT 1 FROM images WHERE product_id = ? AND is_placeholder = 1').get(id))) {
          await touch(id, 'images');
          out.images_confirmed++;
        } else out.images_skipped++;
      }
    }
  });
  res.json(out);
});

app.use('/api/admin', admin);

// ---------------------------------------------------------------------------
// Painel e tratamento de erros
// ---------------------------------------------------------------------------

// Painel é a página principal (raiz); /admin/ continua funcionando
const PANEL_DIR = path.join(ROOT, 'public', 'admin');
app.use('/admin', express.static(PANEL_DIR));
app.use('/', express.static(PANEL_DIR, { index: 'index.html' }));

app.use((req, _res, next) => next(new HttpError(404, `Rota não encontrada: ${req.method} ${req.path}`)));

app.use((err, _req, res, _next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') message = 'Imagem maior que 15 MB';
  } else if (err.type === 'entity.parse.failed') {
    status = 400; message = 'JSON inválido';
  } else if (err.code === '22P02' || err.code === '22003') {
    status = 400; message = 'Valor inválido na requisição'; // ex.: /products/abc
  } else if (err.code === '23505') {
    status = 409; message = 'Já existe um registro com este valor';
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// Uma vez só: as cópias da imagem padrão gravadas por produto dão lugar ao arquivo único.
// Os arquivos ficam: outro sistema pode ter guardado o endereço /files/... deles.
if (!(await db.prepare("SELECT 1 FROM settings WHERE key = 'migr_imagem_padrao_unica'").get())) {
  await tx(async () => {
    await db.exec('DELETE FROM images WHERE is_placeholder = 1');
    await db.exec("INSERT INTO settings (key, value) VALUES ('migr_imagem_padrao_unica', '1')");
  });
}

const httpServer = app.listen(PORT, HOST, () => {
  const where = process.env.PUBLIC_BASE_URL || `http://${HOST || 'localhost'}:${PORT}`;
  console.log(`Repositório de produtos rodando em ${HOST || '*'}:${PORT}`);
  console.log(`Painel: ${where}/`);
  // Em produção o token não vai para o log; fica em DATA_DIR/config.json
  if (process.env.NODE_ENV !== 'production') console.log(`Token de administração: ${ADMIN_TOKEN}`);
});

// No container o Node é o processo principal: sem isto, parar o serviço espera o tempo limite e mata no meio de uma gravação
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal}: encerrando`);
    httpServer.close(() => db.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
