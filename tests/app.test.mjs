// Aplicativo de celular: vínculo por código, token do aparelho, busca por código de barras e o fluxo de fotos.
import { startStack, checker, gtin } from './helper.mjs';

const { ok, failures } = checker();
const st = await startStack();
const { api, base, sql } = st;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const post = async (url, body, token) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { s: r.status, b: await r.json().catch(() => null) };
};
const as = (token) => async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { s: r.status, b: r.status === 204 ? null : await r.json().catch(() => null) };
};

try {
  // Usuários: um com Atualização, outro só com Dashboard
  await api('POST', '/api/admin/users', { name: 'Ana', login: 'ana', password: 'senha-forte-1', permissions: ['atualizacao'] });
  await api('POST', '/api/admin/users', { name: 'Bia', login: 'bia', password: 'senha-forte-2', permissions: ['dashboard'] });
  const ana = as((await post('/api/auth/login', { login: 'ana', password: 'senha-forte-1' })).b.token);
  const bia = as((await post('/api/auth/login', { login: 'bia', password: 'senha-forte-2' })).b.token);

  const master = await api('POST', '/api/admin/me/app-link');
  ok('token de administração não gera código', master.s === 400, master.b);

  const g = await ana('POST', '/api/admin/me/app-link');
  ok('gera código de 10 caracteres', g.s === 200 && /^[A-Z2-9]{10}$/.test(g.b.code), g.b?.code);
  ok('link do QR no formato do app', g.b.link === `catalogo://vincular?servidor=${encodeURIComponent(base)}&codigo=${g.b.code}`, g.b.link);
  ok('QR code em SVG', String(g.b.qr_svg).startsWith('<svg'));
  ok('sem APK publicado ainda', g.b.app === null);

  // Gerar outro invalida o anterior
  const g2 = await ana('POST', '/api/admin/me/app-link');
  const velho = await post('/api/app/link', { codigo: g.b.code, nome: 'Velho', plataforma: 'ANDROID' });
  ok('código anterior deixa de valer', velho.s === 401, velho.b);

  const bad = await post('/api/app/link', { codigo: 'XXXX', nome: 'x' });
  ok('código malformado é recusado', bad.s === 401);

  const link = await post('/api/app/link', { codigo: g2.b.code.toLowerCase().replace(/(.{5})/, '$1-'), nome: '  Moto   G84 ', plataforma: 'ANDROID', versao: '1.0.0' });
  ok('vincula com o código (aceita minúsculas e hífen)', link.s === 201 && link.b.token.startsWith('app_') && link.b.user.login === 'ana', link.b);
  const again = await post('/api/app/link', { codigo: g2.b.code, nome: 'Outro' });
  ok('código é de uso único', again.s === 401);
  const [dev] = await sql('SELECT * FROM app_devices');
  ok('guarda só o hash do token e o nome limpo', dev.token_hash !== link.b.token && dev.token_hash.length === 64 && dev.name === 'Moto G84', dev.name);

  const cel = as(link.b.token);
  const me = await cel('GET', '/api/admin/me');
  ok('token do aparelho vale como o usuário', me.s === 200 && me.b.user.login === 'ana' && me.b.user.device_id === dev.id, me.b);
  ok('aparelho não gera código de vínculo', (await cel('POST', '/api/admin/me/app-link')).s === 403);
  ok('aparelho respeita as permissões do usuário', (await cel('GET', '/api/admin/dashboard')).s === 403);

  // Busca por código
  const code = gtin('789100031550');
  const created = await api('POST', '/api/admin/products', { name: 'Café Torrado 500g', brand: 'Bom Dia', barcodes: [code] });
  const found = await cel('GET', `/api/admin/code/${code}`);
  ok('acha o produto pelo código', found.s === 200 && found.b.found && found.b.product.id === created.b.id, found.b);
  ok('produto sem foto vem com a imagem padrão', found.b.product.images[0].placeholder === true);
  const upc = gtin('03600029145'); // UPC-A de 12 dígitos
  await api('POST', '/api/admin/products', { name: 'Produto UPC', barcodes: ['0' + upc] });
  const viaUpc = await cel('GET', `/api/admin/code/${upc}`);
  ok('UPC-A lido com 12 dígitos acha o EAN-13 com zero', viaUpc.b.found && viaUpc.b.product.name === 'Produto UPC', viaUpc.b);
  const miss = await cel('GET', `/api/admin/code/${gtin('789999999999')}`);
  ok('código desconhecido: found=false, sem cadastrar', miss.s === 200 && miss.b.found === false && (await sql('SELECT COUNT(*)::int AS n FROM products'))[0].n === 2);
  ok('código não numérico é recusado', (await cel('GET', '/api/admin/code/abc')).s === 400);
  ok('usuário sem Atualização não busca', (await bia('GET', `/api/admin/code/${code}`)).s === 403);

  // Fotos pelo app (multipart, como a câmera envia)
  const fd = new FormData();
  fd.append('images', new Blob([PNG], { type: 'image/jpeg' }), 'foto-1.jpg');
  fd.append('images', new Blob([PNG], { type: 'image/jpeg' }), 'foto-2.jpg');
  const up = await fetch(`${base}/api/admin/products/${created.b.id}/images`, { method: 'POST', headers: { Authorization: `Bearer ${link.b.token}` }, body: fd });
  const upB = await up.json();
  ok('envia fotos pelo token do aparelho', up.status === 201 && upB.images.length === 2 && !upB.images[0].placeholder, upB.images?.length);
  const order = await cel('PUT', `/api/admin/products/${created.b.id}/images/order`, { ids: [upB.images[1].id, upB.images[0].id] });
  ok('escolhe a foto principal (reordena)', order.s === 200 && order.b.images[0].id === upB.images[1].id);
  const edit = await cel('PUT', `/api/admin/products/${created.b.id}`, { name: '  Café  Torrado 500 g ', brand: 'Bom Dia' });
  ok('corrige nome com espaços tratados', edit.s === 200 && edit.b.name === 'Café Torrado 500 g', edit.b?.name);
  ok('marca como revisado', (await cel('POST', `/api/admin/products/${created.b.id}/resolve`)).s === 200);

  // Cadastro na hora pelo app
  const novo = gtin('789555000111');
  const reg = await cel('POST', '/api/admin/products', { name: 'Sabonete 90g', brand: 'Flor', barcodes: [novo] });
  ok('cadastra produto novo com o código lido', reg.s === 201 && reg.b.barcodes[0].code === novo, reg.b);

  // Aparelhos: lista, desvincular
  const list = await ana('GET', '/api/admin/me/devices');
  ok('lista os aparelhos do usuário', list.b.items.length === 1 && list.b.items[0].name === 'Moto G84');
  const own = await cel('GET', '/api/admin/me/devices');
  ok('marca o aparelho atual', own.b.items[0].current === true);
  ok('outro usuário não desvincula', (await bia('DELETE', `/api/admin/me/devices/${dev.id}`)).s === 404);
  const users = await api('GET', `/api/admin/users`);
  const anaId = users.b.items.find((u) => u.login === 'ana').id;
  ok('administração vê os aparelhos do usuário', (await api('GET', `/api/admin/users/${anaId}/devices`)).b.items.length === 1);
  ok('desvincula pelo painel', (await ana('DELETE', `/api/admin/me/devices/${dev.id}`)).s === 204);
  ok('token desvinculado deixa de valer', (await cel('GET', '/api/admin/me')).s === 401);

  // Desvincular pelo próprio app e usuário desativado
  const g3 = await ana('POST', '/api/admin/me/app-link');
  const l3 = await post('/api/app/link', { codigo: g3.b.code, nome: 'Tablet' });
  const cel3 = as(l3.b.token);
  ok('app se desvincula sozinho', (await cel3('DELETE', '/api/admin/me/device')).s === 204 && (await cel3('GET', '/api/admin/me')).s === 401);
  const g4 = await ana('POST', '/api/admin/me/app-link');
  const l4 = await post('/api/app/link', { codigo: g4.b.code, nome: 'Outro' });
  await api('PUT', `/api/admin/users/${anaId}`, { active: false });
  ok('usuário desativado: aparelho para de funcionar', (await as(l4.b.token)('GET', '/api/admin/me')).s === 401);

  // Código vencido
  await api('PUT', `/api/admin/users/${anaId}`, { active: true });
  const g5 = await ana('POST', '/api/admin/me/app-link');
  await sql("UPDATE app_link_codes SET expires_at = '2000-01-01 00:00:00' WHERE used_at IS NULL");
  ok('código vencido é recusado', (await post('/api/app/link', { codigo: g5.b.code, nome: 'x' })).s === 401);

  // Bloqueio por tentativas
  let last;
  for (let i = 0; i < 9; i++) last = await post('/api/app/link', { codigo: 'ABCDEFGHJK', nome: 'x' });
  ok('muitas tentativas bloqueiam', last.s === 429, last.s);

  // Sugestões de marca e categoria (campos do app e do painel)
  await api('POST', '/api/admin/products', { name: 'Café B', brand: 'Bom Dia', category: 'Mercearia', barcodes: [gtin('789100031560')] });
  await api('POST', '/api/admin/products', { name: 'Chá', brand: 'Bom Gosto', category: 'Bebidas', barcodes: [gtin('789100031570')] });
  const marcas = await api('GET', '/api/admin/field-values/brand?q=bom');
  ok('sugere marcas cadastradas, mais usadas primeiro', marcas.s === 200 && marcas.b[0].value === 'Bom Dia' && marcas.b[0].products === 2 && marcas.b.some((m) => m.value === 'Bom Gosto'), marcas.b);
  const meio = await api('GET', '/api/admin/field-values/brand?q=gost');
  ok('acha por trecho do meio', meio.b.length === 1 && meio.b[0].value === 'Bom Gosto', meio.b);
  const cats = await api('GET', '/api/admin/field-values/category');
  ok('categorias sem filtro', cats.b.map((c) => c.value).sort().join(',') === 'Bebidas,Mercearia', cats.b);
  ok('campo sem sugestão é recusado', (await api('GET', '/api/admin/field-values/password_hash')).s === 400);
  ok('sem permissão de produtos não vê sugestões', (await bia('GET', '/api/admin/field-values/brand')).s === 403);

  // Planilha Nomes: marca, fabricante e categoria editáveis e filtráveis
  const lab = await api('POST', '/api/admin/products', { name: 'Dipirona 500mg', brand: 'Genérico', manufacturer: 'EMS', category: 'Medicamentos', barcodes: [gtin('789100031580')] });
  const semMarca = await api('POST', '/api/admin/products', { name: 'Produto sem marca', barcodes: [gtin('789100031590')] });
  const linhas = await api('GET', `/api/admin/product-names?q=Dipirona`);
  ok('planilha traz fabricante e categoria', linhas.b.items[0].manufacturer === 'EMS' && linhas.b.items[0].category === 'Medicamentos', linhas.b.items[0]);
  const porFab = await api('GET', '/api/admin/product-names?manufacturer=EMS');
  ok('filtra por fabricante', porFab.b.total === 1 && porFab.b.items[0].id === lab.b.id, porFab.b.total);
  const vazios = await api('GET', '/api/admin/product-names?brand=__vazio__');
  ok('filtra produtos sem marca', vazios.b.items.some((r) => r.id === semMarca.b.id) && vazios.b.items.every((r) => !r.brand), vazios.b.total);
  ok('busca também pelo fabricante', (await api('GET', '/api/admin/product-names?q=EMS')).b.total === 1);
  const celulas = await api('POST', '/api/admin/product-names', { items: [
    { id: lab.b.id, field: 'brand', value: '  Genérico   EMS ', original: 'Genérico' },
    { id: lab.b.id, field: 'category', value: 'Farmácia', original: 'Medicamentos' },
    { id: semMarca.b.id, field: 'manufacturer', value: 'Fábrica X', original: '' },
  ] });
  ok('grava marca, categoria e fabricante pela planilha', celulas.s === 200 && celulas.b.saved.length === 3, celulas.b);
  const depois = await api('GET', `/api/admin/products/${lab.b.id}`);
  ok('valores gravados com espaços tratados', depois.b.brand === 'Genérico EMS' && depois.b.category === 'Farmácia', depois.b.brand);
  const conflito = await api('POST', '/api/admin/product-names', { items: [{ id: lab.b.id, field: 'brand', value: 'Outra', original: 'Genérico' }] });
  ok('conflito por coluna quando outra pessoa alterou', conflito.b.conflicts.length === 1 && conflito.b.conflicts[0].field === 'brand' && conflito.b.conflicts[0].current === 'Genérico EMS', conflito.b);
  ok('marca pode ficar vazia; nome não', (await api('POST', '/api/admin/product-names', { items: [{ id: lab.b.id, field: 'brand', value: '', original: 'Genérico EMS' }] })).s === 200
    && (await api('POST', '/api/admin/product-names', { items: [{ id: lab.b.id, field: 'name', value: ' ', original: 'Dipirona 500mg' }] })).s === 400);
  ok('coluna fora da lista é recusada', (await api('POST', '/api/admin/product-names', { items: [{ id: lab.b.id, field: 'ncm', value: '1', original: '' }] })).s === 400);
  ok('formato antigo (só nome) continua valendo', (await api('POST', '/api/admin/product-names', { items: [{ id: lab.b.id, name: 'Dipirona 500 mg', original: 'Dipirona 500mg' }] })).b.saved[0].name === 'Dipirona 500 mg');

  // Marcas e categorias: renomear e juntar
  const fab = await api('GET', '/api/admin/field-values/manufacturer?empty=1');
  ok('fabricantes com a contagem dos vazios', fab.b.items.some((v) => v.value === 'EMS') && fab.b.empty > 0, fab.b);
  const ren = await api('POST', '/api/admin/field-values/brand/rename', { from: 'Bom Gosto', to: 'Bom  Gosto Ltda' });
  ok('renomeia uma marca', ren.s === 200 && ren.b.products === 1 && !ren.b.merged_into_existing, ren.b);
  const junta = await api('POST', '/api/admin/field-values/brand/rename', { from: 'Bom Gosto Ltda', to: 'Bom Dia' });
  ok('renomear para marca existente junta os produtos', junta.b.merged_into_existing === true && (await api('GET', '/api/admin/product-names?brand=Bom%20Dia')).b.total === 3, junta.b);
  ok('valor inexistente: 404', (await api('POST', '/api/admin/field-values/brand/rename', { from: 'Não existe', to: 'X' })).s === 404);
  ok('só marca, fabricante e categoria', (await api('POST', '/api/admin/field-values/unit/rename', { from: 'UN', to: 'X' })).s === 400);
  // Sessão nova: desativar o usuário (acima) encerrou as sessões dele
  const ana2 = as((await post('/api/auth/login', { login: 'ana', password: 'senha-forte-1' })).b.token);
  const semPerm = await ana2('POST', '/api/admin/field-values/brand/rename', { from: 'Bom Dia', to: 'X' });
  ok('renomear exige permissão de Produtos', semPerm.s === 403, semPerm);
  const tirar = await api('POST', '/api/admin/field-values/category/rename', { from: 'Farmácia', to: '' });
  ok('renomear para vazio tira o valor', tirar.b.products === 1 && (await api('GET', `/api/admin/products/${lab.b.id}`)).b.category === '', tirar.b);

  ok('rota de download sem APK responde 404', (await fetch(`${base}/downloads/catalogo-app.apk`)).status === 404);
} catch (e) {
  ok('sem exceção', false, e.stack);
} finally {
  await st.stop();
}
if (failures()) { console.log(`\n${failures()} falha(s)`); process.exit(1); }
console.log('\nTudo certo');
