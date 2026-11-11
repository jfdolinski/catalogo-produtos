// Importação por planilha: cadastro de NCM e vínculo dos produtos com NCM, classificação e origem.
// As duas têm prévia (não grava) e aplicação; célula vazia nunca apaga o valor atual.
import { db, mapSeries } from './db.js';
import { HttpError, tx } from './business.js';
import { readGrid, norm } from './importer.js';
import { searchText } from './dcb.js';
import { fiscalValue, FEDERAL_FIELDS } from './tax.js';

const MAX_ROWS = 50000;
const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');

const NCM_COL = ['ncm', 'codigo_ncm', 'cod_ncm', 'ncm_sh', 'ncm_codigo', 'n_c_m'];
const NCM_COLS = {
  code: [...NCM_COL, 'codigo'],
  description: ['descricao', 'descricao_ncm', 'descricao_do_ncm', 'descr', 'nome'],
  cest: ['cest', 'cest_padrao'],
  cst_ipi: ['cst_ipi'], ipi_rate: ['ipi', 'aliquota_ipi', 'ipi_aliquota'],
  cst_pis: ['cst_pis'], pis_rate: ['pis', 'aliquota_pis', 'pis_aliquota'],
  cst_cofins: ['cst_cofins'], cofins_rate: ['cofins', 'aliquota_cofins', 'cofins_aliquota'],
  notes: ['observacoes', 'observacao', 'obs'],
};
const LINK_COLS = {
  barcode: ['codigo_barras', 'codigo_de_barras', 'cod_barras', 'barras', 'ean', 'ean13', 'gtin', 'barcode', 'codigo_barra'],
  sku: ['sku', 'codigo_interno', 'cod_interno', 'referencia', 'ref', 'codigo'],
  ncm: NCM_COL,
  tax_class: ['classificacao', 'classificacao_tributaria', 'class_trib', 'classe', 'classe_tributaria'],
  tax_origin: ['origem', 'origem_mercadoria', 'origem_da_mercadoria'],
};

// Procura o cabeçalho nas primeiras linhas (listas costumam ter título antes): a linha precisa ter as colunas "required"
function parseSheet(grid, cols, isHeader, errorText) {
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const keys = grid[i].map(norm);
    const map = {};
    for (const [field, aliases] of Object.entries(cols)) {
      for (const a of aliases) {
        const idx = keys.indexOf(a);
        if (idx >= 0 && !Object.values(map).includes(idx)) { map[field] = idx; break; }
      }
    }
    if (!isHeader(map)) continue;
    const rows = [];
    for (let l = i + 1; l < grid.length; l++) {
      const r = grid[l];
      if (!r.some((c) => String(c).trim())) continue;
      const row = { line: l + 1 };
      for (const [field, idx] of Object.entries(map)) row[field] = clean(r[idx], field === 'notes' || field === 'description' ? 2000 : 300);
      rows.push(row);
    }
    if (!rows.length) throw new Error('Nenhuma linha com dados depois do cabeçalho');
    if (rows.length > MAX_ROWS) throw new Error(`Arquivo com mais de ${MAX_ROWS} linhas: divida em partes`);
    return { rows, columns: Object.keys(map) };
  }
  throw new Error(errorText);
}

const SCI = /^\d+([.,]\d+)?e\+?\d+$/i; // Excel mostra EAN como 7,89E+12 e o valor exato se perde
const sciError = (label, v) => new HttpError(400, `${label} em notação científica (${v}): o Excel perdeu os dígitos; formate a coluna como texto e exporte de novo`);

// Excel tira o zero à esquerda de colunas numéricas
function ncmCode(raw) {
  if (SCI.test(raw)) throw sciError('NCM', raw);
  let c = onlyDigits(raw);
  if (/^\d{7}$/.test(String(raw).trim())) c = `0${c}`; // só número puro: "3004.90.6" é subitem da tabela oficial, não NCM sem zero
  if (c.length !== 8) throw new HttpError(400, `NCM inválido (${raw}): informe 8 dígitos`);
  return c;
}

const PAD = { cest: 7, cst_ipi: 2, cst_pis: 2, cst_cofins: 2 };
function fiscalCell(field, raw) {
  let v = clean(raw).replace(/\s*%$/, '');
  if (PAD[field] && /^\d+$/.test(v)) v = v.padStart(PAD[field], '0');
  return fiscalValue(field, v);
}

// Célula em % no Excel chega como fração (7,6% vira 0.076). Valores reais como 0,65 têm até 2 casas, então não avisa.
const looksLikeFraction = (v) => /^0\.\d{3,}$/.test(v);

// ---- Cadastro de NCM ------------------------------------------------------------

const NCM_FIELDS = ['cest', ...FEDERAL_FIELDS];

async function planNcm(rows, { updateExisting = true } = {}) {
  const byCode = db.prepare('SELECT * FROM ncm WHERE code = ?');
  const seen = new Map();
  return mapSeries(rows, async row => {
    const raw = clean(row.code);
    const item = { line: row.line, code: raw, description: clean(row.description, 500), action: 'create', id: null, warning: '', data: {} };
    // Tabelas oficiais trazem capítulos e posições (ex.: 30.04): não são NCM de produto
    const digits = onlyDigits(raw).length;
    if (!SCI.test(raw) && (digits < 7 || (digits === 7 && !/^\d+$/.test(raw)))) return { ...item, action: 'skip', error: raw ? 'não é um NCM de 8 dígitos (capítulo, posição ou subitem)' : 'sem código' };
    try {
      item.code = ncmCode(raw);
      if (seen.has(item.code)) throw new HttpError(400, `NCM repetido no arquivo (linha ${seen.get(item.code)})`);
      seen.set(item.code, row.line);
      for (const f of NCM_FIELDS) {
        const v = fiscalCell(f, row[f]);
        if (v) item.data[f] = v;
        if (f.endsWith('_rate') && looksLikeFraction(v)) item.warning = `Confira ${f.replace('_rate', '').toUpperCase()}: ${v}% parece célula em porcentagem no Excel`;
      }
      if (item.description) item.data.description = item.description;
      if (row.notes) item.data.notes = clean(row.notes, 2000);
      const found = await byCode.get(item.code);
      if (!found) {
        if (!item.description) throw new HttpError(400, 'NCM novo sem descrição');
        return item;
      }
      item.id = found.id;
      const changed = Object.entries(item.data).filter(([k, v]) => String(found[k] ?? '') !== v);
      item.action = changed.length && updateExisting ? 'update' : 'unchanged';
      item.description = item.description || found.description;
      return item;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return { ...item, action: 'error', error: e.message };
    }
  });
}

// ---- Vínculo com os produtos ----------------------------------------------------

// Localiza o produto pelo código de barras (tolerando zeros à esquerda perdidos) ou pelo SKU
function productFinder() {
  const q = db.prepare('SELECT product_id FROM barcodes WHERE code = ?');
  const bySku = db.prepare('SELECT id FROM products WHERE sku = ?');
  return async (barcode, sku) => {
    const d = onlyDigits(barcode.split(/[|;,\s]/)[0]);
    if (d) {
      const base = d.replace(/^0+/, '');
      for (const c of [d, base, ...[8, 12, 13, 14].map((n) => base.padStart(n, '0'))]) {
        const r = c && (await q.get(c));
        if (r) return r.product_id;
      }
    }
    return sku ? (await bySku.get(sku))?.id ?? null : null;
  };
}

async function planLink(rows, { linkUnregistered = true, createClasses = false } = {}) {
  const find = productFinder();
  const current = db.prepare('SELECT id, name, ncm, tax_class_id, tax_origin FROM products WHERE id = ?');
  const ncmExists = db.prepare('SELECT 1 FROM ncm WHERE code = ?');
  const classes = new Map();
  for (const c of await db.prepare('SELECT id, code, name FROM tax_classes').all()) {
    classes.set(searchText(c.name), c);
    if (c.code) classes.set(searchText(c.code), c);
  }
  const seen = new Map();
  return mapSeries(rows, async row => {
    const barcode = clean(row.barcode);
    const sku = clean(row.sku);
    const item = { line: row.line, ref: barcode || sku, action: 'update', id: null, name: '', ncm: '', tax_class: '', tax_origin: '', warning: '', new_class: '' };
    try {
      if (SCI.test(barcode)) throw sciError('Código de barras', barcode);
      if (!barcode && !sku) throw new HttpError(400, 'sem código de barras nem SKU');
      if (row.ncm) item.ncm = ncmCode(clean(row.ncm));
      if (row.tax_class) item.tax_class = clean(row.tax_class, 120);
      if (row.tax_origin) {
        item.tax_origin = clean(row.tax_origin).charAt(0);
        if (!/^[0-8]$/.test(item.tax_origin)) throw new HttpError(400, `Origem inválida (${row.tax_origin}): use um código de 0 a 8`);
      }
      if (!item.ncm && !item.tax_class && !item.tax_origin) return { ...item, action: 'skip', error: 'nada a vincular nesta linha' };

      let classId;
      if (item.tax_class) {
        const c = classes.get(searchText(item.tax_class));
        if (c) classId = c.id;
        else if (createClasses) item.new_class = item.tax_class;
        else throw new HttpError(400, `Classificação não cadastrada: ${item.tax_class}`);
      }
      const id = await find(barcode, sku);
      if (!id) return { ...item, action: 'not_found', error: 'produto não encontrado' };
      const p = await current.get(id);
      item.id = id;
      item.name = p.name;

      // Vários códigos do mesmo produto na planilha: tudo bem se os valores forem iguais
      const key = JSON.stringify([item.ncm, item.tax_class && searchText(item.tax_class), item.tax_origin]);
      if (seen.has(id)) {
        if (seen.get(id).key !== key) throw new HttpError(400, `Valores diferentes para o mesmo produto (linha ${seen.get(id).line})`);
        return { ...item, action: 'unchanged', warning: `Mesmo produto da linha ${seen.get(id).line}` };
      }
      seen.set(id, { key, line: row.line });

      if (item.ncm && !(await ncmExists.get(item.ncm))) {
        if (!linkUnregistered) return { ...item, action: 'skip', error: `NCM ${item.ncm} não cadastrado` };
        item.warning = `NCM ${item.ncm} não cadastrado`;
      }
      const changed = (item.ncm && item.ncm !== p.ncm) || (item.tax_origin && item.tax_origin !== p.tax_origin)
        || item.new_class || (classId !== undefined && classId !== p.tax_class_id);
      if (!changed) item.action = 'unchanged';
      return item;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return { ...item, action: 'error', error: e.message };
    }
  });
}

const countPlan = (plan) => {
  const out = { total: plan.length, create: 0, update: 0, unchanged: 0, skip: 0, not_found: 0, error: 0 };
  for (const p of plan) out[p.action]++;
  return out;
};

// ---- Rotas ----------------------------------------------------------------------

export function mountTaxImport(admin, sheetUpload, { applyFields }) {
  async function readUpload(req, cols, isHeader, errorText) {
    if (!req.file) throw new HttpError(400, 'Envie o arquivo no campo "file"');
    try {
      return { file: req.file.originalname, ...parseSheet((await readGrid(req.file.buffer, req.file.originalname)).grid, cols, isHeader, errorText) };
    } catch (e) { throw new HttpError(400, e.message); }
  }
  const checkRows = (rows) => {
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Nenhuma linha para importar');
    if (rows.length > MAX_ROWS) throw new HttpError(400, `Máximo de ${MAX_ROWS} linhas por importação`);
  };

  admin.post('/ncm/import/preview', sheetUpload.single('file'), async (req, res, next) => {
    try {
      const s = await readUpload(req, NCM_COLS, (m) => m.code !== undefined, 'Não encontrei a coluna do NCM. O cabeçalho precisa ter "NCM" (e "Descrição" para os novos)');
      const plan = await planNcm(s.rows);
      res.json({ file: s.file, columns: s.columns, rows: s.rows, summary: countPlan(plan), plan });
    } catch (e) { next(e); }
  });

  admin.post('/ncm/import/apply', async (req, res) => {
    checkRows(req.body.rows);
    const plan = await planNcm(req.body.rows, { updateExisting: req.body.update_existing !== false });
    await tx(async () => {
      for (const p of plan) {
        if (p.action === 'create') {
          const data = { code: p.code, ...p.data, search: searchText(`${p.code} ${p.description}`) };
          const cols = Object.keys(data);
          await db.prepare(`INSERT INTO ncm (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data));
        } else if (p.action === 'update') {
          const data = { ...p.data, search: searchText(`${p.code} ${p.description}`) };
          const cols = Object.keys(data);
          await db.prepare(`UPDATE ncm SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(data), p.id);
        }
      }
    });
    res.json({ summary: countPlan(plan) });
  });

  admin.post('/ncm/link/preview', sheetUpload.single('file'), async (req, res, next) => {
    try {
      const s = await readUpload(req, LINK_COLS,
        (m) => (m.barcode !== undefined || m.sku !== undefined) && (m.ncm !== undefined || m.tax_class !== undefined || m.tax_origin !== undefined),
        'O cabeçalho precisa ter o código de barras (ou SKU) e ao menos uma destas colunas: "NCM", "Classificação" ou "Origem"');
      const plan = await planLink(s.rows, { createClasses: req.body.create_classes === 'true', linkUnregistered: req.body.link_unregistered !== 'false' });
      res.json({ file: s.file, columns: s.columns, rows: s.rows, summary: countPlan(plan), plan });
    } catch (e) { next(e); }
  });

  admin.post('/ncm/link/apply', async (req, res) => {
    checkRows(req.body.rows);
    const plan = await planLink(req.body.rows, { createClasses: req.body.create_classes === true, linkUnregistered: req.body.link_unregistered !== false });
    const classes = new Map();
    for (const c of await db.prepare('SELECT id, code, name FROM tax_classes').all()) {
      classes.set(searchText(c.name), c.id);
      if (c.code) classes.set(searchText(c.code), c.id);
    }
    const newClasses = new Set();
    await tx(async () => {
      for (const p of plan) {
        if (p.action !== 'update') continue;
        if (p.new_class && !classes.has(searchText(p.new_class))) {
          classes.set(searchText(p.new_class), Number((await db.prepare('INSERT INTO tax_classes (name) VALUES (?)').run(p.new_class)).lastInsertRowid));
          newClasses.add(p.new_class);
        }
        const data = {};
        if (p.ncm) data.ncm = p.ncm;
        if (p.tax_class) data.tax_class_id = classes.get(searchText(p.tax_class));
        if (p.tax_origin) data.tax_origin = p.tax_origin;
        // Vincular não conta como revisão do cadastro: não renova o prazo de atualização
        await applyFields(p.id, data, { group: null, renew: false });
      }
    });
    res.json({ summary: countPlan(plan), classes_created: [...newClasses] });
  });
}
