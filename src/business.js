// Módulos de gestão: usuários, empresas (cadastro por CNPJ), planos, consumo da API e faturas.
import crypto from 'node:crypto';
import { db, getSecret } from './db.js';
import { MODULES, hashPassword, publicUser, sha256 } from './auth.js';
import { lookupCnpj, validCnpj, onlyDigits, formatCnpj } from './cnpj.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Datas do SQLite ('AAAA-MM-DD HH:MM:SS', UTC) -> ISO
export const iso = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toISOString() : null);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

// ---------------------------------------------------------------------------
// Chave de acesso das empresas à API pública e contagem de consumo
// ---------------------------------------------------------------------------

export function companyByKey(key) {
  if (!key) return null;
  return db.prepare('SELECT id, razao_social, nome_fantasia, status FROM companies WHERE api_key_hash = ?').get(sha256(key)) || null;
}

export function countUsage(companyId) {
  db.prepare(`INSERT INTO company_usage (company_id, day, hits) VALUES (?, date('now', 'localtime'), 1)
    ON CONFLICT(company_id, day) DO UPDATE SET hits = hits + 1`).run(companyId);
}

const usageInPeriod = (companyId, period) => db.prepare(
  "SELECT COALESCE(SUM(hits), 0) AS n FROM company_usage WHERE company_id = ? AND substr(day, 1, 7) = ?",
).get(companyId, period).n;

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const validPeriod = (p) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(p || '') ? p : null);
const today = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD local

// Vencimento: dia escolhido do mês seguinte ao período (limitado ao último dia do mês)
function dueDate(period, day) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(y, m + 1, 0).getDate();
  const d = new Date(y, m, Math.min(Math.max(day || 10, 1), last));
  return d.toLocaleDateString('sv-SE');
}

function calcInvoice(company, plan, period) {
  const usage = usageInPeriod(company.id, period);
  const included = plan?.included || 0;
  const extraUsage = plan && plan.extra_price > 0 ? Math.max(usage - included, 0) : 0;
  const monthly = money(plan?.monthly);
  const extraAmount = money(extraUsage * (plan?.extra_price || 0));
  return {
    plan_name: plan?.name || '', usage, included, extra_usage: extraUsage, monthly,
    extra_price: plan?.extra_price || 0, extra_amount: extraAmount, total: money(monthly + extraAmount),
    due_date: dueDate(period, company.due_day),
  };
}

function invoiceOut(r) {
  const overdue = r.status === 'aberta' && r.due_date < today();
  return { ...r, created_at: iso(r.created_at), paid_at: iso(r.paid_at), overdue, cnpj_formatted: r.cnpj ? formatCnpj(r.cnpj) : undefined };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export function mountBusiness(admin) {
  // ---- Usuários ----------------------------------------------------------------
  const USER_FIELDS = 'id, name, login, permissions, is_admin, active, created_at, updated_at, last_login_at';
  const userOut = (u) => ({ ...publicUser(u), created_at: iso(u.created_at), last_login_at: iso(u.last_login_at) });

  admin.get('/me', (req, res) => res.json({ user: req.user, modules: MODULES }));

  admin.put('/me/password', (req, res) => {
    if (req.user.master) throw new HttpError(400, 'O acesso por token não tem senha; entre com um usuário');
    const pw = String(req.body.password || '');
    if (pw.length < 8) throw new HttpError(400, 'A nova senha deve ter ao menos 8 caracteres');
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(pw), req.user.id);
    res.json({ ok: true });
  });

  admin.get('/users', (_req, res) => {
    res.json({ modules: MODULES, items: db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY name COLLATE NOCASE`).all().map(userOut) });
  });

  function cleanUser(b, isNew) {
    const out = {};
    if (b.name !== undefined) out.name = str(b.name, 120);
    if (b.login !== undefined) out.login = str(b.login, 60).toLowerCase();
    if (isNew && !out.name) throw new HttpError(400, 'Informe o nome');
    if (isNew && !out.login) throw new HttpError(400, 'Informe o login');
    if ('login' in out && !/^[a-z0-9._@-]{3,60}$/.test(out.login)) throw new HttpError(400, 'Login: use de 3 a 60 letras, números, ponto, hífen ou @');
    if (b.permissions !== undefined) {
      if (!Array.isArray(b.permissions)) throw new HttpError(400, 'permissions deve ser uma lista');
      out.permissions = JSON.stringify([...new Set(b.permissions.filter((p) => p in MODULES))]);
    }
    if (b.is_admin !== undefined) out.is_admin = b.is_admin ? 1 : 0;
    if (b.active !== undefined) out.active = b.active ? 1 : 0;
    if (b.password !== undefined && b.password !== '') {
      if (String(b.password).length < 8) throw new HttpError(400, 'A senha deve ter ao menos 8 caracteres');
      out.password_hash = hashPassword(b.password);
    } else if (isNew) throw new HttpError(400, 'Informe a senha inicial');
    return out;
  }

  const loginTaken = (login, id) => db.prepare('SELECT 1 FROM users WHERE login = ? AND id <> ?').get(login, id ?? -1);

  admin.post('/users', (req, res) => {
    const data = cleanUser(req.body, true);
    if (loginTaken(data.login)) throw new HttpError(409, `O login ${data.login} já existe`);
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data)).lastInsertRowid;
    res.status(201).json(userOut(db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id)));
  });

  admin.put('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'Usuário não encontrado');
    const data = cleanUser(req.body, false);
    if (data.login && loginTaken(data.login, id)) throw new HttpError(409, `O login ${data.login} já existe`);
    if (id === req.user.id && (data.active === 0 || data.is_admin === 0)) {
      throw new HttpError(400, 'Você não pode desativar nem tirar o administrador do seu próprio usuário');
    }
    const cols = Object.keys(data);
    if (cols.length) {
      db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(data), id);
    }
    // Desativou ou trocou a senha: derruba as sessões abertas desse usuário (exceto a própria)
    if (data.active === 0 || data.password_hash) db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id <> ?').run(id, req.user.id);
    res.json(userOut(db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id)));
  });

  admin.delete('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'Você não pode excluir o próprio usuário');
    if (!db.prepare('DELETE FROM users WHERE id = ?').run(id).changes) throw new HttpError(404, 'Usuário não encontrado');
    res.status(204).end();
  });

  // ---- Planos ------------------------------------------------------------------
  const planOut = (p) => ({ ...p, active: !!p.active, companies: db.prepare('SELECT COUNT(*) AS n FROM companies WHERE plan_id = ?').get(p.id).n });

  admin.get('/plans', (_req, res) => res.json(db.prepare('SELECT * FROM plans ORDER BY active DESC, monthly, name').all().map(planOut)));

  function cleanPlan(b, isNew) {
    const out = {};
    if (b.name !== undefined) out.name = str(b.name, 80);
    if (isNew && !out.name) throw new HttpError(400, 'Informe o nome do plano');
    for (const [k, label] of [['monthly', 'Mensalidade'], ['extra_price', 'Valor por consulta excedente']]) {
      if (b[k] === undefined) continue;
      const n = Number(String(b[k]).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new HttpError(400, `${label}: valor inválido`);
      out[k] = k === 'monthly' ? money(n) : Math.round(n * 1e6) / 1e6;
    }
    if (b.included !== undefined) {
      const n = Number(b.included);
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'Consultas incluídas: informe um número inteiro');
      out.included = n;
    }
    if (b.active !== undefined) out.active = b.active ? 1 : 0;
    return out;
  }

  admin.post('/plans', (req, res) => {
    const data = cleanPlan(req.body, true);
    if (db.prepare('SELECT 1 FROM plans WHERE name = ?').get(data.name)) throw new HttpError(409, 'Já existe um plano com esse nome');
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO plans (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data)).lastInsertRowid;
    res.status(201).json(planOut(db.prepare('SELECT * FROM plans WHERE id = ?').get(id)));
  });

  admin.put('/plans/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM plans WHERE id = ?').get(id)) throw new HttpError(404, 'Plano não encontrado');
    const data = cleanPlan(req.body, false);
    if (data.name && db.prepare('SELECT 1 FROM plans WHERE name = ? AND id <> ?').get(data.name, id)) throw new HttpError(409, 'Já existe um plano com esse nome');
    const cols = Object.keys(data);
    if (cols.length) db.prepare(`UPDATE plans SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(data), id);
    res.json(planOut(db.prepare('SELECT * FROM plans WHERE id = ?').get(id)));
  });

  admin.delete('/plans/:id', (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM companies WHERE plan_id = ?').get(id)) throw new HttpError(409, 'Há empresas neste plano; troque o plano delas ou desative o plano');
    if (!db.prepare('DELETE FROM plans WHERE id = ?').run(id).changes) throw new HttpError(404, 'Plano não encontrado');
    res.status(204).end();
  });

  // ---- Empresas ----------------------------------------------------------------
  const COMPANY_FIELDS = ['razao_social', 'nome_fantasia', 'situacao', 'abertura', 'natureza_juridica', 'porte', 'cnae',
    'inscricao_estadual', 'ie_situacao', 'logradouro', 'numero', 'complemento', 'bairro', 'municipio', 'uf', 'cep',
    'telefone', 'email', 'contato_nome', 'contato_email', 'contato_telefone', 'notes', 'data_source'];
  const STATUSES = ['ativa', 'suspensa', 'cancelada'];

  function companyOut(c) {
    const plan = c.plan_id ? db.prepare('SELECT * FROM plans WHERE id = ?').get(c.plan_id) : null;
    const period = currentPeriod();
    const { api_key_hash, ...rest } = c;
    return {
      ...rest,
      cnpj_formatted: formatCnpj(c.cnpj),
      has_api_key: !!api_key_hash,
      plan: plan ? { id: plan.id, name: plan.name, monthly: plan.monthly, included: plan.included, extra_price: plan.extra_price } : null,
      usage_month: usageInPeriod(c.id, period),
      usage_today: db.prepare("SELECT COALESCE(SUM(hits), 0) AS n FROM company_usage WHERE company_id = ? AND day = date('now', 'localtime')").get(c.id).n,
      open_invoices: db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE company_id = ? AND status = 'aberta'").get(c.id).n,
      overdue_invoices: db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE company_id = ? AND status = 'aberta' AND due_date < ?").get(c.id, today()).n,
      data_fetched_at: iso(c.data_fetched_at), created_at: iso(c.created_at), updated_at: iso(c.updated_at),
    };
  }

  const getCompany = (id) => {
    const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(id));
    if (!c) throw new HttpError(404, 'Empresa não encontrada');
    return c;
  };

  function cleanCompany(b, isNew) {
    const out = {};
    if (b.cnpj !== undefined) {
      const c = onlyDigits(b.cnpj);
      if (!validCnpj(c)) throw new HttpError(400, 'CNPJ inválido (confira os dígitos)');
      out.cnpj = c;
    } else if (isNew) throw new HttpError(400, 'Informe o CNPJ');
    for (const f of COMPANY_FIELDS) if (b[f] !== undefined) out[f] = str(b[f], f === 'notes' ? 4000 : 300);
    if ('uf' in out) out.uf = out.uf.toUpperCase().slice(0, 2);
    if ('cep' in out) out.cep = onlyDigits(out.cep).slice(0, 8);
    if (isNew && !out.razao_social) throw new HttpError(400, 'Informe a razão social (ou busque pelo CNPJ)');
    if ('razao_social' in out && !out.razao_social) throw new HttpError(400, 'A razão social é obrigatória');
    if (b.plan_id !== undefined) {
      out.plan_id = b.plan_id ? Number(b.plan_id) : null;
      if (out.plan_id && !db.prepare('SELECT 1 FROM plans WHERE id = ?').get(out.plan_id)) throw new HttpError(400, 'Plano não encontrado');
    }
    if (b.due_day !== undefined) {
      const d = Number(b.due_day);
      if (!Number.isInteger(d) || d < 1 || d > 31) throw new HttpError(400, 'Dia de vencimento: de 1 a 31');
      out.due_day = d;
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Situação inválida');
      out.status = b.status;
    }
    if (b.data_fetched === true) out.data_fetched_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    return out;
  }

  // Busca os dados do CNPJ (Receita; IE com token CNPJá) e informa se já está cadastrado
  admin.get('/cnpj/:cnpj', async (req, res, next) => {
    try {
      const c = onlyDigits(req.params.cnpj);
      if (!validCnpj(c)) throw new HttpError(400, 'CNPJ inválido (confira os dígitos)');
      const existing = db.prepare('SELECT id, razao_social FROM companies WHERE cnpj = ?').get(c);
      const r = await lookupCnpj(c, { cnpjaToken: getSecret('cnpja_token') });
      res.json({ cnpj: c, cnpj_formatted: formatCnpj(c), existing: existing || null, ie_auto: !!getSecret('cnpja_token'), ...r });
    } catch (e) { next(e.status ? new HttpError(e.status, e.message) : e); }
  });

  admin.get('/companies', (req, res) => {
    const where = [];
    const params = [];
    const q = str(req.query.q);
    if (q) {
      where.push('(razao_social LIKE ? OR nome_fantasia LIKE ? OR cnpj LIKE ? OR municipio LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, `%${onlyDigits(q) || q}%`, like);
    }
    if (STATUSES.includes(req.query.status)) { where.push('status = ?'); params.push(req.query.status); }
    const rows = db.prepare(`SELECT * FROM companies ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY status = 'ativa' DESC, COALESCE(NULLIF(nome_fantasia, ''), razao_social) COLLATE NOCASE`).all(...params);
    res.json({ items: rows.map(companyOut) });
  });

  admin.get('/companies/:id', (req, res) => {
    const c = companyOut(getCompany(req.params.id));
    // Consumo dos últimos 12 meses e faturas
    c.usage_months = db.prepare(`SELECT substr(day, 1, 7) AS period, SUM(hits) AS hits FROM company_usage
      WHERE company_id = ? GROUP BY 1 ORDER BY 1 DESC LIMIT 12`).all(c.id);
    c.invoices = db.prepare('SELECT * FROM invoices WHERE company_id = ? ORDER BY period DESC').all(c.id).map(invoiceOut);
    res.json(c);
  });

  admin.post('/companies', (req, res) => {
    const data = cleanCompany(req.body, true);
    const dup = db.prepare('SELECT id FROM companies WHERE cnpj = ?').get(data.cnpj);
    if (dup) throw new HttpError(409, `Este CNPJ já está cadastrado (empresa #${dup.id})`);
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO companies (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data)).lastInsertRowid;
    res.status(201).json(companyOut(getCompany(id)));
  });

  admin.put('/companies/:id', (req, res) => {
    const id = getCompany(req.params.id).id;
    const data = cleanCompany(req.body, false);
    if (data.cnpj) {
      const dup = db.prepare('SELECT id FROM companies WHERE cnpj = ? AND id <> ?').get(data.cnpj, id);
      if (dup) throw new HttpError(409, `Este CNPJ já está cadastrado (empresa #${dup.id})`);
    }
    const cols = Object.keys(data);
    if (cols.length) db.prepare(`UPDATE companies SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(data), id);
    res.json(companyOut(getCompany(id)));
  });

  admin.delete('/companies/:id', (req, res) => {
    const id = getCompany(req.params.id).id;
    if (db.prepare('SELECT 1 FROM invoices WHERE company_id = ?').get(id)) {
      throw new HttpError(409, 'A empresa tem faturas; para manter o histórico, mude a situação para "cancelada"');
    }
    db.prepare('DELETE FROM companies WHERE id = ?').run(id);
    res.status(204).end();
  });

  // Gera (ou troca) a chave de acesso à API. A chave completa só é mostrada nesta resposta.
  admin.post('/companies/:id/api-key', (req, res) => {
    const id = getCompany(req.params.id).id;
    const key = `cat_${crypto.randomBytes(20).toString('hex')}`;
    db.prepare("UPDATE companies SET api_key_hash = ?, api_key_prefix = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sha256(key), key.slice(0, 10), id);
    res.json({ api_key: key, company: companyOut(getCompany(id)) });
  });

  admin.delete('/companies/:id/api-key', (req, res) => {
    const id = getCompany(req.params.id).id;
    db.prepare("UPDATE companies SET api_key_hash = NULL, api_key_prefix = '', updated_at = datetime('now') WHERE id = ?").run(id);
    res.json(companyOut(getCompany(id)));
  });

  // ---- Cobrança ----------------------------------------------------------------
  // Resumo do período: consumo e valor estimado de cada empresa, com a fatura se já foi gerada
  admin.get('/billing', (req, res) => {
    const period = validPeriod(req.query.period) || currentPeriod();
    const companies = db.prepare("SELECT * FROM companies WHERE status <> 'cancelada' OR id IN (SELECT company_id FROM invoices WHERE period = ?) ORDER BY COALESCE(NULLIF(nome_fantasia, ''), razao_social) COLLATE NOCASE").all(period);
    const items = companies.map((c) => {
      const plan = c.plan_id ? db.prepare('SELECT * FROM plans WHERE id = ?').get(c.plan_id) : null;
      const inv = db.prepare('SELECT * FROM invoices WHERE company_id = ? AND period = ?').get(c.id, period);
      return {
        company: { id: c.id, name: c.nome_fantasia || c.razao_social, razao_social: c.razao_social, cnpj_formatted: formatCnpj(c.cnpj), status: c.status, has_api_key: !!c.api_key_hash },
        plan: plan ? { id: plan.id, name: plan.name } : null,
        estimate: calcInvoice(c, plan, period),
        invoice: inv ? invoiceOut(inv) : null,
      };
    });
    const sum = (f) => money(items.reduce((s, i) => s + f(i), 0));
    res.json({
      period,
      current: period === currentPeriod(),
      items,
      totals: {
        usage: items.reduce((s, i) => s + i.estimate.usage, 0),
        estimate: sum((i) => (i.invoice && i.invoice.status !== 'cancelada' ? 0 : i.plan ? i.estimate.total : 0)),
        invoiced: sum((i) => (i.invoice && i.invoice.status !== 'cancelada' ? i.invoice.total : 0)),
        paid: sum((i) => (i.invoice?.status === 'paga' ? i.invoice.total : 0)),
        open: sum((i) => (i.invoice?.status === 'aberta' ? i.invoice.total : 0)),
      },
      overdue: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM invoices WHERE status = 'aberta' AND due_date < ?").get(today()),
    });
  });

  // Gera as faturas do período para as empresas ativas com plano. recalcular: refaz as faturas ainda abertas.
  admin.post('/invoices/generate', (req, res) => {
    const period = validPeriod(req.body.period);
    if (!period) throw new HttpError(400, 'Informe o período no formato AAAA-MM');
    if (period > currentPeriod()) throw new HttpError(400, 'Não é possível faturar um mês futuro');
    const ids = Array.isArray(req.body.company_ids) ? req.body.company_ids.map(Number) : null;
    const out = { created: 0, updated: 0, skipped: 0, without_plan: 0 };
    tx(() => {
      for (const c of db.prepare("SELECT * FROM companies WHERE status = 'ativa'").all()) {
        if (ids && !ids.includes(c.id)) continue;
        const plan = c.plan_id ? db.prepare('SELECT * FROM plans WHERE id = ?').get(c.plan_id) : null;
        if (!plan) { out.without_plan++; continue; }
        const inv = calcInvoice(c, plan, period);
        const old = db.prepare('SELECT id, status, discount FROM invoices WHERE company_id = ? AND period = ?').get(c.id, period);
        if (old) {
          if (!req.body.recalcular || old.status !== 'aberta') { out.skipped++; continue; }
          db.prepare(`UPDATE invoices SET plan_name = ?, usage = ?, included = ?, extra_usage = ?, monthly = ?, extra_price = ?,
            extra_amount = ?, total = ?, due_date = ? WHERE id = ?`)
            .run(inv.plan_name, inv.usage, inv.included, inv.extra_usage, inv.monthly, inv.extra_price, inv.extra_amount,
              money(Math.max(inv.total - old.discount, 0)), inv.due_date, old.id);
          out.updated++;
        } else {
          db.prepare(`INSERT INTO invoices (company_id, period, plan_name, usage, included, extra_usage, monthly, extra_price, extra_amount, total, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(c.id, period, inv.plan_name, inv.usage, inv.included, inv.extra_usage, inv.monthly, inv.extra_price, inv.extra_amount, inv.total, inv.due_date);
          out.created++;
        }
      }
    });
    res.json(out);
  });

  admin.get('/invoices/:id', (req, res) => {
    const r = db.prepare(`SELECT i.*, c.razao_social, c.nome_fantasia, c.cnpj, c.logradouro, c.numero, c.complemento, c.bairro,
      c.municipio, c.uf, c.cep, c.email, c.contato_email FROM invoices i JOIN companies c ON c.id = i.company_id WHERE i.id = ?`).get(Number(req.params.id));
    if (!r) throw new HttpError(404, 'Fatura não encontrada');
    res.json(invoiceOut(r));
  });

  // Baixa/estorno/cancelamento e desconto
  admin.put('/invoices/:id', (req, res) => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(req.params.id));
    if (!inv) throw new HttpError(404, 'Fatura não encontrada');
    const set = {};
    if (req.body.status !== undefined) {
      if (!['aberta', 'paga', 'cancelada'].includes(req.body.status)) throw new HttpError(400, 'Situação inválida');
      set.status = req.body.status;
      set.paid_at = req.body.status === 'paga' ? (inv.paid_at || new Date().toISOString().slice(0, 19).replace('T', ' ')) : null;
    }
    if (req.body.discount !== undefined) {
      const d = money(String(req.body.discount).replace(',', '.'));
      const gross = money(inv.monthly + inv.extra_amount);
      if (d < 0 || d > gross) throw new HttpError(400, 'Desconto inválido');
      set.discount = d;
      set.total = money(gross - d);
    }
    if (req.body.notes !== undefined) set.notes = str(req.body.notes, 2000);
    const cols = Object.keys(set);
    if (cols.length) db.prepare(`UPDATE invoices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), inv.id);
    res.json(invoiceOut(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id)));
  });

  admin.delete('/invoices/:id', (req, res) => {
    const inv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(Number(req.params.id));
    if (!inv) throw new HttpError(404, 'Fatura não encontrada');
    if (inv.status === 'paga') throw new HttpError(409, 'Fatura paga não pode ser excluída; estorne o pagamento antes');
    db.prepare('DELETE FROM invoices WHERE id = ?').run(Number(req.params.id));
    res.status(204).end();
  });
}
