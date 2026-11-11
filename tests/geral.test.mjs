// Passa por todas as áreas do sistema contra o PostgreSQL: cadastro, imagens, mesclagem, painel, API pública,
// usuários, empresas e cobrança, NCM e tributação, DCB e planilhas. Uso: node tests/geral.test.mjs
import { startStack, checker, gtin } from './helper.mjs';

const { ok, failures } = checker();
const st = await startStack();
const { api, upload, base, sql } = st;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const big = (b) => Buffer.concat([b, Buffer.alloc(200)]); // o servidor recusa arquivo com menos de 100 bytes

try {
  // ---- Produtos
  const A = gtin('789100000101'); const B = gtin('789100000102'); const C = gtin('789100000103');
  const p1 = await api('POST', '/api/admin/products', { name: 'Dipirona 500mg', brand: 'Marca X', sku: 'SKU-1', ncm: '3004.90.69', barcodes: [A], tax_origin: '0' });
  ok('cria produto', p1.s === 201 && p1.b.id && p1.b.ncm === '30049069' && p1.b.barcodes[0].code === A, p1.b.error ?? '');
  const p2 = await api('POST', '/api/admin/products', { name: 'Paracetamol 750mg', barcodes: [B] });
  ok('SKU repetido é recusado', (await api('POST', '/api/admin/products', { name: 'X', sku: 'SKU-1' })).s === 409);
  ok('código de outro produto é recusado', (await api('PUT', `/api/admin/products/${p2.b.id}`, { barcodes: [A] })).s === 409);
  ok('id inválido responde 400/404', [400, 404].includes((await api('GET', '/api/admin/products/abc')).s));
  ok('produto inexistente 404', (await api('GET', '/api/admin/products/999999')).s === 404);
  const upd = await api('PUT', `/api/admin/products/${p1.b.id}`, { name: 'Dipirona 500mg c/10', cbs_rate: '8,8', description: 'Linha 1\nLinha 2' });
  ok('atualiza produto', upd.s === 200 && upd.b.name === 'Dipirona 500mg c/10' && upd.b.cbs_rate === '8.8' && !!upd.b.field_dates.name, upd.b.error ?? '');
  const addBc = await api('POST', `/api/admin/products/${p1.b.id}/barcodes`, { code: C });
  ok('inclui código de barras', addBc.s === 201 && addBc.b.barcodes.length === 2);
  const delBc = await api('DELETE', `/api/admin/barcodes/${addBc.b.barcodes.find((b) => b.code === C).id}`);
  ok('exclui código de barras', delBc.s === 200 && delBc.b.barcodes.length === 1);

  // ---- Imagens
  const up = await upload(`/api/admin/products/${p1.b.id}/images`, [['images', 'a.png', big(PNG)], ['images', 'b.png', big(PNG)]]);
  ok('envia imagens', up.s === 201 && up.b.images.length === 2 && !up.b.images[0].placeholder, up.b.error ?? up.s);
  const ids = up.b.images.map((i) => i.id);
  const ord = await api('PUT', `/api/admin/products/${p1.b.id}/images/order`, { ids: [ids[1], ids[0]] });
  ok('reordena imagens', ord.s === 200 && ord.b.images[0].id === ids[1], ord.b.error ?? '');
  const img = await fetch(`${base}/img/${A}`, { redirect: 'manual' });
  ok('/img com foto vai para o arquivo', img.status === 302 && img.headers.get('location').startsWith('/files/'));
  const file = await fetch(base + img.headers.get('location'));
  ok('arquivo servido', file.ok && file.headers.get('content-type') === 'image/png');
  const noImg = await fetch(`${base}/img/${B}`, { redirect: 'manual' });
  ok('/img sem foto vai para a imagem padrão', noImg.status === 302 && noImg.headers.get('location').startsWith('/padrao/'));
  const delImg = await api('DELETE', `/api/admin/images/${ids[0]}`);
  ok('exclui imagem', delImg.s === 200 && delImg.b.images.length === 1, delImg.b.error ?? delImg.s);

  // ---- API pública e cadastro automático
  const pub = await (await fetch(`${base}/api/v1/barcodes/${A}`)).json();
  ok('consulta pública por código', pub.id === p1.b.id && pub.main_image?.includes('/files/'));
  const D = gtin('789100000104');
  const auto = await fetch(`${base}/api/v1/barcodes/${D}?origem=Empresa%20Teste`);
  const autoBody = await auto.json();
  ok('código desconhecido vira cadastro provisório', auto.ok && autoBody.name.startsWith('PRODUTO NÃO CADASTRADO') && autoBody.pending === true, autoBody);
  await fetch(`${base}/api/v1/barcodes/${D}?origem=Empresa%20Teste`);
  const pend = await api('GET', '/api/admin/pending');
  ok('lista de pendentes conta as consultas', pend.b.items.find((r) => r.code === D)?.request_count === 2, pend.b.items[0]);
  const list = await (await fetch(`${base}/api/v1/products?limit=2&page=1`)).json();
  ok('lista pública paginada', list.total === 3 && list.items.length === 2);
  const tax = await (await fetch(`${base}/api/v1/products/${p1.b.id}/tax?uf=SP`)).json();
  ok('tributação pública', tax.values.cbs_rate === '8.8' && tax.uf === 'SP', tax);
  const cons = await (await fetch(`${base}/api/consulta?q=dipirona`)).json();
  ok('consulta da tela pública (sem diferenciar maiúsculas)', cons.total === 1, cons);
  const cat = await fetch(`${base}/api/v1/catalog.json`, { headers: { 'Accept-Encoding': 'gzip' } });
  const catBody = await cat.json(); // o fetch já descomprime
  ok('catálogo completo', cat.ok && cat.headers.get('content-encoding') === 'gzip' && catBody.total === 3 && catBody.items[0].name.localeCompare(catBody.items[1].name, 'pt-BR', { sensitivity: 'base' }) <= 0);
  const csv = await (await fetch(`${base}/api/v1/catalog.csv`)).text();
  ok('catálogo CSV', csv.split('\r\n').length === 4);

  // ---- Painel
  const dash = await api('GET', '/api/admin/dashboard');
  ok('dashboard', dash.s === 200 && dash.b.products.total === 3 && dash.b.products.pending === 1 && dash.b.products.created_today === 3 && dash.b.lookups.today >= 3, dash.b.products);
  ok('dashboard: conexão do dia', dash.b.lookups.sources.some((s) => s.source === 'Empresa Teste' && s.today === 2), dash.b.lookups.sources);
  ok('dashboard por período', (await api('GET', '/api/admin/dashboard?de=2020-01-01&ate=2020-01-31')).b.lookups.sources.length === 0);
  ok('dashboard recusa data inválida', (await api('GET', '/api/admin/dashboard?de=2026-02-31')).s === 400);
  ok('resumo', (await api('GET', '/api/admin/summary')).b.total === 3);
  for (const f of ['pending', 'overdue', 'due_today', 'due_week', 'created_today', 'updated_today', 'no_image', 'inactive', 'no_ncm', 'ncm_unregistered', 'provisional']) {
    const r = await api('GET', `/api/admin/products?limit=5&${f}=1`);
    ok(`filtro ${f}`, r.s === 200 && typeof r.b.total === 'number', r.b.error ?? r.b.total);
  }
  ok('busca por texto', (await api('GET', '/api/admin/products?q=PARACETAMOL')).b.total === 1);
  ok('ids da fila', (await api('GET', '/api/admin/product-ids?pending=1&order=requests')).b.ids.length === 1);
  const names = await api('GET', '/api/admin/product-names?sort=code&dir=desc');
  ok('planilha de nomes', names.s === 200 && names.b.total === 3 && names.b.items[0].code === D, names.b.items?.[0]);
  const bulk = await api('POST', '/api/admin/bulk', { ids: [p1.b.id, p2.b.id], set: { brand: 'Nova Marca' } });
  ok('edição em massa', bulk.s === 200 && (await api('GET', `/api/admin/products/${p2.b.id}`)).b.brand === 'Nova Marca', bulk.b);
  const res = await api('POST', `/api/admin/products/${autoBody.id}/resolve`);
  ok('tira da lista de pendentes', res.s === 200 && !res.b.pending);

  // ---- Mesclagem
  const merge = await api('POST', '/api/admin/merge', { ids: [p1.b.id, p2.b.id] });
  ok('mescla produtos', merge.s === 200 && merge.b.product.barcodes.length === 2 && merge.b.merged[0] === p2.b.id, merge.b.error ?? '');
  ok('mesclado sai do catálogo', (await api('GET', `/api/admin/products/${p2.b.id}`)).s === 404);
  ok('histórico da mesclagem', (await api('GET', `/api/admin/products/${p1.b.id}`)).b.merges.length === 1);

  // ---- Parâmetros
  const setg = await api('PUT', '/api/admin/settings', { prazo_cadastro_dias: 90, cosmos_token: 'abc', imagem_padrao: 3 });
  ok('grava parâmetros', setg.s === 200 && setg.b.prazo_cadastro_dias === 90 && setg.b.cosmos_token_set === true && !('cosmos_token' in setg.b), setg.b);
  const noImg2 = await fetch(`${base}/img/${D}`, { redirect: 'manual' });
  ok('parâmetro vale na hora (imagem padrão 3)', noImg2.headers.get('location') === '/padrao/3.png', noImg2.headers.get('location'));

  // ---- Usuários e login
  const pwd = 'senha-de-teste-123';
  const u = await api('POST', '/api/admin/users', { name: 'Maria', login: 'Maria.Silva', password: pwd, permissions: ['ncm'] });
  ok('cria usuário (login em minúsculas)', u.s === 201 && u.b.login === 'maria.silva', u.b);
  ok('login repetido recusado', (await api('POST', '/api/admin/users', { name: 'X', login: 'maria.silva', password: pwd })).s === 409);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'MARIA.SILVA', password: pwd }) });
  const { token } = await login.json();
  ok('login sem diferenciar maiúsculas', login.status === 200 && !!token);
  const as = (url) => fetch(base + url, { headers: { Authorization: `Bearer ${token}` } });
  ok('permissão concedida', (await as('/api/admin/ncm')).status === 200);
  ok('permissão negada', (await as('/api/admin/products')).status === 403);
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  ok('sair encerra a sessão', (await as('/api/admin/me')).status === 401);
  ok('senha errada', (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'maria.silva', password: 'errada' }) })).status === 401);

  // ---- Empresas, chave, consumo e cobrança
  const plan = await api('POST', '/api/admin/plans', { name: 'Básico', monthly: '99,90', included: 1, extra_price: '0,05' });
  ok('cria plano', plan.s === 201 && plan.b.monthly === 99.9, plan.b);
  const co = await api('POST', '/api/admin/companies', { cnpj: '33000167000101', razao_social: 'Empresa Teste SA', plan_id: plan.b.id });
  ok('cria empresa', co.s === 201 && co.b.plan?.name === 'Básico', co.b.error ?? '');
  const key = (await api('POST', `/api/admin/companies/${co.b.id}/api-key`)).b.api_key;
  for (let i = 0; i < 3; i++) await fetch(`${base}/api/v1/barcodes/${A}?chave=${key}`);
  const co2 = (await api('GET', `/api/admin/companies/${co.b.id}`)).b;
  ok('consumo da empresa pela chave', co2.usage_today === 3 && co2.usage_month === 3, [co2.usage_today, co2.usage_month]);
  const period = new Date().toLocaleDateString('sv-SE').slice(0, 7);
  const gen = await api('POST', '/api/admin/invoices/generate', { period });
  const bill = (await api('GET', `/api/admin/billing?period=${period}`)).b;
  const inv = bill.items[0].invoice;
  ok('gera fatura com excedente', gen.b.created === 1 && inv.usage === 3 && inv.extra_usage === 2 && inv.total === 100, [gen.b, inv?.total]);
  const paid = await api('PUT', `/api/admin/invoices/${inv.id}`, { status: 'paga' });
  ok('baixa da fatura', paid.b.status === 'paga' && !!paid.b.paid_at);
  ok('fatura paga não exclui', (await api('DELETE', `/api/admin/invoices/${inv.id}`)).s === 409);
  ok('empresa com fatura não exclui', (await api('DELETE', `/api/admin/companies/${co.b.id}`)).s === 409);
  ok('conexão com nome da empresa', (await api('GET', '/api/admin/dashboard')).b.lookups.sources.some((s) => s.source === 'Empresa Teste SA'));

  // ---- NCM, regras e tributação
  const ncm = await api('POST', '/api/admin/ncm', { code: '30049069', description: 'Medicamentos', cst_pis: '01', pis_rate: '1,65' });
  ok('cria NCM', ncm.s === 201 && ncm.b.cst_pis === '01' && ncm.b.products === 1, ncm.b);
  const cls = await api('POST', '/api/admin/tax-classes', { name: 'Lista positiva', cst_ibs_cbs: '200', c_class_trib: '200032', cbs_reduction: '60' });
  ok('cria classificação', cls.s === 201 && cls.b.rules === 0, cls.b.error ?? '');
  const rules = await api('POST', `/api/admin/ncm/${ncm.b.id}/rules`, { ufs: ['', 'SP', 'RJ'], icms_rate: '18', cfop: '5102' });
  ok('cria regras para vários estados', rules.s === 201 && rules.b.created === 3 && rules.b.rule_list.length === 3, rules.b.error ?? '');
  ok('regra repetida recusada', (await api('POST', `/api/admin/ncm/${ncm.b.id}/rules`, { ufs: ['SP'], icms_rate: '12' })).s === 409);
  const spRule = rules.b.rule_list.find((r) => r.uf === 'SP');
  await api('PUT', `/api/admin/ncm/rules/${spRule.id}`, { icms_rate: '19,5' });
  const resolved = await api('POST', '/api/admin/tax/resolve', { ncm: '30049069', uf: 'SP', tax_class_id: cls.b.id, product_id: p1.b.id });
  ok('tributação em camadas', resolved.b.values.icms_rate === '19.5' && resolved.b.values.pis_rate === '1.65' && resolved.b.values.c_class_trib === '200032' && resolved.b.sources.icms_rate === 'Regra SP', resolved.b.values);
  const ncmList = await api('GET', '/api/admin/ncm?q=medic');
  ok('lista de NCM com contagens', ncmList.b.total === 1 && ncmList.b.items[0].rules === 3 && ncmList.b.items[0].products === 1, ncmList.b.items[0]);
  ok('NCM em uso não exclui', (await api('DELETE', `/api/admin/ncm/${ncm.b.id}`)).s === 409);

  // ---- DCB e princípios ativos
  const dcb = await api('POST', '/api/admin/dcb', { name: 'Dipirona monoidratada', code: '03121', cas: '5907-38-0' });
  ok('cria DCB', dcb.s === 201, dcb.b.error ?? '');
  ok('DCB repetida recusada', (await api('POST', '/api/admin/dcb', { name: 'DIPIRONA MONOIDRATADA' })).s === 409);
  const withDcb = await api('PUT', `/api/admin/products/${p1.b.id}`, { dcb: [{ id: dcb.b.id, concentration: '500 mg' }] });
  ok('vincula princípio ativo', withDcb.s === 200 && withDcb.b.actives[0].concentration === '500 mg', withDcb.b.error ?? withDcb.b.actives);
  ok('busca por princípio ativo', (await api('GET', '/api/admin/products?q=monoidratada')).b.total === 1);
  const dcbCsv = 'nome;numero;cas\nDipirona monoidratada;03121;5907-38-0\nIbuprofeno;04766;15687-27-1\nIbuprofeno;04766;15687-27-1\n';
  const dpv = await upload('/api/admin/dcb/import/preview', [['file', 'd.csv', dcbCsv]]);
  ok('prévia de DCB', dpv.s === 200 && dpv.b.summary.create === 1 && dpv.b.summary.unchanged === 2, dpv.b.summary ?? dpv.b);
  const dap = await api('POST', '/api/admin/dcb/import/apply', { rows: dpv.b.rows });
  ok('importa DCB', dap.s === 200 && (await api('GET', '/api/admin/dcb?q=ibupro')).b.total === 1, dap.b);

  // ---- Planilhas
  const E = gtin('789100000105');
  const sheet = `codigo_barras;nome;marca\n${E};Produto da planilha;Marca P\n${A};Dipirona renomeada;\n`;
  const ipv = await upload('/api/admin/import/preview', [['file', 'p.csv', sheet]]);
  ok('prévia da planilha', ipv.s === 200 && ipv.b.summary.create === 1 && ipv.b.summary.update === 1, ipv.b.summary ?? ipv.b);
  const iap = await api('POST', '/api/admin/import/apply', { rows: ipv.b.rows, options: { create: true } });
  ok('importa planilha', iap.s === 200 && iap.b.summary.created === 1 && iap.b.summary.updated === 1, iap.b.summary ?? iap.b);
  const npv = await upload('/api/admin/ncm/import/preview', [['file', 'n.csv', 'ncm;descricao;cst_cofins;cofins\n30049069;Medicamentos;1;7,6\n33049910;Cosméticos;;\n30;Capítulo\n']]);
  ok('prévia de NCM', npv.s === 200 && npv.b.summary.create === 1 && npv.b.summary.update === 1 && npv.b.summary.skip === 1, npv.b.summary);
  ok('importa NCM', (await api('POST', '/api/admin/ncm/import/apply', { rows: npv.b.rows })).s === 200 && (await api('GET', '/api/admin/ncm')).b.total === 2);
  const lpv = await upload('/api/admin/ncm/link/preview', [['file', 'l.csv', `codigo_barras;ncm;classificacao\n${E};33049910;Lista positiva\n`]]);
  ok('prévia de vínculo', lpv.s === 200 && lpv.b.summary.update === 1, lpv.b.summary ?? lpv.b);
  await api('POST', '/api/admin/ncm/link/apply', { rows: lpv.b.rows });
  const pe = (await (await fetch(`${base}/api/v1/barcodes/${E}`)).json());
  ok('vínculo gravado', pe.ncm === '33049910' && pe.tax_class?.name === 'Lista positiva', [pe.ncm, pe.tax_class]);

  // ---- Prazos na fronteira (data local de São Paulo; prazo de dados em 90 dias, definido acima; imagens sem prazo)
  await api('PUT', '/api/admin/settings', { prazo_imagens_dias: 0 });
  const mk = async (name, ts) => (await sql(`INSERT INTO products (name, created_at, updated_at, data_updated_at) VALUES ($1, $2, $2, $2) RETURNING id`, name, ts))[0].id;
  // Meia-noite local de hoje em UTC, para montar datas exatas
  const [{ m }] = await sql(`SELECT sqlite_datetime('now', 'localtime', 'start of day', 'utc') AS m`);
  const at = (days, hours = 0) => new Date(Date.parse(`${m.replace(' ', 'T')}Z`) + (days * 24 + hours) * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const venceHoje = await mk('vence hoje', at(-90, 1));
  const venceAmanha = await mk('vence amanhã', at(-89, 1));
  const venceuOntem = await mk('venceu ontem', at(-91, 1));
  const ultimoMinuto = await mk('revisado na meia-noite que vence amanhã', at(-89, 0));
  const idsOf = async (flt) => (await api('GET', `/api/admin/product-ids?${flt}=1`)).b.ids;
  const hoje = await idsOf('due_today');
  const semana = await idsOf('due_week');
  const vencidos = await idsOf('overdue');
  ok('vence hoje', hoje.includes(venceHoje) && !hoje.includes(venceAmanha) && !hoje.includes(venceuOntem), hoje);
  ok('vence na semana inclui hoje e amanhã', semana.includes(venceHoje) && semana.includes(venceAmanha) && !semana.includes(venceuOntem), semana);
  ok('vencido', vencidos.includes(venceuOntem) && !vencidos.includes(venceAmanha), vencidos);
  ok('meia-noite seguinte já é amanhã', !hoje.includes(ultimoMinuto) && semana.includes(ultimoMinuto));
  const ontemLocal = await mk('criado ontem', at(-1, 23));
  const created = await idsOf('created_today');
  ok('cadastrado hoje usa a data local', created.includes(venceHoje) === false && !created.includes(ontemLocal), created.length);
  for (const id of [venceHoje, venceAmanha, venceuOntem, ultimoMinuto, ontemLocal]) await api('DELETE', `/api/admin/products/${id}`);

  // ---- Exclusão e resumo da limpeza
  ok('exclui produto', (await api('DELETE', `/api/admin/products/${pe.id}`)).s === 204 && (await api('GET', `/api/admin/products/${pe.id}`)).s === 404);
  ok('resumo da limpeza de espaços', (await api('GET', '/api/admin/text-cleanup')).s === 200);

  // ---- Sem erro de banco no servidor
  const errs = st.logs().split('\n').filter((l) => /error|erro/i.test(l) && !/Token de/.test(l));
  ok('sem erro no servidor', !errs.length, errs.slice(0, 5).join(' | '));
  const rows = await sql('SELECT COUNT(*)::int AS n FROM products');
  // Restam a Dipirona (com o Paracetamol mesclado) e o cadastro automático; o da planilha foi excluído
  ok('consulta direta no banco de teste', rows[0].n === 2, rows[0].n);
} catch (e) {
  ok('execução', false, e.stack);
} finally {
  await st.stop();
  console.log(failures() ? `\n${failures()} falha(s)` : '\nTudo certo.');
  process.exit(failures() ? 1 : 0);
}
