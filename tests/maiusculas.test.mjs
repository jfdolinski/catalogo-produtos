// Maiúsculas por palavra em nome, marca, fabricante e categoria: a regra, a entrada de dados e a conversão dos antigos.
import { startStack, checker, gtin, wait } from './helper.mjs';
import { caseWords } from '../src/text.js';

const { ok, failures } = checker();

// ---- A regra ----
const casos = [
  ['DIPIRONA SÓDICA 500MG C/10 CPR', 'Dipirona Sódica 500mg C/10 CPR'],
  ['CAFÉ TORRADO E MOÍDO 500 G', 'Café Torrado e Moído 500 g'],
  ['ÁGUA MINERAL 1,5L', 'Água Mineral 1,5L'],
  ['VITAMINA A', 'Vitamina A'],
  ['SABONETE ERVA-DOCE 90G', 'Sabonete Erva-Doce 90g'],
  ['FRALDA TURMA DA MÔNICA XG CX 2X30UN', 'Fralda Turma da Mônica XG CX 2x30UN'],
  ['AMOXICILINA 500MG/5ML (PÓ)', 'Amoxicilina 500mg/5ml (Pó)'],
  ['3M DO BRASIL', '3M do Brasil'],
  ['CABO USB 10M', 'Cabo USB 10M'],
  ['DOM PEDRO II', 'Dom Pedro II'],
  ['ems', 'EMS'],
  ['  medicamentos   genéricos ', 'Medicamentos Genéricos'],
  ['', ''],
];
for (const [entrada, esperado] of casos) ok(`regra: ${JSON.stringify(entrada)}`, caseWords(entrada) === esperado, caseWords(entrada));

const st = await startStack();
const { api, sql, base } = st;
try {
  // ---- Entrada de dados ----
  const p = await api('POST', '/api/admin/products', {
    name: 'PARACETAMOL 750MG 20 COMPRIMIDOS', brand: 'MEDLEY', manufacturer: 'sanofi medley', category: 'MEDICAMENTOS',
    unit: 'CX', description: 'TEXTO LIVRE EM MAIÚSCULAS', barcodes: [gtin('789100031650')],
  });
  ok('cadastro: nome, marca, fabricante e categoria formatados', p.b.name === 'Paracetamol 750mg 20 Comprimidos' && p.b.brand === 'Medley'
    && p.b.manufacturer === 'Sanofi Medley' && p.b.category === 'Medicamentos', [p.b.name, p.b.brand, p.b.manufacturer, p.b.category]);
  ok('cadastro: unidade e descrição ficam como digitadas', p.b.unit === 'CX' && p.b.description === 'TEXTO LIVRE EM MAIÚSCULAS', [p.b.unit, p.b.description]);
  const u = await api('PUT', `/api/admin/products/${p.b.id}`, { name: 'dipirona gotas 20ML' });
  ok('edição formata', u.b.name === 'Dipirona Gotas 20ml', u.b.name);
  const sheet = await api('POST', '/api/admin/product-names', { items: [{ id: p.b.id, field: 'brand', value: 'NEO QUÍMICA', original: 'Medley' }] });
  ok('planilha devolve o valor já formatado', sheet.b.saved[0].value === 'Neo Química', sheet.b);
  const ren = await api('POST', '/api/admin/field-values/category/rename', { from: 'Medicamentos', to: 'FARMÁCIA POPULAR' });
  ok('renomear formata o valor novo', ren.s === 200 && (await api('GET', `/api/admin/products/${p.b.id}`)).b.category === 'Farmácia Popular');
  // Consulta pública de código desconhecido: nome provisório continua em maiúsculas (o sistema reconhece por ele)
  const novo = gtin('789555000301');
  await fetch(`${base}/api/v1/barcodes/${novo}`);
  const [prov] = await sql('SELECT p.name FROM products p JOIN barcodes b ON b.product_id = p.id WHERE b.code = $1', novo);
  ok('nome provisório não muda', prov.name === `PRODUTO NÃO CADASTRADO ${novo}`, prov.name);
  // Fila de atualização "Sem nome": só os provisórios, mais consultados primeiro
  const semNome = await api('GET', '/api/admin/product-ids?provisional=1&order=requests');
  const [{ id: provId }] = await sql('SELECT product_id AS id FROM barcodes WHERE code = $1', novo);
  ok('fila "Sem nome" traz só os provisórios', semNome.s === 200 && semNome.b.ids.length === 1 && semNome.b.ids[0] === provId, semNome.b);

  // ---- Conversão dos antigos (uma vez, ao subir o servidor) ----
  const [{ id: velho }] = await sql(`INSERT INTO products (name, brand, manufacturer, category, unit) VALUES
    ('LEITE INTEGRAL UHT 1L', 'PIRACANJUBA', 'LATICÍNIOS BELA VISTA', 'LATICÍNIOS', 'UN') RETURNING id`);
  await sql("DELETE FROM settings WHERE key = 'migr_maiusculas_por_palavra'");
  await st.restart();
  let conv;
  for (let i = 0; i < 50; i++) { // roda em segundo plano depois de subir
    [conv] = await sql('SELECT name, brand, manufacturer, category, unit FROM products WHERE id = $1', velho);
    if (conv.name !== 'LEITE INTEGRAL UHT 1L') break;
    await wait(100);
  }
  ok('antigos convertidos', conv.name === 'Leite Integral UHT 1L' && conv.brand === 'Piracanjuba' && conv.manufacturer === 'Laticínios Bela Vista'
    && conv.category === 'Laticínios' && conv.unit === 'UN', conv);
  const logs = await sql("SELECT column_name, old_value, new_value FROM text_cleanup_log WHERE status = 'maiusculas' AND row_id = $1 ORDER BY column_name", velho);
  ok('valor antigo guardado para desfazer', logs.length === 4 && logs.find((l) => l.column_name === 'name').old_value === 'LEITE INTEGRAL UHT 1L', logs);
  ok('provisório também fica de fora da conversão', (await sql('SELECT name FROM products WHERE name LIKE $1', 'PRODUTO NÃO CADASTRADO%')).length === 1);
  await wait(300);
  ok('marca a conversão como feita', (await sql("SELECT 1 FROM settings WHERE key = 'migr_maiusculas_por_palavra'")).length === 1, st.logs().split(/\r?\n/).filter((l) => /aiúsculas/.test(l)));
  await sql("UPDATE products SET name = 'OUTRO EM MAIÚSCULAS' WHERE id = $1", velho);
  await st.restart();
  await wait(500);
  ok('conversão roda uma vez só', (await sql('SELECT name FROM products WHERE id = $1', velho))[0].name === 'OUTRO EM MAIÚSCULAS');
} catch (e) {
  ok('sem exceção', false, e.stack);
} finally {
  await st.stop();
}
if (failures()) { console.log(`\n${failures()} falha(s)`); process.exit(1); }
console.log('\nTudo certo');
