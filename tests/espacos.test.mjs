// Tratamento automático de espaços em todas as entradas, contra o PostgreSQL. Uso: node tests/espacos.test.mjs
import { startStack, checker, gtin, wait, ROOT } from './helper.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ExcelJS = createRequire(path.join(ROOT, 'x.js'))('exceljs');
const { ok, failures } = checker();
const st = await startStack();
const { base, api, upload } = st;

const NB = ' ';
const dirty = '  Dipirona   500mg\t com' + NB + NB + '20  ';

try {
  // Registros antigos, gravados antes do tratamento (direto no banco)
  const oldId = (await st.sql("INSERT INTO products (name) VALUES ('  Antigo   com  espacos ') RETURNING id"))[0].id;
  const oldId2 = (await st.sql("INSERT INTO products (name) VALUES ('Outro  antigo') RETURNING id"))[0].id;

  const p = await api('POST', '/api/admin/products', { name: dirty, brand: '  Marca   X ', category: ' Cat  1', unit: ' CX  10', sku: ' SK  1 ', manufacturer: ' Lab   Y ', description: '  Linha  um  \r\n\r\n   Linha    dois ', tax_notes: ' Obs   a\n  Obs   b ', barcodes: [{ code: gtin('789100000001'), note: '  nota   de  codigo ' }] });
  ok('produto: nome', p.b.name === 'Dipirona 500mg com 20', p.b.name);
  ok('produto: outros campos', p.b.brand === 'Marca X' && p.b.category === 'Cat 1' && p.b.unit === 'CX 10' && p.b.sku === 'SK 1' && p.b.manufacturer === 'Lab Y', [p.b.brand, p.b.category, p.b.unit, p.b.sku, p.b.manufacturer]);
  ok('produto: várias linhas mantidas, cada uma tratada', p.b.description === 'Linha um\n\nLinha dois' && p.b.tax_notes === 'Obs a\nObs b', [p.b.description, p.b.tax_notes]);
  ok('código: observação', p.b.barcodes[0].note === 'nota de codigo', p.b.barcodes[0].note);
  const u = await api('PUT', `/api/admin/products/${p.b.id}`, { name: '   Novo    nome ' });
  ok('produto: atualização', u.b.name === 'Novo nome', u.b.name);
  const quebra = await api('PUT', `/api/admin/products/${p.b.id}`, { name: 'Nome\ncom\r\nquebra' });
  ok('nome não aceita quebra de linha', quebra.b.name === 'Nome com quebra', quebra.b.name);
  const so = await api('PUT', `/api/admin/products/${p.b.id}`, { name: `  ${NB} ` });
  ok('só espaços conta como vazio', so.s === 400, so.b.error);

  const bulk = await api('POST', '/api/admin/bulk', { ids: [p.b.id], set: { brand: '  Bulk   marca ' } });
  const afterBulk = (await api('GET', `/api/admin/products/${p.b.id}`)).b;
  console.log(`      edição em massa: ${bulk.s} marca=${JSON.stringify(afterBulk.brand)}`);

  // Planilha de nomes
  const sn = await api('POST', '/api/admin/product-names', { items: [{ id: p.b.id, name: '  Da   planilha ', original: 'Nome com quebra' }] });
  ok('planilha de nomes', sn.b.saved?.[0]?.name === 'Da planilha' && (await api('GET', `/api/admin/products/${p.b.id}`)).b.name === 'Da planilha', sn.b);
  const oldSave = await api('POST', '/api/admin/product-names', { items: [{ id: oldId, name: 'Corrigido   agora', original: '  Antigo   com  espacos ' }] });
  ok('nome antigo com espaços não vira conflito falso', oldSave.b.saved?.[0]?.name === 'Corrigido agora' && !oldSave.b.conflicts.length, oldSave.b);
  const real = await api('POST', '/api/admin/product-names', { items: [{ id: oldId2, name: 'Y', original: 'Outra coisa' }] });
  ok('conflito de verdade continua detectado', real.b.conflicts?.length === 1, real.b);
  const untouched = (await api('GET', `/api/admin/products/${oldId2}`)).b;
  ok('registro antigo só muda ao salvar', untouched.name === 'Outro  antigo', untouched.name);
  const reSave = await api('PUT', `/api/admin/products/${oldId2}`, { name: untouched.name });
  ok('salvar de novo corrige o antigo', reSave.b.name === 'Outro antigo', reSave.b.name);

  // Outros cadastros
  const n = await api('POST', '/api/admin/ncm', { code: '30049069', description: '  Medicamentos   gerais ', notes: ' A  b ' });
  ok('NCM', n.b.description === 'Medicamentos gerais' && n.b.notes === 'A b', [n.b.description, n.b.notes]);
  const c = await api('POST', '/api/admin/tax-classes', { name: '  Lista   positiva ' });
  ok('classificação', c.b.name === 'Lista positiva', c.b.name);
  const d = await api('POST', '/api/admin/dcb', { name: '  Dipirona   monoidratada ', code: ' 123 ' });
  ok('DCB', d.b.name?.toLowerCase() === 'dipirona monoidratada', d.b.name);
  const co = await api('POST', '/api/admin/companies', { cnpj: '33000167000101', razao_social: '  Empresa    Teste   SA ', nome_fantasia: ' Fantasia   X ' });
  ok('empresa', co.b.razao_social === 'Empresa Teste SA' && co.b.nome_fantasia === 'Fantasia X', [co.s, co.b.razao_social ?? co.b.error, co.b.nome_fantasia]);

  // Senha com espaços não é alterada
  const pwd = '  senha   com  espacos  ';
  const us = await api('POST', '/api/admin/users', { name: '  Fulano   de  Tal ', login: ' fulano ', password: pwd, permissions: ['ncm'] });
  ok('usuário: nome e login tratados', us.s === 201 && us.b.name === 'Fulano de Tal' && us.b.login === 'fulano', [us.s, us.b.name, us.b.login]);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'fulano', password: pwd }) });
  ok('senha com espaços continua valendo', login.status === 200, login.status);
  const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'fulano', password: 'senha com espacos' }) });
  ok('senha sem os espaços é recusada', wrong.status === 401, wrong.status);
  await api('PUT', '/api/admin/settings', { cosmos_token: '  abc  def  ' });
  // A rota de parâmetros já tirava as pontas; o que o tratamento não pode é mexer no meio do token
  const savedToken = (await st.sql("SELECT value FROM settings WHERE key = 'cosmos_token'"))[0]?.value;
  ok('token mantém o miolo como veio', savedToken === 'abc  def', savedToken);

  // Planilha CSV e XLSX
  const c1 = gtin('789100000011'); const c2 = gtin('789100000012');
  const csv = `codigo_barras;nome;marca;descricao\n${c1};  Do   CSV  ;  Marca   CSV ;" Desc   a\n  Desc   b "\n`;
  const pv = await upload('/api/admin/import/preview', [['file', 'a.csv', csv]]);
  ok('planilha: prévia já tratada', pv.b.rows[0].name === 'Do CSV' && pv.b.rows[0].brand === 'Marca CSV' && pv.b.rows[0].description === 'Desc a\nDesc b', pv.b.rows[0]);
  const ap = await api('POST', '/api/admin/import/apply', { rows: pv.b.rows, options: { create: true } });
  const fromCsv = (await api('GET', `/api/v1/barcodes/${c1}`)).b;
  ok('planilha: gravado', ap.s === 200 && fromCsv.name === 'Do CSV', [ap.s, fromCsv.name, ap.b.summary]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('a');
  ws.addRow(['codigo_barras', 'nome']);
  ws.addRow([c2, '  Do   XLSX' + NB + ' ']);
  const pvx = await upload('/api/admin/import/preview', [['file', 'a.xlsx', Buffer.from(await wb.xlsx.writeBuffer())]]);
  ok('planilha XLSX', pvx.b.rows[0].name === 'Do XLSX', pvx.b.rows[0]?.name);
  const ncsv = 'ncm;descricao\n30049099;  Outro   medicamento \n';
  const npv = await upload('/api/admin/ncm/import/preview', [['file', 'n.csv', ncsv]]);
  ok('importação de NCM', npv.b.plan[0].description === 'Outro medicamento', npv.b.plan[0].description);

  // NFC-e
  const c3 = gtin('789100000013');
  const k = `35${'8'.repeat(42)}`;
  const xml = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${k}"><ide><mod>65</mod><tpAmb>1</tpAmb><dhEmi>2026-10-10T10:00:00-03:00</dhEmi></ide><emit><CNPJ>11111111000111</CNPJ><enderEmit><UF>SP</UF></enderEmit><CRT>3</CRT></emit><det nItem="1"><prod><cEAN>${c3}</cEAN><xProd>  NOTA   FISCAL  ITEM </xProd><NCM>30049069</NCM><CFOP>5102</CFOP><uCom> C  X </uCom><cEANTrib>${c3}</cEANTrib></prod><imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><pICMS>18.00</pICMS></ICMS00></ICMS></imposto></det></infNFe></NFe><protNFe><infProt><chNFe>${k}</chNFe><cStat>100</cStat></infProt></protNFe></nfeProc>`;
  await upload('/api/admin/xml-import/start', [['files', 'n.xml', xml]]);
  let j; for (let i = 0; i < 100; i++) { j = (await api('GET', '/api/admin/xml-import')).b; if (j.status === 'ready') break; await wait(50); }
  await api('POST', '/api/admin/xml-import/apply', { id: j.id });
  for (let i = 0; i < 100; i++) { j = (await api('GET', '/api/admin/xml-import')).b; if (j.status === 'done') break; await wait(50); }
  const nf = (await api('GET', `/api/v1/barcodes/${c3}`)).b;
  ok('NFC-e: nome e unidade', nf.name === 'NOTA FISCAL ITEM' && nf.unit === 'C X', [nf.name, nf.unit]);

  // Cadastro automático e origem da consulta
  const c4 = gtin('789100000014');
  await fetch(`${base}/api/v1/barcodes/${c4}?origem=${encodeURIComponent('  Empresa   da  consulta ')}`);
  const dash = (await api('GET', '/api/admin/dashboard')).b;
  ok('origem da consulta', dash.lookups.sources.some((s) => s.source === 'Empresa da consulta'), dash.lookups.sources.map((s) => s.source));
} catch (e) { ok('execução', false, e.stack); } finally {
  await st.stop();
  console.log(failures() ? `${failures()} falha(s)` : 'Tudo certo.');
  process.exit(failures() ? 1 : 0);
}
