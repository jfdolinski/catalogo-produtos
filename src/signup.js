// "Cadastre-se" na tela de login do painel: e-mail, senha e CNPJ da empresa.
// A conta nasce inativa e sem permissões, ligada à empresa do CNPJ, até um administrador aprovar em Usuários.
// CNPJ que ainda não está em Empresas: busca os dados na Receita (como a tela Empresas) e cria a empresa como pendente.
import { db, getSecret } from './db.js';
import { hashPassword, loginBlocked, loginFailed, loginOk } from './auth.js';
import { HttpError, tx } from './business.js';
import { lookupCnpj, validCnpj, onlyDigits, formatCnpj } from './cnpj.js';

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_POR_HORA = 5; // cadastros por IP, contra robôs
const recentes = new Map();

function limitePorIp(ip) {
  const agora = Date.now();
  const lista = (recentes.get(ip) || []).filter((t) => agora - t < 3_600_000);
  if (lista.length >= MAX_POR_HORA) throw new HttpError(429, 'Muitos cadastros feitos daqui. Tente de novo mais tarde.');
  lista.push(agora);
  recentes.set(ip, lista);
}

/** Empresa do CNPJ: a que já existe ou uma nova, pendente, com os dados da Receita quando der para buscar. */
async function empresaDoCnpj(cnpj) {
  const existente = await db.get('SELECT id, razao_social, nome_fantasia, status FROM companies WHERE cnpj = ?', cnpj);
  if (existente) return { ...existente, criada: false };
  let dados = {};
  let fonte = '';
  try {
    // CNPJ_CONSULTA=off: sem consulta externa (testes)
    if (process.env.CNPJ_CONSULTA === 'off') throw new Error('consulta desligada');
    const r = await lookupCnpj(cnpj, { cnpjaToken: getSecret('cnpja_token') });
    if (r?.data?.razao_social) { dados = r.data; fonte = r.source_name || r.source || ''; }
  } catch { /* sem Receita agora: a empresa nasce só com o CNPJ e o administrador completa depois */ }
  const campos = ['razao_social', 'nome_fantasia', 'situacao', 'abertura', 'natureza_juridica', 'porte', 'cnae',
    'logradouro', 'numero', 'complemento', 'bairro', 'municipio', 'uf', 'cep', 'telefone', 'email'];
  const row = { cnpj, status: 'pendente', razao_social: `CNPJ ${formatCnpj(cnpj)}` };
  for (const c of campos) if (typeof dados[c] === 'string' && dados[c].trim()) row[c] = dados[c].trim().slice(0, 300);
  row.notes = `Criada pelo "Cadastre-se" do painel em ${new Date().toLocaleDateString('pt-BR')}${fonte ? ` (dados: ${fonte})` : ' (sem dados da Receita: completar)'}.`;
  if (fonte) row.data_fetched_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const cols = Object.keys(row);
  const r = await db.run(`INSERT INTO companies (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT (cnpj) DO NOTHING`, ...Object.values(row));
  // Dois cadastros do mesmo CNPJ ao mesmo tempo: fica a empresa que entrou primeiro
  const id = r.lastInsertRowid ?? (await db.get('SELECT id FROM companies WHERE cnpj = ?', cnpj)).id;
  return { id: Number(id), razao_social: row.razao_social, nome_fantasia: row.nome_fantasia || '', status: 'pendente', criada: true };
}

export function mountSignup(app) {
  app.post('/api/auth/signup', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const senha = String(req.body?.password ?? '');
    const cnpj = onlyDigits(req.body?.cnpj ?? '');
    const chave = `signup|${req.ip}`;
    if (loginBlocked(chave)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
    if (!EMAIL.test(email) || email.length > 60) throw new HttpError(400, 'Informe um e-mail válido (até 60 caracteres)');
    if (senha.length < 8) throw new HttpError(400, 'A senha deve ter ao menos 8 caracteres');
    if (senha.length > 200) throw new HttpError(400, 'Senha longa demais');
    if (!validCnpj(cnpj)) { loginFailed(chave); throw new HttpError(400, 'CNPJ inválido (confira os dígitos)'); }
    if (await db.get('SELECT 1 FROM users WHERE login = ?', email)) throw new HttpError(409, 'Já existe um cadastro com este e-mail. Entre com ele ou fale com o administrador.');
    limitePorIp(req.ip);
    const empresa = await empresaDoCnpj(cnpj);
    if (empresa.status === 'cancelada') throw new HttpError(403, 'O cadastro desta empresa está cancelado. Fale com o fornecedor do catálogo.');
    await tx(async () => {
      await db.run(`INSERT INTO users (name, login, password_hash, permissions, is_admin, active, company_id, signup_at)
        VALUES (?, ?, ?, '[]', 0, 0, ?, datetime('now'))`, email, email, hashPassword(senha), empresa.id);
    });
    loginOk(chave);
    res.status(201).json({
      ok: true,
      email,
      company: { name: empresa.nome_fantasia || empresa.razao_social, cnpj_formatted: formatCnpj(cnpj), new: empresa.criada },
      message: 'Cadastro recebido. Você poderá entrar assim que um administrador aprovar o acesso.',
    });
  });
}
