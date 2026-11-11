// Consulta de dados de empresa pelo CNPJ.
// Os Sintegras estaduais exigem captcha e não têm API pública; os dados cadastrais vêm da Receita Federal
// por serviços gratuitos (CNPJá público, BrasilAPI, ReceitaWS). A Inscrição Estadual (cadastro do Sintegra/CCC)
// só vem automaticamente com um token da API comercial do CNPJá (parâmetro cnpja_token).
const UA = 'RepositorioProdutos/1.0 (cadastro de empresas)';
const TIMEOUT_MS = 12000;

export function onlyDigits(s) { return String(s ?? '').replace(/\D/g, ''); }

export function validCnpj(raw) {
  const c = onlyDigits(raw);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (len) => {
    let sum = 0;
    let w = len - 7;
    for (let i = 0; i < len; i++) { sum += Number(c[i]) * w--; if (w < 2) w = 9; }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

export const formatCnpj = (c) => onlyDigits(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status === 404) return null;
  if (r.status === 429) throw Object.assign(new Error('limite de consultas por minuto atingido'), { rateLimited: true });
  if (r.status === 401 || r.status === 403) throw new Error(`acesso negado (HTTP ${r.status})`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const phone = (area, num) => (num ? `(${area}) ${String(num).replace(/^(\d{4,5})(\d{4})$/, '$1-$2')}` : '');
const brDate = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || ''); };

// Formato comum devolvido por todas as fontes
function normalize(d) {
  return {
    razao_social: clean(d.razao_social),
    nome_fantasia: clean(d.nome_fantasia),
    situacao: clean(d.situacao).toUpperCase(),
    abertura: d.abertura || '',
    natureza_juridica: clean(d.natureza_juridica),
    porte: clean(d.porte),
    simples: d.simples ?? null,
    cnae: clean(d.cnae),
    logradouro: clean(d.logradouro),
    numero: clean(d.numero),
    complemento: clean(d.complemento),
    bairro: clean(d.bairro),
    municipio: clean(d.municipio),
    uf: clean(d.uf).toUpperCase(),
    cep: onlyDigits(d.cep),
    telefone: clean(d.telefone),
    email: clean(d.email).toLowerCase(),
    inscricoes: d.inscricoes || [],
  };
}

// API comercial do CNPJá: inclui inscrições estaduais (Sintegra/CCC) com registrations=BR
function cnpjaPaid(token) {
  return {
    id: 'cnpja', name: 'CNPJá (com Inscrição Estadual)',
    async find(c) {
      const j = await getJson(`https://api.cnpja.com/office/${c}?registrations=BR`, { Authorization: token });
      return j && fromCnpja(j);
    },
  };
}

function fromCnpja(j) {
  const ph = j.phones?.[0];
  return normalize({
    razao_social: j.company?.name,
    nome_fantasia: j.alias,
    situacao: j.status?.text,
    abertura: j.founded,
    natureza_juridica: j.company?.nature?.text,
    porte: j.company?.size?.text,
    simples: j.company?.simples?.optant ?? null,
    cnae: j.mainActivity ? `${j.mainActivity.id} - ${j.mainActivity.text}` : '',
    logradouro: j.address?.street, numero: j.address?.number, complemento: j.address?.details,
    bairro: j.address?.district, municipio: j.address?.city, uf: j.address?.state, cep: j.address?.zip,
    telefone: ph ? phone(ph.area, ph.number) : '',
    email: j.emails?.[0]?.address,
    inscricoes: (j.registrations || []).map((r) => ({
      numero: r.number, uf: r.state, ativa: !!r.enabled, situacao: r.status?.text || '', tipo: r.type?.text || '',
    })),
  });
}

export const SOURCES = [
  {
    id: 'cnpja_open', name: 'CNPJá (Receita Federal)',
    async find(c) { const j = await getJson(`https://open.cnpja.com/office/${c}`); return j && fromCnpja(j); },
  },
  {
    id: 'brasilapi', name: 'BrasilAPI (Receita Federal)',
    async find(c) {
      const j = await getJson(`https://brasilapi.com.br/api/cnpj/v1/${c}`);
      if (!j) return null;
      const tel = onlyDigits(j.ddd_telefone_1);
      return normalize({
        razao_social: j.razao_social, nome_fantasia: j.nome_fantasia, situacao: j.descricao_situacao_cadastral,
        abertura: j.data_inicio_atividade, natureza_juridica: j.natureza_juridica, porte: j.porte,
        simples: j.opcao_pelo_simples ?? null,
        cnae: j.cnae_fiscal ? `${j.cnae_fiscal} - ${j.cnae_fiscal_descricao}` : '',
        logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(' '), numero: j.numero,
        complemento: j.complemento, bairro: j.bairro, municipio: j.municipio, uf: j.uf, cep: j.cep,
        telefone: tel ? phone(tel.slice(0, 2), tel.slice(2)) : '', email: j.email,
      });
    },
  },
  {
    id: 'receitaws', name: 'ReceitaWS (Receita Federal)',
    async find(c) {
      const j = await getJson(`https://receitaws.com.br/v1/cnpj/${c}`);
      if (!j || j.status === 'ERROR') return null;
      return normalize({
        razao_social: j.nome, nome_fantasia: j.fantasia, situacao: j.situacao, abertura: brDate(j.abertura),
        natureza_juridica: j.natureza_juridica, porte: j.porte, simples: j.simples?.optante ?? null,
        cnae: j.atividade_principal?.[0] ? `${j.atividade_principal[0].code} - ${j.atividade_principal[0].text}` : '',
        logradouro: j.logradouro, numero: j.numero, complemento: j.complemento, bairro: j.bairro,
        municipio: j.municipio, uf: j.uf, cep: j.cep, telefone: j.telefone, email: j.email,
      });
    },
  },
];

// Tenta as fontes em ordem até uma responder. Retorna { source, source_name, data } ou lança erro.
export async function lookupCnpj(raw, { cnpjaToken } = {}) {
  const c = onlyDigits(raw);
  const list = cnpjaToken ? [cnpjaPaid(cnpjaToken), ...SOURCES] : SOURCES;
  const errors = [];
  let notFound = 0;
  for (const s of list) {
    try {
      const data = await s.find(c);
      if (data?.razao_social) return { source: s.id, source_name: s.name, data };
      notFound++;
    } catch (e) {
      errors.push(`${s.name}: ${e.name === 'TimeoutError' ? 'tempo esgotado' : e.message}`);
    }
  }
  if (notFound && !errors.length) throw Object.assign(new Error('CNPJ não encontrado na Receita Federal'), { status: 404 });
  throw Object.assign(new Error(`Não foi possível consultar o CNPJ agora (${errors.join('; ')})`), { status: 502 });
}
