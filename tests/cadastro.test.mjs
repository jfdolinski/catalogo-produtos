// "Cadastre-se": e-mail, senha e CNPJ; conta inativa até a aprovação; empresa existente ou nova (pendente).
// Sem consulta à Receita (CNPJ_CONSULTA=off): nada sai para a internet.
import { startStack, checker } from './helper.mjs';

const { ok, failures } = checker();
const st = await startStack({ env: { CNPJ_CONSULTA: 'off' } });
const { api, base, sql } = st;

// CNPJ válido a partir dos 12 primeiros dígitos
const cnpj = (doze) => {
  const d = doze.split('').map(Number);
  const dv = (n) => { const p = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = p.reduce((a, w, i) => a + w * d[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  d.push(dv(12)); d.push(dv(13));
  return d.join('');
};
const signup = async (body) => {
  const r = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { s: r.status, b: await r.json() };
};
const login = async (login, password) => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) });
  return { s: r.status, b: await r.json() };
};

try {
  const existente = cnpj('112223330001');
  await api('POST', '/api/admin/companies', { cnpj: existente, razao_social: 'Farmácia Existente Ltda', nome_fantasia: 'Farmácia Existente' });

  const a = await signup({ email: '  Maria@Farmacia.com.br ', password: 'senha-forte-1', cnpj: existente.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') });
  ok('cadastro com empresa já existente', a.s === 201 && a.b.email === 'maria@farmacia.com.br' && a.b.company.name === 'Farmácia Existente' && a.b.company.new === false, a.b);
  const [u] = await sql("SELECT * FROM users WHERE login = 'maria@farmacia.com.br'");
  ok('conta nasce inativa, sem permissões, ligada à empresa', u.active === 0 && u.permissions === '[]' && u.is_admin === 0 && u.signup_at && u.company_id, u);
  ok('senha guardada só como hash', u.password_hash.startsWith('scrypt$') && !u.password_hash.includes('senha-forte-1'));

  const pend = await login('maria@farmacia.com.br', 'senha-forte-1');
  ok('antes da aprovação: avisa que aguarda o administrador', pend.s === 403 && /aguardando a aprovação/.test(pend.b.error), pend.b);
  const errada = await login('maria@farmacia.com.br', 'senha-errada-1');
  ok('senha errada não revela que o cadastro existe', errada.s === 401 && /incorretos/.test(errada.b.error), errada.b);

  const nova = cnpj('987654320001');
  const b = await signup({ email: 'joao@mercado.com', password: 'outra-senha-9', cnpj: nova });
  ok('CNPJ novo cria empresa pendente', b.s === 201 && b.b.company.new === true, b.b);
  const [emp] = await sql('SELECT * FROM companies WHERE cnpj = $1', nova);
  ok('empresa nova fica pendente e sem chave de API', emp.status === 'pendente' && !emp.api_key_hash && /Cadastre-se/.test(emp.notes), emp);

  ok('e-mail repetido é recusado', (await signup({ email: 'MARIA@farmacia.com.br', password: 'senha-forte-2', cnpj: existente })).s === 409);
  ok('e-mail inválido é recusado', (await signup({ email: 'maria', password: 'senha-forte-2', cnpj: existente })).s === 400);
  ok('senha curta é recusada', (await signup({ email: 'x@y.com', password: '123', cnpj: existente })).s === 400);
  ok('CNPJ com dígito errado é recusado', (await signup({ email: 'x@y.com', password: 'senha-forte-2', cnpj: '11222333000182' })).s === 400);

  // Painel: lista mostra quem aguarda aprovação, com a empresa
  const lista = await api('GET', '/api/admin/users');
  const maria = lista.b.items.find((x) => x.login === 'maria@farmacia.com.br');
  ok('Usuários: aguardando aprovação aparece primeiro, com a empresa', lista.b.items[0].pending && maria.pending && maria.company_name === 'Farmácia Existente', lista.b.items.slice(0, 2));

  // Aprovação: ativar e dar módulos
  await api('PUT', `/api/admin/users/${maria.id}`, { active: true, permissions: ['atualizacao'] });
  const entra = await login('maria@farmacia.com.br', 'senha-forte-1');
  ok('depois de aprovada, entra com e-mail e senha', entra.s === 200 && entra.b.user.permissions.includes('atualizacao'), entra.b);
  const depois = (await api('GET', '/api/admin/users')).b.items.find((x) => x.id === maria.id);
  ok('aprovada deixa de aparecer como pendente', depois.pending === false);

  // Empresa cancelada não aceita cadastro novo
  const cancelada = cnpj('123123120001');
  await api('POST', '/api/admin/companies', { cnpj: cancelada, razao_social: 'Cancelada SA', status: 'cancelada' });
  ok('empresa cancelada não aceita cadastro', (await signup({ email: 'z@cancelada.com', password: 'senha-forte-3', cnpj: cancelada })).s === 403);

  // Limite por IP: depois de 5 cadastros na hora, recusa
  let ultimo;
  for (let i = 0; i < 6; i++) ultimo = await signup({ email: `robo${i}@spam.com`, password: 'senha-forte-4', cnpj: existente });
  ok('muitos cadastros do mesmo IP são recusados', ultimo.s === 429, ultimo.s);
} catch (e) {
  ok('sem exceção', false, e.stack);
} finally {
  await st.stop();
}
if (failures()) { console.log(`\n${failures()} falha(s)`); process.exit(1); }
console.log('\nTudo certo');
