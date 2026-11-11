// Tributação por NCM: cadastro de NCM, classificações tributárias e regras por estado/classificação.
// O valor de cada campo é montado em camadas, da mais geral para a mais específica (vazio = herda da anterior):
// NCM -> classificação -> regra geral -> regra geral da classificação -> regra do estado -> regra do estado e classificação -> produto -> produto no estado
import { db, REFORM_FIELDS, STATE_TAX_FIELDS } from './db.js';
import { HttpError, tx, iso } from './business.js';
import { searchText } from './dcb.js';

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const FEDERAL_FIELDS = ['cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate'];
export const RULE_FIELDS = ['cfop', 'cst_icms', 'icms_rate', 'icms_reduction', 'fcp_rate', 'mva', 'icms_st_rate', ...FEDERAL_FIELDS, ...REFORM_FIELDS];
export const PRODUCT_OVERRIDES = ['cest', 'cfop', 'cst_icms', 'icms_rate', ...FEDERAL_FIELDS, ...REFORM_FIELDS];

export const LABELS = {
  code: 'NCM', cest: 'CEST', cfop: 'CFOP', cst_icms: 'CST/CSOSN do ICMS', icms_rate: 'Alíquota de ICMS', icms_reduction: 'Redução da base do ICMS',
  fcp_rate: 'Alíquota do FCP', mva: 'MVA', icms_st_rate: 'Alíquota do ICMS-ST', cst_ipi: 'CST do IPI', ipi_rate: 'Alíquota de IPI', cst_pis: 'CST do PIS',
  pis_rate: 'Alíquota de PIS', cst_cofins: 'CST da COFINS', cofins_rate: 'Alíquota de COFINS',
  cst_ibs_cbs: 'CST do IBS/CBS', c_class_trib: 'cClassTrib', ibs_uf_rate: 'IBS estadual', ibs_uf_reduction: 'Redução do IBS estadual',
  ibs_mun_rate: 'IBS municipal', ibs_mun_reduction: 'Redução do IBS municipal', cbs_rate: 'CBS', cbs_reduction: 'Redução da CBS',
  cst_is: 'CST do IS', c_class_trib_is: 'cClassTrib do IS', is_rate: 'Alíquota do IS', is_specific: 'IS específico por unidade',
};
export const RATES = ['icms_rate', 'icms_reduction', 'fcp_rate', 'icms_st_rate', 'ipi_rate', 'pis_rate', 'cofins_rate',
  'ibs_uf_rate', 'ibs_uf_reduction', 'ibs_mun_rate', 'ibs_mun_reduction', 'cbs_rate', 'cbs_reduction', 'is_rate'];
const DIGITS = { cest: [7, 7], cfop: [4, 4], cst_icms: [2, 3], cst_ipi: [2, 2], cst_pis: [2, 2], cst_cofins: [2, 2], cst_ibs_cbs: [3, 3], c_class_trib: [6, 6], cst_is: [3, 3], c_class_trib_is: [6, 6] };

// Valida e normaliza um campo fiscal (vírgula decimal, pontuação em códigos); cada erro diz o campo
export function fiscalValue(field, raw) {
  const v = clean(raw, 40);
  if (!v) return '';
  if (DIGITS[field]) {
    const d = v.replace(/\D/g, '');
    const [min, max] = DIGITS[field];
    if (d.length < min || d.length > max) throw new HttpError(400, `${LABELS[field]}: informe ${min === max ? min : `${min} a ${max}`} dígitos`);
    return d;
  }
  const n = v.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(n) || (RATES.includes(field) && Number(n) > 100) || Number(n) > 1000) throw new HttpError(400, `${LABELS[field]}: valor inválido (${v})`);
  return n;
}

export function cleanNcmCode(raw) {
  const c = String(raw ?? '').replace(/\D/g, '');
  if (c.length !== 8) throw new HttpError(400, 'NCM: informe 8 dígitos');
  return c;
}

export function checkTaxClass(raw) {
  if (raw === null || raw === '' || raw === undefined) return null;
  const id = Number(raw);
  if (!db.prepare('SELECT 1 FROM tax_classes WHERE id = ?').get(id)) throw new HttpError(400, 'Classificação tributária não encontrada');
  return id;
}

// ---- Cálculo --------------------------------------------------------------------

// product: valores da exceção do produto; productUf: exceção do produto no estado (opcionais). uf vazio = só as regras gerais.
export function resolveTax({ ncm, taxClassId, uf = '', product = null, productUf = null }) {
  const code = String(ncm ?? '').replace(/\D/g, '');
  const row = code ? db.prepare('SELECT * FROM ncm WHERE code = ?').get(code) : null;
  const cls = taxClassId ? db.prepare('SELECT * FROM tax_classes WHERE id = ?').get(Number(taxClassId)) : null;
  const values = {};
  const sources = {};
  const notes = [];
  const apply = (fields, data, label) => {
    for (const f of fields) if (data[f] !== '' && data[f] !== undefined && data[f] !== null) { values[f] = data[f]; sources[f] = label; }
  };
  if (row) {
    apply(['cest', ...FEDERAL_FIELDS, ...REFORM_FIELDS], row, `NCM ${row.code}`);
    if (row.notes) notes.push(row.notes);
  }
  if (cls) apply(REFORM_FIELDS, cls, `Classificação ${cls.name}`);
  if (row) {
    const rules = db.prepare(`SELECT * FROM ncm_rules WHERE ncm_id = ? AND uf IN (?, '') AND class_id IN (?, 0)
      ORDER BY uf <> '', class_id <> 0`).all(row.id, uf, cls?.id ?? 0);
    for (const r of rules) {
      const where = r.uf || 'todos os estados';
      apply(RULE_FIELDS, r, r.class_id ? `Regra ${where} · ${cls.name}` : `Regra ${where}`);
      if (r.notes) notes.push(r.notes);
    }
  }
  if (product) apply(PRODUCT_OVERRIDES, product, 'Exceção do produto');
  if (productUf) apply(STATE_TAX_FIELDS, productUf, `Exceção do produto em ${uf}`);
  return {
    uf,
    ncm: code ? { code, description: row?.description ?? '', registered: !!row, active: row ? !!row.active : false } : null,
    tax_class: cls ? { id: cls.id, code: cls.code, name: cls.name } : null,
    values,
    sources,
    notes,
  };
}

export function checkUf(raw) {
  const uf = String(raw ?? '').trim().toUpperCase();
  if (uf && !UFS.includes(uf)) throw new HttpError(400, `Estado inválido: ${uf}`);
  return uf;
}

const productUfRow = (productId, uf) => (uf ? db.prepare('SELECT * FROM product_tax_uf WHERE product_id = ? AND uf = ?').get(Number(productId), uf) ?? null : null);

export const productTax = (p, uf) => resolveTax({ ncm: p.ncm, taxClassId: p.tax_class_id, uf, product: p, productUf: productUfRow(p.id, uf) });

// Estados em que o produto tem exceção própria, com os campos preenchidos
function productUfList(productId) {
  return db.prepare('SELECT * FROM product_tax_uf WHERE product_id = ? ORDER BY uf').all(Number(productId))
    .map((r) => ({ uf: r.uf, fields: STATE_TAX_FIELDS.filter((f) => r[f] !== '').map((f) => ({ field: f, label: LABELS[f], value: r[f] })) }));
}

// ---- Rotas ----------------------------------------------------------------------

const buildSearch = (code, description) => searchText(`${code} ${description}`);

function ncmOut(n) {
  return { ...n, search: undefined, active: !!n.active, created_at: iso(n.created_at), updated_at: iso(n.updated_at) };
}

function cleanNcm(b, partial) {
  const out = {};
  if (b.code !== undefined) out.code = cleanNcmCode(b.code);
  else if (!partial) throw new HttpError(400, 'NCM: informe 8 dígitos');
  if (b.description !== undefined) out.description = clean(b.description, 500);
  if (!partial && !out.description) throw new HttpError(400, 'Informe a descrição do NCM');
  if ('description' in out && !out.description) throw new HttpError(400, 'A descrição do NCM é obrigatória');
  for (const f of ['cest', ...FEDERAL_FIELDS, ...REFORM_FIELDS]) if (b[f] !== undefined) out[f] = fiscalValue(f, b[f]);
  if (b.notes !== undefined) out.notes = clean(b.notes, 2000);
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

function cleanRule(b) {
  const out = {};
  for (const f of RULE_FIELDS) if (b[f] !== undefined) out[f] = fiscalValue(f, b[f]);
  if (b.notes !== undefined) out.notes = clean(b.notes, 1000);
  return out;
}

function cleanClass(b, partial) {
  const out = {};
  if (b.code !== undefined) out.code = clean(b.code, 40);
  if (b.name !== undefined) out.name = clean(b.name, 120);
  if (!partial && !out.name) throw new HttpError(400, 'Informe o nome da classificação');
  if ('name' in out && !out.name) throw new HttpError(400, 'O nome da classificação é obrigatório');
  for (const f of REFORM_FIELDS) if (b[f] !== undefined) out[f] = fiscalValue(f, b[f]);
  if (b.notes !== undefined) out.notes = clean(b.notes, 1000);
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

const getNcm = (id) => {
  const n = db.prepare('SELECT * FROM ncm WHERE id = ?').get(Number(id));
  if (!n) throw new HttpError(404, 'NCM não encontrado');
  return n;
};

const rulesOf = (ncmId) => db.prepare(`SELECT r.*, c.name AS class_name FROM ncm_rules r LEFT JOIN tax_classes c ON c.id = r.class_id
  WHERE r.ncm_id = ? ORDER BY r.uf <> '', r.uf, r.class_id <> 0, c.name`).all(ncmId);

const productsWith = (code) => db.prepare('SELECT COUNT(*) AS n FROM products WHERE ncm = ?').get(code).n;

export function mountTax(admin) {
  admin.get('/ncm', (req, res) => {
    const where = [];
    const params = [];
    const raw = String(req.query.q ?? '').trim();
    const q = /^[\d.\s-]+$/.test(raw) ? raw.replace(/\D/g, '') : searchText(raw);
    if (q) { where.push('n.search LIKE ?'); params.push(`%${q}%`); }
    if (req.query.active === '1') where.push('n.active = 1');
    if (req.query.active === '0') where.push('n.active = 0');
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ncm n ${sql}`).get(...params).n;
    const rows = db.prepare(`SELECT n.*, (SELECT COUNT(*) FROM ncm_rules r WHERE r.ncm_id = n.id) AS rules,
        (SELECT COUNT(*) FROM products p WHERE p.ncm = n.code) AS products
      FROM ncm n ${sql} ORDER BY n.code LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
    res.json({
      total, page, limit, items: rows.map(ncmOut),
      // Produtos ainda não vinculados a um NCM cadastrado
      products_no_ncm: db.prepare("SELECT COUNT(*) AS n FROM products WHERE ncm = ''").get().n,
      products_unregistered: db.prepare("SELECT COUNT(*) AS n FROM products p WHERE p.ncm <> '' AND NOT EXISTS (SELECT 1 FROM ncm n WHERE n.code = p.ncm)").get().n,
    });
  });

  admin.get('/ncm/:id', (req, res) => {
    const n = getNcm(req.params.id);
    res.json({ ...ncmOut(n), products: productsWith(n.code), rule_list: rulesOf(n.id) });
  });

  admin.post('/ncm', (req, res) => {
    const data = cleanNcm(req.body, false);
    if (db.prepare('SELECT 1 FROM ncm WHERE code = ?').get(data.code)) throw new HttpError(409, `O NCM ${data.code} já está cadastrado`);
    data.search = buildSearch(data.code, data.description);
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO ncm (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data)).lastInsertRowid;
    res.status(201).json({ ...ncmOut(getNcm(id)), products: productsWith(data.code), rule_list: [] });
  });

  admin.put('/ncm/:id', (req, res) => {
    const old = getNcm(req.params.id);
    const data = cleanNcm(req.body, true);
    if (data.code && data.code !== old.code) {
      if (db.prepare('SELECT 1 FROM ncm WHERE code = ?').get(data.code)) throw new HttpError(409, `O NCM ${data.code} já está cadastrado`);
      const used = productsWith(old.code);
      if (used) throw new HttpError(409, `O código não pode mudar: ${used} produto(s) usam o NCM ${old.code}`);
    }
    data.search = buildSearch(data.code ?? old.code, data.description ?? old.description);
    const cols = Object.keys(data);
    db.prepare(`UPDATE ncm SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(data), old.id);
    const n = getNcm(old.id);
    res.json({ ...ncmOut(n), products: productsWith(n.code), rule_list: rulesOf(n.id) });
  });

  admin.delete('/ncm/:id', (req, res) => {
    const n = getNcm(req.params.id);
    const used = productsWith(n.code);
    if (used) throw new HttpError(409, `Em uso por ${used} produto(s); para tirar das opções, desative em vez de excluir`);
    db.prepare('DELETE FROM ncm WHERE id = ?').run(n.id); // as regras vão junto
    res.status(204).end();
  });

  // Cria a mesma regra para um ou vários estados de uma vez. ufs: [''] = todos os estados (regra geral)
  admin.post('/ncm/:id/rules', (req, res) => {
    const n = getNcm(req.params.id);
    const ufs = Array.isArray(req.body.ufs) ? [...new Set(req.body.ufs.map(checkUf))] : [];
    if (!ufs.length) throw new HttpError(400, 'Escolha ao menos um estado (ou "todos os estados")');
    const classId = checkTaxClass(req.body.class_id) ?? 0;
    const data = cleanRule(req.body);
    if (!Object.entries(data).some(([k, v]) => k !== 'notes' && v)) throw new HttpError(400, 'Preencha ao menos um campo da regra');
    const taken = ufs.filter((uf) => db.prepare('SELECT 1 FROM ncm_rules WHERE ncm_id = ? AND uf = ? AND class_id = ?').get(n.id, uf, classId));
    if (taken.length) throw new HttpError(409, `Já existe regra desta classificação para: ${taken.map((u) => u || 'todos os estados').join(', ')}. Edite a regra existente ou desmarque.`);
    const cols = Object.keys(data);
    const ins = db.prepare(`INSERT INTO ncm_rules (ncm_id, uf, class_id${cols.map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?${cols.map(() => ', ?').join('')})`);
    tx(() => ufs.forEach((uf) => ins.run(n.id, uf, classId, ...Object.values(data))));
    res.status(201).json({ created: ufs.length, rule_list: rulesOf(n.id) });
  });

  admin.put('/ncm/rules/:ruleId', (req, res) => {
    const r = db.prepare('SELECT * FROM ncm_rules WHERE id = ?').get(Number(req.params.ruleId));
    if (!r) throw new HttpError(404, 'Regra não encontrada');
    const data = cleanRule(req.body);
    if (req.body.class_id !== undefined) data.class_id = checkTaxClass(req.body.class_id) ?? 0;
    const merged = { ...r, ...data };
    if (!RULE_FIELDS.some((f) => merged[f])) throw new HttpError(400, 'Preencha ao menos um campo da regra');
    if (db.prepare('SELECT 1 FROM ncm_rules WHERE ncm_id = ? AND uf = ? AND class_id = ? AND id <> ?').get(r.ncm_id, r.uf, merged.class_id, r.id)) {
      throw new HttpError(409, 'Já existe outra regra deste estado com esta classificação');
    }
    const cols = Object.keys(data);
    if (cols.length) db.prepare(`UPDATE ncm_rules SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(data), r.id);
    res.json({ rule_list: rulesOf(r.ncm_id) });
  });

  admin.delete('/ncm/rules/:ruleId', (req, res) => {
    const r = db.prepare('SELECT ncm_id FROM ncm_rules WHERE id = ?').get(Number(req.params.ruleId));
    if (!r) throw new HttpError(404, 'Regra não encontrada');
    db.prepare('DELETE FROM ncm_rules WHERE id = ?').run(Number(req.params.ruleId));
    res.json({ rule_list: rulesOf(r.ncm_id) });
  });

  // Classificações tributárias
  const classUse = (id) => ({
    products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE tax_class_id = ?').get(id).n,
    rules: db.prepare('SELECT COUNT(*) AS n FROM ncm_rules WHERE class_id = ?').get(id).n,
  });
  const classOut = (c) => ({ ...c, active: !!c.active, ...classUse(c.id) });

  admin.get('/tax-classes', (_req, res) => {
    res.json(db.prepare('SELECT * FROM tax_classes ORDER BY active DESC, name COLLATE NOCASE').all().map(classOut));
  });

  const nameTaken = (name, id) => db.prepare('SELECT 1 FROM tax_classes WHERE name = ? AND id <> ?').get(name, id ?? -1);

  admin.post('/tax-classes', (req, res) => {
    const data = cleanClass(req.body, false);
    if (nameTaken(data.name)) throw new HttpError(409, 'Já existe uma classificação com este nome');
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO tax_classes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data)).lastInsertRowid;
    res.status(201).json(classOut(db.prepare('SELECT * FROM tax_classes WHERE id = ?').get(id)));
  });

  admin.put('/tax-classes/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM tax_classes WHERE id = ?').get(id)) throw new HttpError(404, 'Classificação não encontrada');
    const data = cleanClass(req.body, true);
    if (data.name && nameTaken(data.name, id)) throw new HttpError(409, 'Já existe uma classificação com este nome');
    const cols = Object.keys(data);
    if (cols.length) db.prepare(`UPDATE tax_classes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(data), id);
    res.json(classOut(db.prepare('SELECT * FROM tax_classes WHERE id = ?').get(id)));
  });

  admin.delete('/tax-classes/:id', (req, res) => {
    const id = Number(req.params.id);
    const use = classUse(id);
    if (use.products || use.rules) throw new HttpError(409, `Em uso por ${use.products} produto(s) e ${use.rules} regra(s); para tirar das opções, desative em vez de excluir`);
    if (!db.prepare('DELETE FROM tax_classes WHERE id = ?').run(id).changes) throw new HttpError(404, 'Classificação não encontrada');
    res.status(204).end();
  });

  // Tributação que vale para o formulário do produto (usa os valores ainda não salvos)
  admin.post('/tax/resolve', (req, res) => {
    const uf = checkUf(req.body.uf);
    const id = req.body.product_id;
    res.json({
      ...resolveTax({ ncm: req.body.ncm, taxClassId: req.body.tax_class_id || null, uf, product: req.body.overrides || null, productUf: id ? productUfRow(id, uf) : null }),
      state_exceptions: id ? productUfList(id) : [],
    });
  });

  // Tira a exceção do produto em um estado: ele volta a seguir o NCM e as regras
  admin.delete('/products/:id/tax-uf/:uf', (req, res) => {
    const uf = checkUf(req.params.uf);
    db.prepare('DELETE FROM product_tax_uf WHERE product_id = ? AND uf = ?').run(Number(req.params.id), uf);
    res.json({ state_exceptions: productUfList(req.params.id) });
  });
}
