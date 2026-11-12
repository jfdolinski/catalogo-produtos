// Planilha de nomes: gravação, prazo, lista e permissão, contra o PostgreSQL. Uso: node tests/nomes.test.mjs
import { startStack, checker } from './helper.mjs';

const { ok, failures } = checker();
const st = await startStack();
const { base } = st;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => { const r = await st.api(m, u, b); return { s: r.s, b: r.b }; };

try {
  const p = (await api('POST', '/api/admin/products', { name: 'Nome antigo', barcodes: ['7891000315507'] })).b;
  await wait(1100); // as datas têm resolução de segundos
  const r = await api('POST', '/api/admin/product-names', { items: [{ id: p.id, name: '  Nome novo  ', original: 'Nome Antigo' }] });
  const after = (await api('GET', `/api/admin/products/${p.id}`)).b;
  ok('nome gravado sem espaços', r.s === 200 && after.name === 'Nome Novo', after.name);
  ok('prazo de dados não renova', !!p.review.data.updated_at && p.review.data.updated_at === after.review.data.updated_at, [p.review.data.updated_at, after.review.data.updated_at]);
  await api('PUT', `/api/admin/products/${p.id}`, { name: 'Nome novo' });
  const revised = (await api('GET', `/api/admin/products/${p.id}`)).b;
  ok('o teste enxerga a renovação ao salvar o cadastro', revised.review.data.updated_at !== p.review.data.updated_at, revised.review.data.updated_at);
  ok('registro marca a alteração', after.updated_at !== p.updated_at, [p.updated_at, after.updated_at]);
  ok('data do campo nome registrada', !!after.field_dates?.name, after.field_dates?.name);
  const list = await api('GET', '/api/admin/product-names?sort=code&q=7891000315507');
  ok('lista por código', list.b.total === 1 && list.b.items[0].code === '7891000315507', list.b.items[0]);
  const prov = await fetch(`${base}/api/v1/barcodes/7891000315514`);
  const pv = await api('GET', '/api/admin/product-names?provisional=1');
  ok('filtro de nome provisório', prov.ok !== undefined && pv.b.total === pv.b.items.filter((x) => x.name.startsWith('PRODUTO NÃO CADASTRADO')).length, pv.b.total);
  const pwd = 'senha-de-teste-123';
  const u = await api('POST', '/api/admin/users', { name: 'Só NCM', login: 'soncm', password: pwd, permissions: ['ncm'] });
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'soncm', password: pwd }) }).then((x) => x.json());
  const denied = await fetch(`${base}/api/admin/product-names`, { headers: { Authorization: `Bearer ${login.token}` } });
  ok('usuário sem a permissão Produtos é recusado', u.s === 201 && denied.status === 403, [u.s, denied.status]);
} catch (e) { ok('execução', false, e.stack); } finally {
  await st.stop();
  console.log(failures() ? `${failures()} falha(s)` : 'Tudo certo.');
  process.exit(failures() ? 1 : 0);
}
