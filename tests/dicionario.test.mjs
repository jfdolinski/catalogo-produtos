// Dicionário de correções: a troca, a prévia, aplicar nos atuais e valer sozinho na entrada de dados.
import { startStack, checker, gtin } from './helper.mjs';
import { replaceAll, applyDictionary } from '../src/text.js';

const { ok, failures } = checker();

// ---- A troca (sem banco) ----
ok('troca em qualquer trecho, sem diferenciar maiúsculas', replaceAll('Sinvastatina C10 GEN', 'gen', 'Genérico') === 'Sinvastatina C10 Genérico');
ok('não troca de novo o que já foi trocado', replaceAll('Dipirona 20 Comprimidos', 'Comp', 'Comprimidos') === 'Dipirona 20 Comprimidos');
ok('acerta a caixa (mesmo tamanho)', replaceAll('Valdorm 20 Drg', 'Drg', 'DRG') === 'Valdorm 20 DRG');
ok('várias ocorrências', replaceAll('Cx Cx', 'cx', 'Caixa') === 'Caixa Caixa');
const regras = [{ field: 'name', find: 'Sol', replace: 'Sólido' }, { field: 'name', find: 'Sol Oral', replace: 'Solução Oral' }]
  .sort((a, b) => b.find.length - a.find.length);
ok('trecho maior vem primeiro', applyDictionary('name', 'Xarope Sol Oral', regras) === 'Xarope Solução Oral', applyDictionary('name', 'Xarope Sol Oral', regras));
ok('trocar por vazio tira o trecho e os espaços', applyDictionary('name', 'Dipirona Gen 500mg', [{ field: 'name', find: 'Gen', replace: '' }]) === 'Dipirona 500mg');
ok('regra de outro campo não vale', applyDictionary('brand', 'Gen', [{ field: 'name', find: 'Gen', replace: 'X' }]) === 'Gen');

const st = await startStack();
const { api } = st;
try {
  // Produtos antes de existir regra
  const a = await api('POST', '/api/admin/products', { name: 'SINVASTATINA 40MG C10 GEN', barcodes: [gtin('789100031700')] });
  const b = await api('POST', '/api/admin/products', { name: 'GENTAMICINA COLIRIO', barcodes: [gtin('789100031701')] });
  const c = await api('POST', '/api/admin/products', { name: 'Dipirona 500mg', brand: 'BOTICARIO', barcodes: [gtin('789100031702')] });
  ok('antes da regra fica só com maiúsculas por palavra', a.b.name === 'Sinvastatina 40mg C10 Gen', a.b.name);

  // Prévia
  const pv = await api('POST', '/api/admin/dictionary/preview', { field: 'name', find: 'Gen', replace: 'Genérico' });
  ok('prévia mostra os produtos que mudariam, com antes e depois', pv.s === 200 && pv.b.total === 2
    && pv.b.items.find((i) => i.id === a.b.id).after === 'Sinvastatina 40mg C10 Genérico'
    && pv.b.items.find((i) => i.id === b.b.id).after === 'Genéricotamicina Colirio', pv.b);
  ok('prévia não grava nada', (await api('GET', `/api/admin/products/${a.b.id}`)).b.name === 'Sinvastatina 40mg C10 Gen');

  // Salvar e aplicar
  const r = await api('POST', '/api/admin/dictionary', { field: 'name', find: 'Gen', replace: 'Genérico' });
  ok('cria a regra', r.s === 201 && r.b.find === 'Gen' && r.b.active, r.b);
  ok('regra repetida (mesmo campo, sem diferenciar maiúsculas) é recusada', (await api('POST', '/api/admin/dictionary', { field: 'name', find: 'GEN', replace: 'X' })).s === 409);
  const ap = await api('POST', `/api/admin/dictionary/${r.b.id}/apply`);
  ok('aplica nos atuais', ap.s === 200 && ap.b.changed === 2, ap.b);
  ok('produto corrigido', (await api('GET', `/api/admin/products/${a.b.id}`)).b.name === 'Sinvastatina 40mg C10 Genérico');
  ok('aplicar de novo não muda mais nada', (await api('POST', `/api/admin/dictionary/${r.b.id}/apply`)).b.changed === 0);
  const lista = await api('GET', '/api/admin/dictionary');
  ok('lista mostra quantos foram corrigidos', lista.b.items[0].applied_count === 2 && lista.b.items[0].applied_at, lista.b.items[0]);

  // Vale sozinha na entrada de dados
  const novo = await api('POST', '/api/admin/products', { name: 'ATORVASTATINA 20MG GEN', barcodes: [gtin('789100031703')] });
  ok('cadastro novo já sai corrigido', novo.b.name === 'Atorvastatina 20mg Genérico', novo.b.name);
  const ed = await api('PUT', `/api/admin/products/${c.b.id}`, { name: 'Dipirona 500mg gen' });
  ok('edição também', ed.b.name === 'Dipirona 500mg Genérico', ed.b.name);
  const sh = await api('POST', '/api/admin/product-names', { items: [{ id: c.b.id, field: 'name', value: 'Dipirona Gen', original: 'Dipirona 500mg Genérico' }] });
  ok('planilha também', sh.b.saved[0].value === 'Dipirona Genérico', sh.b);

  // Regra de marca
  const m = await api('POST', '/api/admin/dictionary', { field: 'brand', find: 'Boticario', replace: 'O Boticário' });
  await api('POST', `/api/admin/dictionary/${m.b.id}/apply`);
  ok('regra de marca', (await api('GET', `/api/admin/products/${c.b.id}`)).b.brand === 'O Boticário');
  ok('regra de marca não mexe no nome', (await api('GET', `/api/admin/products/${c.b.id}`)).b.name === 'Dipirona Genérico');

  // Testar texto
  const t = await api('POST', '/api/admin/dictionary/test', { field: 'name', text: 'losartana 50mg gen' });
  ok('testar um texto', t.b.after === 'Losartana 50mg Genérico', t.b);

  // Desativar e excluir
  await api('PUT', `/api/admin/dictionary/${r.b.id}`, { active: false });
  const off = await api('POST', '/api/admin/products', { name: 'CAPTOPRIL 25MG GEN', barcodes: [gtin('789100031704')] });
  ok('regra desativada não vale', off.b.name === 'Captopril 25mg Gen', off.b.name);
  ok('aplicar regra desativada é recusado', (await api('POST', `/api/admin/dictionary/${r.b.id}/apply`)).s === 400);
  ok('exclui a regra', (await api('DELETE', `/api/admin/dictionary/${r.b.id}`)).s === 204);
  ok('validação: trecho vazio', (await api('POST', '/api/admin/dictionary', { field: 'name', find: ' ', replace: 'x' })).s === 400);
  ok('validação: campo inválido', (await api('POST', '/api/admin/dictionary', { field: 'unit', find: 'cx', replace: 'CX' })).s === 400);

  // Depois de reiniciar, as regras ativas continuam valendo
  await st.restart();
  const pos = await api('PUT', `/api/admin/products/${c.b.id}`, { brand: 'boticario' });
  ok('regras carregadas ao subir o servidor', pos.b.brand === 'O Boticário', pos.b.brand);
} catch (e) {
  ok('sem exceção', false, e.stack);
} finally {
  await st.stop();
}
if (failures()) { console.log(`\n${failures()} falha(s)`); process.exit(1); }
console.log('\nTudo certo');
