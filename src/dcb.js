// Lista DCB (Denominação Comum Brasileira): cadastro, importação por arquivo e vínculo com os medicamentos.
import { db, mapSeries } from './db.js';
import { HttpError, tx, iso } from './business.js';
import { readGrid, norm } from './importer.js';

const MAX_ROWS = 50000;

// Texto de busca: minúsculo e sem acentos
export const searchText = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const buildSearch = (d) => searchText([d.name, d.code, d.cas].filter(Boolean).join(' '));
const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/;

// ---- Leitura do arquivo -------------------------------------------------------

const COLS = {
  // Em ordem de preferência; "dcb" sozinho costuma ser o nome (ou o número, quando há outra coluna de nome)
  name: ['denominacao_comum_brasileira', 'denominacao_comum_brasileira_dcb', 'denominacao', 'nome_dcb', 'nome', 'principio_ativo', 'substancia', 'farmaco', 'insumo_farmaceutico_ativo', 'descricao', 'dcb'],
  code: ['numero_dcb', 'n_dcb', 'no_dcb', 'n_da_dcb', 'numero_da_dcb', 'codigo_dcb', 'cod_dcb', 'codigo', 'cod', 'numero', 'num', 'n', 'no'],
  cas: ['cas', 'n_cas', 'no_cas', 'numero_cas', 'n_do_cas', 'numero_do_cas', 'cas_number', 'cas_rn', 'registro_cas', 'numero_de_registro_cas'],
};

function findColumns(row) {
  const keys = row.map(norm);
  const pick = (list, taken = []) => {
    for (const alias of list) {
      const i = keys.findIndex((k, idx) => k === alias && !taken.includes(idx));
      if (i >= 0) return i;
    }
    return -1;
  };
  const name = pick(COLS.name);
  if (name < 0) return null;
  let code = pick(COLS.code, [name]);
  if (code < 0) code = pick(['dcb'], [name]);
  return { name, code, cas: pick(COLS.cas, [name, code]) };
}

// A lista oficial traz CAS convertido em data pelo Excel (2181-04-06 = 2181-04-6), hífens especiais e "96.5" no lugar de "96-5"
function readCas(raw) {
  const s = raw.replace(/[‐-―]/g, '-').trim();
  const m = /^(\d{2,7})-(\d{2})[-.]0?(\d)\.?$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : CAS_RE.exec(s)?.[0] || '';
}

// Listas oficiais costumam ter título antes do cabeçalho: procura o cabeçalho nas primeiras linhas
export function parseDcbGrid(grid) {
  let headerIdx = -1;
  let cols = null;
  for (let i = 0; i < Math.min(grid.length, 30) && !cols; i++) {
    cols = findColumns(grid[i]);
    if (cols) headerIdx = i;
  }
  if (!cols) throw new Error('Não encontrei a coluna do nome. O cabeçalho precisa ter "DCB", "Denominação" ou "Nome" (e, se houver, "Número DCB" e "CAS")');
  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r.some((c) => String(c).trim())) continue;
    const name = clean(r[cols.name]);
    const code = cols.code >= 0 ? clean(r[cols.code], 40) : '';
    const rawCas = cols.cas >= 0 ? clean(r[cols.cas], 200) : '';
    rows.push({ line: i + 1, name, code, cas: readCas(rawCas), raw_cas: rawCas });
  }
  return { rows, columns: { name: cols.name >= 0, code: cols.code >= 0, cas: cols.cas >= 0 } };
}

// O que cada linha faria (sem gravar): create | update | unchanged | error
function planImport(rows, { updateExisting = true } = {}) {
  const byCode = db.prepare('SELECT * FROM dcb WHERE code = ?');
  const byName = db.prepare('SELECT * FROM dcb WHERE name_key = ?');
  const seenName = new Map();
  const seenCode = new Map();
  return mapSeries(rows, async row => {
    const name = clean(row.name);
    const code = clean(row.code, 40);
    const cas = clean(row.cas, 40);
    const item = { line: row.line, name, code, cas, action: 'create', id: null, warning: '' };
    const fail = (error) => ({ ...item, action: 'error', error });
    if (!name) return fail('sem nome');
    if (/^[\d\s./-]+$/.test(name)) return fail(`nome inválido: "${name}" (a coluna de nome parece ter só números)`);
    const nameKey = searchText(name);
    // A lista oficial repete o registro numa linha de histórico: mesmo nome e número não é conflito, entra uma vez só
    const same = seenName.get(nameKey);
    if (same && same.code === code) return { ...item, action: 'unchanged', warning: `Mesma DCB da linha ${same.line}` };
    if (same) return fail(`nome repetido no arquivo (linha ${same.line})`);
    if (code && seenCode.has(code)) return fail(`número ${code} repetido no arquivo (linha ${seenCode.get(code)})`);
    seenName.set(nameKey, { line: row.line, code });
    if (code) seenCode.set(code, row.line);
    if (row.raw_cas && !cas && !/^(n[ãa]o|-|—|n\/?a|\[?ref)/i.test(row.raw_cas)) item.warning = `CAS ignorado: "${row.raw_cas}"`;

    const withCode = code ? await byCode.get(code) : null;
    const withName = await byName.get(nameKey);
    if (withCode && withName && withCode.id !== withName.id) {
      return fail(`conflito: o número ${code} é de "${withCode.name}", e este nome já existe com outro número`);
    }
    const found = withCode || withName;
    if (!found) return item;
    item.id = found.id;
    // Célula vazia não apaga o que já existe
    const next = { name, code: code || found.code || '', cas: cas || found.cas };
    const changed = next.name !== found.name || next.code !== (found.code || '') || next.cas !== found.cas;
    item.action = changed && updateExisting ? 'update' : 'unchanged';
    if (changed) item.before = { name: found.name, code: found.code || '', cas: found.cas };
    Object.assign(item, { name: next.name, code: next.code, cas: next.cas });
    return item;
  });
}

const countPlan = (plan) => {
  const out = { total: plan.length, create: 0, update: 0, unchanged: 0, error: 0 };
  for (const p of plan) out[p.action]++;
  return out;
};

// ---- Vínculo com os produtos --------------------------------------------------

// Grava os princípios ativos do produto. Retorna true se mudou algo.
export async function replaceProductDcb(productId, list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'dcb deve ser uma lista');
  const items = list.map((x) => ({ id: Number(x.id), concentration: clean(x.concentration, 100) }));
  if (new Set(items.map((x) => x.id)).size !== items.length) throw new HttpError(400, 'Princípio ativo repetido na lista');
  for (const x of items) {
    if (!(await db.prepare('SELECT 1 FROM dcb WHERE id = ?').get(x.id))) throw new HttpError(400, `Princípio ativo #${x.id} não encontrado na lista DCB`);
  }
  const current = await db.prepare('SELECT dcb_id AS id, concentration FROM product_dcb WHERE product_id = ? ORDER BY position, dcb_id').all(productId);
  if (JSON.stringify(current.map((c) => ({ ...c }))) === JSON.stringify(items)) return false;
  await db.prepare('DELETE FROM product_dcb WHERE product_id = ?').run(productId);
  const ins = db.prepare('INSERT INTO product_dcb (product_id, dcb_id, concentration, position) VALUES (?, ?, ?, ?)');
  for (const [i, x] of items.entries()) await ins.run(productId, x.id, x.concentration, i);
  return true;
}

// Princípios ativos de vários produtos de uma vez (ids: até 500 por consulta)
export const activesOf = async ids => await db.prepare(`
  SELECT pd.product_id, d.id, d.code, d.name, d.cas, pd.concentration FROM product_dcb pd JOIN dcb d ON d.id = pd.dcb_id
  WHERE pd.product_id IN (${ids.map(() => '?').join(',')}) ORDER BY pd.position, d.id`).all(...ids);

// ---- Rotas --------------------------------------------------------------------

function dcbOut(d) {
  return { id: d.id, code: d.code || '', name: d.name, cas: d.cas, active: !!d.active, products: d.products ?? undefined, created_at: iso(d.created_at), updated_at: iso(d.updated_at) };
}

function cleanDcb(b, partial) {
  const out = {};
  if (b.name !== undefined) out.name = clean(b.name);
  if (!partial && !out.name) throw new HttpError(400, 'Informe o nome (DCB)');
  if ('name' in out && !out.name) throw new HttpError(400, 'O nome (DCB) é obrigatório');
  if (b.code !== undefined) out.code = clean(b.code, 40) || null;
  if (b.cas !== undefined) {
    out.cas = clean(b.cas, 40);
    if (out.cas && !CAS_RE.test(out.cas)) throw new HttpError(400, 'CAS inválido (formato: 50-78-2)');
  }
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

async function checkUnique(data, id) {
  if (data.name) {
    const d = await db.prepare('SELECT id FROM dcb WHERE name_key = ? AND id <> ?').get(searchText(data.name), id ?? -1);
    if (d) throw new HttpError(409, `Já existe uma DCB com este nome (#${d.id})`);
  }
  if (data.code) {
    const d = await db.prepare('SELECT name FROM dcb WHERE code = ? AND id <> ?').get(data.code, id ?? -1);
    if (d) throw new HttpError(409, `O número ${data.code} já é de "${d.name}"`);
  }
}

export function mountDcb(admin, sheetUpload) {
  // ?q= (nome, número ou CAS; sem acentos) &active=1 &page= &limit=
  admin.get('/dcb', async (req, res) => {
    const where = [];
    const params = [];
    const q = searchText(req.query.q);
    if (q) { where.push('d.search LIKE ?'); params.push(`%${q}%`); }
    if (req.query.active === '1') where.push('d.active = 1');
    if (req.query.active === '0') where.push('d.active = 0');
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM dcb d ${sql}`).get(...params)).n;
    // Quem começa com o texto digitado vem primeiro
    const rows = await db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM product_dcb pd WHERE pd.dcb_id = d.id) AS products FROM dcb d ${sql}
      ORDER BY ${q ? '(d.search LIKE ?) DESC, ' : ''}d.name COLLATE NOCASE, d.id LIMIT ? OFFSET ?`)
      .all(...params, ...(q ? [`${q}%`] : []), limit, (page - 1) * limit);
    res.json({ total, page, limit, items: rows.map(dcbOut) });
  });

  admin.post('/dcb', async (req, res) => {
    const data = cleanDcb(req.body, false);
    await checkUnique(data);
    Object.assign(data, { name_key: searchText(data.name), search: buildSearch(data) });
    const cols = Object.keys(data);
    const id = (await db.prepare(`INSERT INTO dcb (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data))).lastInsertRowid;
    res.status(201).json(dcbOut(await db.prepare('SELECT * FROM dcb WHERE id = ?').get(id)));
  });

  admin.put('/dcb/:id', async (req, res) => {
    const id = Number(req.params.id);
    const old = await db.prepare('SELECT * FROM dcb WHERE id = ?').get(id);
    if (!old) throw new HttpError(404, 'DCB não encontrada');
    const data = cleanDcb(req.body, true);
    await checkUnique(data, id);
    Object.assign(data, { name_key: searchText(data.name ?? old.name), search: buildSearch({ ...old, ...data }) });
    const cols = Object.keys(data);
    await db.prepare(`UPDATE dcb SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(data), id);
    res.json(dcbOut(await db.prepare('SELECT * FROM dcb WHERE id = ?').get(id)));
  });

  admin.delete('/dcb/:id', async (req, res) => {
    const id = Number(req.params.id);
    const used = (await db.prepare('SELECT COUNT(*) AS n FROM product_dcb WHERE dcb_id = ?').get(id)).n;
    if (used) throw new HttpError(409, `Em uso por ${used} produto(s); para tirar das opções, desative em vez de excluir`);
    if (!(await db.prepare('DELETE FROM dcb WHERE id = ?').run(id)).changes) throw new HttpError(404, 'DCB não encontrada');
    res.status(204).end();
  });

  admin.post('/dcb/import/preview', sheetUpload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw new HttpError(400, 'Envie o arquivo no campo "file"');
      let parsed;
      try { parsed = parseDcbGrid((await readGrid(req.file.buffer, req.file.originalname)).grid); }
      catch (e) { throw new HttpError(400, e.message); }
      if (!parsed.rows.length) throw new HttpError(400, 'Nenhuma linha com dados depois do cabeçalho');
      if (parsed.rows.length > MAX_ROWS) throw new HttpError(400, `Arquivo com mais de ${MAX_ROWS} linhas`);
      const plan = await planImport(parsed.rows);
      res.json({ file: req.file.originalname, columns: parsed.columns, rows: parsed.rows, summary: countPlan(plan), plan });
    } catch (e) { next(e); }
  });

  admin.post('/dcb/import/apply', async (req, res) => {
    const { rows, update_existing: updateExisting = true } = req.body;
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Nenhuma linha para importar');
    if (rows.length > MAX_ROWS) throw new HttpError(400, `Máximo de ${MAX_ROWS} linhas por importação`);
    const plan = await planImport(rows, { updateExisting: updateExisting !== false });
    const ins = db.prepare('INSERT INTO dcb (code, name, name_key, cas, search) VALUES (?, ?, ?, ?, ?)');
    const upd = db.prepare("UPDATE dcb SET code = ?, name = ?, name_key = ?, cas = ?, search = ?, updated_at = datetime('now') WHERE id = ?");
    await tx(async () => {
      for (const p of plan) {
        if (p.action === 'create') await ins.run(p.code || null, p.name, searchText(p.name), p.cas, buildSearch(p));
        else if (p.action === 'update') await upd.run(p.code || null, p.name, searchText(p.name), p.cas, buildSearch(p), p.id);
      }
    });
    res.json({ summary: countPlan(plan), errors: plan.filter((p) => p.action === 'error').map((p) => ({ line: p.line, error: p.error })) });
  });
}
