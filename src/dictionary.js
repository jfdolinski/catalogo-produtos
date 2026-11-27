// Dicionário de correções dos textos dos produtos (tela "Dicionário" do painel, permissão Produtos).
// Regra: campo + trecho procurado + texto novo. Vale sozinha em toda entrada de dados (text.js, cleanProductField)
// e, quando a pessoa confirma depois da prévia, nos produtos já cadastrados.
import { db, tx } from './db.js';
import { HttpError, iso } from './business.js';
import { applyDictionary, caseWords, cleanLine, PROVISIONAL_NAME, setDictionary } from './text.js';

export const DICT_FIELDS = { name: 'Nome', brand: 'Marca', manufacturer: 'Fabricante', category: 'Departamento' };
const MAX_LISTA = 300; // produtos mostrados na prévia
const BLOCO = 500;

const ruleOut = (r) => ({
  id: r.id, field: r.field, find: r.find, replace: r.replacement, whole_word: !!r.whole_word, active: !!r.active, created_by: r.created_by,
  applied_at: iso(r.applied_at), applied_count: r.applied_count, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

/** Carrega as regras ativas para a memória (text.js usa sem consultar o banco). */
export async function loadDictionary() {
  const rows = await db.all('SELECT * FROM name_rules WHERE active = 1 ORDER BY id');
  setDictionary(rows.map((r) => ({ id: r.id, field: r.field, find: r.find, replace: r.replacement, wholeWord: !!r.whole_word })));
  return rows.length;
}

function cleanRule(body) {
  const field = String(body.field ?? 'name');
  if (!DICT_FIELDS[field]) throw new HttpError(400, 'Campo inválido: use nome, marca, fabricante ou departamento');
  const find = cleanLine(body.find ?? '');
  const replace = cleanLine(body.replace ?? ''); // vazio = tirar o trecho
  if (!find) throw new HttpError(400, 'Informe o trecho a procurar');
  if (find.length > 120 || replace.length > 200) throw new HttpError(400, 'Texto longo demais (procurar até 120, trocar por até 200 caracteres)');
  if (find === replace) throw new HttpError(400, 'O texto novo é igual ao procurado');
  return { field, find, replace, wholeWord: body.whole_word === true || body.whole_word === 1 || body.whole_word === '1' };
}

// Valor como ficaria com as regras informadas (as já cadastradas + a candidata, na prévia)
function comRegras(field, value, rules) {
  const v = cleanLine(value);
  if (field === 'name' && v.startsWith(PROVISIONAL_NAME)) return v;
  return applyDictionary(field, caseWords(v), rules);
}

/** Produtos que mudariam com estas regras, só entre os que contêm o trecho procurado. */
async function previewChanges(field, find, rules) {
  const rows = await db.all(`SELECT id, ${field} AS v, name FROM products WHERE ${field} LIKE ? ORDER BY id`, `%${find}%`);
  const changes = [];
  for (const r of rows) {
    const before = String(r.v ?? '');
    const after = comRegras(field, before, rules);
    if (after !== before) changes.push({ id: r.id, name: r.name, before, after });
  }
  return { matches: rows.length, total: changes.length, items: changes.slice(0, MAX_LISTA) };
}

async function activeRules() {
  return (await db.all('SELECT * FROM name_rules WHERE active = 1 ORDER BY id')).map((r) => ({ id: r.id, field: r.field, find: r.find, replace: r.replacement, wholeWord: !!r.whole_word }));
}

export function mountDictionary(admin, { applyFields }) {
  admin.get('/dictionary', async (_req, res) => {
    const rows = await db.all('SELECT * FROM name_rules ORDER BY field, lower(find), id');
    res.json({ fields: DICT_FIELDS, items: rows.map(ruleOut) });
  });

  // Prévia de uma regra nova (ou editada: id) antes de salvar: quais produtos mudariam e como
  admin.post('/dictionary/preview', async (req, res) => {
    const rule = cleanRule(req.body);
    const id = req.body.id ? Number(req.body.id) : null;
    const rules = (await activeRules()).filter((r) => r.id !== id).concat({ id: id ?? 1e9, ...rule });
    res.json(await previewChanges(rule.field, rule.find, rules));
  });

  // Testar um texto qualquer com todas as regras ativas
  admin.post('/dictionary/test', async (req, res) => {
    const field = DICT_FIELDS[req.body.field] ? req.body.field : 'name';
    res.json({ field, before: String(req.body.text ?? ''), after: comRegras(field, String(req.body.text ?? ''), await activeRules()) });
  });

  admin.post('/dictionary', async (req, res) => {
    const rule = cleanRule(req.body);
    const dup = await db.get('SELECT id FROM name_rules WHERE field = ? AND lower(find) = lower(?)', rule.field, rule.find);
    if (dup) throw new HttpError(409, `Já existe uma regra para "${rule.find}" neste campo (#${dup.id})`);
    const r = await db.run('INSERT INTO name_rules (field, find, replacement, whole_word, created_by) VALUES (?, ?, ?, ?, ?)',
      rule.field, rule.find, rule.replace, rule.wholeWord ? 1 : 0, req.user?.login || req.user?.name || '');
    await loadDictionary();
    res.status(201).json(ruleOut(await db.get('SELECT * FROM name_rules WHERE id = ?', r.lastInsertRowid)));
  });

  admin.put('/dictionary/:id', async (req, res) => {
    const id = Number(req.params.id);
    const cur = await db.get('SELECT * FROM name_rules WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'Regra não encontrada');
    const rule = cleanRule({ field: cur.field, find: cur.find, replace: cur.replacement, whole_word: !!cur.whole_word, ...req.body });
    const dup = await db.get('SELECT id FROM name_rules WHERE field = ? AND lower(find) = lower(?) AND id <> ?', rule.field, rule.find, id);
    if (dup) throw new HttpError(409, `Já existe uma regra para "${rule.find}" neste campo (#${dup.id})`);
    const active = req.body.active === undefined ? cur.active : req.body.active ? 1 : 0;
    await db.run("UPDATE name_rules SET field = ?, find = ?, replacement = ?, whole_word = ?, active = ?, updated_at = datetime('now') WHERE id = ?",
      rule.field, rule.find, rule.replace, rule.wholeWord ? 1 : 0, active, id);
    await loadDictionary();
    res.json(ruleOut(await db.get('SELECT * FROM name_rules WHERE id = ?', id)));
  });

  admin.delete('/dictionary/:id', async (req, res) => {
    const r = await db.run('DELETE FROM name_rules WHERE id = ?', Number(req.params.id));
    if (!r.changes) throw new HttpError(404, 'Regra não encontrada');
    await loadDictionary();
    res.status(204).end();
  });

  // Aplica nos produtos já cadastrados que contêm o trecho (cada um passa pela gravação normal: espaços,
  // maiúsculas e todas as regras ativas). Não renova o prazo de atualização.
  admin.post('/dictionary/:id/apply', async (req, res) => {
    const id = Number(req.params.id);
    const rule = await db.get('SELECT * FROM name_rules WHERE id = ?', id);
    if (!rule) throw new HttpError(404, 'Regra não encontrada');
    if (!rule.active) throw new HttpError(400, 'A regra está desativada');
    const ids = (await db.all(`SELECT id FROM products WHERE ${rule.field} LIKE ? ORDER BY id`, `%${rule.find}%`)).map((r) => r.id);
    let changed = 0;
    for (let i = 0; i < ids.length; i += BLOCO) {
      await tx(async () => {
        for (const pid of ids.slice(i, i + BLOCO)) {
          const row = await db.get(`SELECT ${rule.field} AS v FROM products WHERE id = ?`, pid);
          if (row && (await applyFields(pid, { [rule.field]: String(row.v ?? '') }, { group: null, renew: false })).length) changed++;
        }
      });
    }
    await db.run("UPDATE name_rules SET applied_at = datetime('now'), applied_count = applied_count + ? WHERE id = ?", changed, id);
    res.json({ matches: ids.length, changed });
  });
}
