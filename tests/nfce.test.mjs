// Importação de NFC-e de ponta a ponta, contra o PostgreSQL. Uso: node tests/nfce.test.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, checker, gtin, wait } from './helper.mjs';

const { ok, failures } = checker();
const st = await startStack();
const { base, H, dir } = st;
const api = async (m, u, b) => { const r = await st.api(m, u, b); return { status: r.s, body: r.b }; };

const A = gtin('789100000001'); const B = gtin('789100000002'); const C = gtin('789100000003');
const D = gtin('789100000004'); const NEW = gtin('789100000005'); const NEW_T = gtin('1789100000005');
const OTHER = gtin('789100000006');

const REFORM = (uf = '0.10', mun = '0.00', cbs = '0.90', red = '') => `<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>10.00</vBC>
  <gIBSUF><pIBSUF>${uf}</pIBSUF>${red ? `<gRed><pRedAliq>${red}</pRedAliq><pAliqEfet>0.04</pAliqEfet></gRed>` : ''}<vIBSUF>0.01</vIBSUF></gIBSUF>
  <gIBSMun><pIBSMun>${mun}</pIBSMun><vIBSMun>0.00</vIBSMun></gIBSMun><vIBS>0.01</vIBS><gCBS><pCBS>${cbs}</pCBS><vCBS>0.09</vCBS></gCBS></gIBSCBS></IBSCBS>`;
const ICMS00 = (r = '18.0000') => `<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>10</vBC><pICMS>${r}</pICMS><vICMS>1.8</vICMS></ICMS00></ICMS>`;
const ICMS60 = '<ICMS><ICMS60><orig>0</orig><CST>60</CST><vBCSTRet>0</vBCSTRet><pST>18.0000</pST></ICMS60></ICMS>';
const SN = '<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>';
const PC = (cst = '01', p = '1.6500', c = '7.6000') => `<PIS><PISAliq><CST>${cst}</CST><vBC>10</vBC><pPIS>${p}</pPIS><vPIS>0.16</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>${cst}</CST><vBC>10</vBC><pCOFINS>${c}</pCOFINS><vCOFINS>0.76</vCOFINS></COFINSAliq></COFINS>`;
const item = (i, { ean, trib, name = 'PROD &amp; CIA', ncm = '30049069', cest = '', cfop = '5102', icms = ICMS00(), pc = PC(), extra = '', med = '' }) => `<det nItem="${i}"><prod><cProd>${i}</cProd><cEAN>${ean}</cEAN><xProd>${name}</xProd><NCM>${ncm}</NCM>${cest ? `<CEST>${cest}</CEST>` : ''}<CFOP>${cfop}</CFOP><uCom>CX</uCom><qCom>1</qCom><vUnCom>10</vUnCom><vProd>10</vProd><cEANTrib>${trib ?? ean}</cEANTrib><uTrib>CX</uTrib>${med}</prod><imposto>${icms}${pc}${extra}</imposto></det>`;
let seq = 1000;
const note = ({ uf = 'SP', cnpj = '11111111000111', crt = '3', mod = '65', tpAmb = '1', dh = '2026-10-10T10:00:00-03:00', cStat = '100', items, prot = true, key }) => {
  const k = key ?? `${String(35).padEnd(2, '0')}${String(++seq).padStart(42, '0')}`;
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${k}" versao="4.00"><ide><cUF>35</cUF><mod>${mod}</mod><tpNF>1</tpNF><finNFe>1</finNFe><tpAmb>${tpAmb}</tpAmb><dhEmi>${dh}</dhEmi></ide>
  <emit><CNPJ>${cnpj}</CNPJ><xNome>Farmacia</xNome><enderEmit><UF>${uf}</UF></enderEmit><CRT>${crt}</CRT></emit><dest><CPF>12345678909</CPF><xNome>CONSUMIDOR SECRETO</xNome></dest>${items.map((x, i) => item(i + 1, x)).join('')}</infNFe></NFe>${prot ? `<protNFe><infProt><chNFe>${k}</chNFe><cStat>${cStat}</cStat></infProt></protNFe>` : ''}</nfeProc>`;
};

async function send(files) {
  const fd = new FormData();
  for (const [name, content] of files) fd.append('files', new Blob([content]), name);
  const r = await fetch(`${base}/api/admin/xml-import/start`, { method: 'POST', headers: H, body: fd });
  if (r.status !== 202) throw new Error(`start ${r.status}: ${await r.text()}`);
  return ready();
}
async function ready() {
  for (let i = 0; i < 300; i++) {
    const j = (await api('GET', '/api/admin/xml-import')).body;
    if (!['reading', 'planning', 'applying'].includes(j.status)) return j;
    await wait(50);
  }
  throw new Error('tempo esgotado');
}
async function apply(j) {
  const r = await api('POST', '/api/admin/xml-import/apply', { id: j.id });
  if (r.status !== 202) throw new Error(`apply ${r.status}: ${JSON.stringify(r.body)}`);
  const d = await ready();
  if (d.status !== 'done') throw new Error(`gravação: ${d.status} ${d.error}`);
  return d;
}
const tax = async (code, uf) => (await api('GET', `/api/v1/barcodes/${code}/tax?uf=${uf}`)).body;

try {

  // Cadastro inicial
  await api('POST', '/api/admin/ncm', { code: '30049069', description: 'Medicamentos' });
  const n2 = (await api('POST', '/api/admin/ncm', { code: '33049910', description: 'Cosméticos' })).body;
  const manual = await api('POST', `/api/admin/ncm/${n2.id}/rules`, { ufs: ['SP'], icms_rate: '25' });
  ok('regra manual de outro NCM criada', manual.status === 201);
  const mk = async (name, code, ncm) => (await api('POST', '/api/admin/products', { name, ncm, barcodes: [code] })).body;
  const pA = await mk('Produto A', A, '30049069');
  const pB = await mk('Produto B', B, '30049069');
  const pC = await mk('Produto C', C, '30049069');
  const pO = await mk('Outro', OTHER, '33049910');
  await fetch(`${base}/api/v1/barcodes/${D}?origem=teste`); // cadastro provisório
  const q = (await api('GET', `/api/v1/barcodes/${D}/tax`)).body;
  ok('produto provisório criado', !!q.product_id);

  const cancelKey = `35${'9'.repeat(42)}`;
  const files = [
    ['a.xml', note({ items: [{ ean: A, med: '<med><cProdANVISA>1234567890123</cProdANVISA><vPMC>10</vPMC></med>', extra: REFORM(), cest: '1300100' }, { ean: B, extra: REFORM() }, { ean: C, icms: ICMS60, cfop: '5405', extra: REFORM('0.10', '0.00', '0.90', '60.00') }] })],
    ['b.xml', note({ items: [{ ean: D, name: 'DIPIRONA &amp; CIA 500MG', extra: REFORM() }, { ean: NEW, trib: NEW_T, name: 'NOVO PRODUTO', extra: REFORM() }, { ean: 'SEM GTIN', name: 'A GRANEL' }] })],
    ['pr.xml', note({ uf: 'PR', cnpj: '22222222000122', items: [{ ean: A, icms: ICMS00('19.5000') }, { ean: B, icms: ICMS00('19.5000') }] })],
    ['simples.xml', note({ uf: 'SC', cnpj: '33333331000133', crt: '1', items: [{ ean: A, icms: SN, pc: PC('49', '0', '0'), extra: REFORM() }] })],
    ['homolog.xml', note({ tpAmb: '2', items: [{ ean: OTHER, icms: ICMS00('1') }] })],
    ['nfe55.xml', note({ mod: '55', items: [{ ean: OTHER, icms: ICMS00('1') }] })],
    ['rejeitada.xml', note({ cStat: '302', items: [{ ean: OTHER, icms: ICMS00('1') }] })],
    ['semprot.xml', note({ prot: false, items: [{ ean: OTHER, icms: ICMS00('1') }] })],
    ['cancelada.xml', note({ key: cancelKey, items: [{ ean: OTHER, icms: ICMS00('1') }] })],
    ['evento.xml', `<?xml version="1.0"?><procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe"><evento><infEvento><chNFe>${cancelKey}</chNFe><tpEvento>110111</tpEvento></infEvento></evento></procEventoNFe>`],
    ['lixo.xml', 'isto nao e xml'],
    ['doctype.xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><nfeProc/>'],
    ['planilha.txt', 'x'],
  ];
  const dup = files[0][1];
  const zipDir = fs.mkdtempSync(path.join(dir, 'z-'));
  fs.writeFileSync(path.join(zipDir, 'dup.xml'), dup);
  const zipPath = path.join(dir, 'notas.zip');
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(zipDir, 'dup.xml')}' -DestinationPath '${zipPath}'`]);
  files.push(['notas.zip', fs.readFileSync(zipPath)]);

  const j = await send(files);
  ok('prévia pronta', j.status === 'ready', j.error ?? '');
  const p = j.preview;
  ok('notas válidas: 4', p.notes === 4, p.notes);
  ok('ignorados por motivo', p.ignored.homologation === 1 && p.ignored.not_nfce === 1 && p.ignored.not_authorized === 2 && p.ignored.canceled === 1 && p.ignored.invalid === 2 && p.ignored.repeated === 1 && p.ignored.not_xml === 1, p.ignored);
  ok('item sem GTIN contado', p.no_gtin === 1);
  ok('itens com reforma', p.reform_items === 6, p.reform_items);
  ok('estados', p.ufs.map((u) => u.uf).sort().join() === 'PR,SC,SP', p.ufs.map((u) => u.uf));
  ok('prévia não grava', !(await tax(A, 'SP')).values.icms_rate);
  ok('prévia não vaza consumidor', !JSON.stringify(j).includes('SECRETO') && !JSON.stringify(j).includes('12345678909'));

  await apply(j);
  const asp = await tax(A, 'SP'); const bsp = await tax(B, 'SP'); const csp = await tax(C, 'SP');
  ok('regra de NCM em SP com a maioria', asp.values.icms_rate === '18' && asp.values.cst_icms === '00' && asp.sources.icms_rate.startsWith('Regra SP'), asp.values);
  ok('PIS e COFINS normalizados', asp.values.pis_rate === '1.65' && asp.values.cofins_rate === '7.6');
  ok('produto divergente recebe exceção em SP', csp.values.cst_icms === '60' && csp.values.icms_rate === '0' && csp.values.cfop === '5405' && csp.sources.cst_icms === 'Exceção do produto em SP', csp.values);
  ok('reforma: IBS/CBS no NCM do estado', asp.values.ibs_uf_rate === '0.1' && asp.values.cbs_rate === '0.9' && asp.values.c_class_trib === '000001' && asp.values.cst_ibs_cbs === '000', asp.values);
  ok('reforma: redução só no produto que tem', csp.values.ibs_uf_reduction === '60' && !bsp.values.ibs_uf_reduction, [csp.values.ibs_uf_reduction, bsp.values.ibs_uf_reduction]);
  const apr = await tax(A, 'PR');
  ok('outro estado com a própria alíquota', apr.values.icms_rate === '19.5' && apr.sources.icms_rate.startsWith('Regra PR'), apr.values);
  const asc = await tax(A, 'SC');
  ok('Simples não entra no ICMS/PIS por padrão', !asc.values.cst_icms && !asc.values.cst_pis, asc.values);
  ok('Simples ainda traz a reforma', asc.values.c_class_trib === '000001');
  const au = await tax(A, 'RS');
  ok('estado sem nota não recebe nada', !au.values.icms_rate);

  const fullA = (await api('GET', `/api/admin/products/${pA.id}`)).body;
  ok('registro no MS e medicamento', fullA.anvisa_registry === '1234567890123' && fullA.is_medicine === true || fullA.is_medicine === 1, [fullA.anvisa_registry, fullA.is_medicine]);
  ok('nome de produto bom não muda', fullA.name === 'Produto A');
  ok('CEST e origem preenchidos', fullA.cest === '1300100' && fullA.tax_origin === '0', [fullA.cest, fullA.tax_origin]);
  const fullD = (await api('GET', `/api/admin/products/${q.product_id}`)).body;
  ok('nome provisório vira o da nota, com entidade decodificada', fullD.name === 'Dipirona & Cia 500mg', fullD.name);
  const fn = await tax(NEW, 'SP');
  ok('produto novo criado com tributos', !!fn.product_id && fn.values.icms_rate === '18', fn.values);
  const newFull = (await api('GET', `/api/admin/products/${fn.product_id}`)).body;
  ok('produto novo: nome e os dois códigos', newFull.name === 'Novo Produto' && newFull.barcodes.map((b) => b.code).sort().join() === [NEW, NEW_T].sort().join(), [newFull.name, newFull.barcodes.map((b) => b.code)]);
  const out = await tax(OTHER, 'SP');
  ok('notas ignoradas não mudam nada e regra manual fica', out.values.icms_rate === '25', out.values);

  // Reimportar as mesmas notas
  const again = await send([files[0]]);
  ok('nota repetida em outro envio é reconhecida', again.preview.notes === 0 && again.preview.ignored.already_imported === 1, again.preview.ignored);
  await api('DELETE', '/api/admin/xml-import');

  // Nota mais antiga não desfaz a recente; a mais nova atualiza
  const old = await send([['old.xml', note({ dh: '2020-01-01T10:00:00-03:00', items: [{ ean: B, icms: ICMS00('7.0000') }] })]]);
  ok('nota antiga não muda o cadastro', old.preview.summary.rules === 0 && old.preview.summary.exceptions === 0, old.preview.summary);
  await apply(old);
  ok('nota antiga: valor continua', (await tax(B, 'SP')).values.icms_rate === '18');
  await api('DELETE', '/api/admin/xml-import');

  // Ajuste manual em outro produto/NCM não é desfeito por lote sem relação
  const rid = (await api('GET', `/api/admin/ncm/${n2.id}`)).body.rule_list[0].id;
  await send([['x.xml', note({ dh: '2026-10-11T10:00:00-03:00', items: [{ ean: A, icms: ICMS00('18.0000'), extra: REFORM() }] })]]).then((x) => apply(x));
  ok('regra manual intacta depois de outro lote', (await api('GET', `/api/admin/ncm/${n2.id}`)).body.rule_list[0].icms_rate === '25' && rid);
  await api('DELETE', '/api/admin/xml-import');

  // Opção: não substituir tributos
  const keep = await send([['y.xml', note({ dh: '2026-10-12T10:00:00-03:00', items: [{ ean: OTHER, icms: ICMS00('12.0000') }] })]]);
  ok('com substituição: troca a regra manual na prévia', keep.preview.rules.some((r) => r.changes.some((c) => c.field === 'icms_rate' && c.to === '12')), keep.preview.summary);
  const off = (await api('POST', '/api/admin/xml-import/plan', { replace_tax: false, create_products: true, replace_registry: false, use_simples: false })).body;
  ok('sem substituição: mantém e informa', !off.preview.rules.some((r) => r.changes.some((c) => c.field === 'icms_rate')) && off.preview.summary.kept_different > 0, off.preview.summary);
  await apply(off);
  ok('sem substituição: regra manual mantida', (await tax(OTHER, 'SP')).values.icms_rate === '25');
  await api('DELETE', '/api/admin/xml-import');

  // Remover a exceção e cadastro da reforma pela API
  const del = await api('DELETE', `/api/admin/products/${pC.id}/tax-uf/SP`);
  ok('remover exceção do estado', del.status === 200 && !del.body.state_exceptions.length);
  ok('sem exceção volta à regra', (await tax(C, 'SP')).values.cst_icms === '00');
  const ru = await api('PUT', `/api/admin/ncm/${n2.id}`, { ibs_uf_rate: '17,7', cst_is: '000', c_class_trib_is: '000001' });
  ok('cadastro do NCM aceita reforma', ru.status === 200 && ru.body.ibs_uf_rate === '17.7', ru.body.error ?? '');
  const cl = await api('POST', '/api/admin/tax-classes', { name: 'Lista positiva', cst_ibs_cbs: '200', c_class_trib: '200032', cbs_reduction: '100', ibs_uf_reduction: '100' });
  ok('classificação aceita redução', cl.status === 201 && cl.body.cbs_reduction === '100', cl.body);
  const bad = await api('PUT', `/api/admin/products/${pO.id}`, { name: 'Outro', ibs_uf_rate: '150' });
  ok('produto recusa alíquota inválida', bad.status === 400, bad.body.error);
  const good = await api('PUT', `/api/admin/products/${pO.id}`, { name: 'Outro', cbs_rate: '8,8' });
  ok('produto aceita exceção de reforma', good.status === 200 && good.body.cbs_rate === '8.8', good.body.cbs_rate);
  ok('API pública mostra a exceção', (await tax(OTHER, 'SP')).values.cbs_rate === '8.8');

  // Mesclagem leva a exceção por estado
  const stored = JSON.stringify([...await st.sql('SELECT * FROM xml_observations'), ...await st.sql('SELECT * FROM xml_imports'), ...await st.sql('SELECT * FROM products')]);
  ok('banco não guarda consumidor', !stored.includes('SECRETO') && !stored.includes('12345678909'));

  // Permissão
  const r401 = await fetch(`${base}/api/admin/xml-import`);
  ok('rota exige login', r401.status === 401);

  // Volume: 1000 notas com 5 itens em blocos, medindo a resposta da API durante a leitura
  const many = [];
  for (let i = 0; i < 1000; i++) many.push([`m${i}.xml`, note({ dh: `2026-10-13T10:${String(i % 60).padStart(2, '0')}:00-03:00`, items: Array.from({ length: 5 }, (_, k) => ({ ean: gtin(`7892${String(i * 5 + k).padStart(8, '0')}`), name: `ITEM ${i}-${k}`, extra: REFORM() })) })]);
  const t0 = Date.now();
  const fd = new FormData();
  for (const [name, content] of many) fd.append('files', new Blob([content]), name);
  const bigStart = await fetch(`${base}/api/admin/xml-import/start`, { method: 'POST', headers: H, body: fd });
  ok('envio grande aceito', bigStart.status === 202, bigStart.status);
  let worst = 0;
  let cur;
  do {
    const t = Date.now();
    await fetch(`${base}/api/v1/categories`);
    worst = Math.max(worst, Date.now() - t);
    cur = (await api('GET', '/api/admin/xml-import')).body;
    await wait(30);
  } while (['reading', 'planning'].includes(cur.status));
  ok('1000 notas lidas', cur.preview?.notes === 1000, `${Date.now() - t0} ms; maior resposta da API ${worst} ms`);
  ok('API responde durante a leitura', worst < 1500, worst);
  const t1 = Date.now();
  const r = await api('POST', '/api/admin/xml-import/apply', { id: cur.id });
  worst = 0;
  do {
    const t = Date.now();
    await fetch(`${base}/api/v1/categories`);
    worst = Math.max(worst, Date.now() - t);
    cur = (await api('GET', '/api/admin/xml-import')).body;
    await wait(30);
  } while (cur.status === 'applying');
  ok('gravação grande', r.status === 202 && cur.status === 'done' && cur.result.products_created === 5000, `${Date.now() - t1} ms; maior resposta ${worst} ms; ${JSON.stringify(cur.result)} ${cur.error ?? ''}`);
  ok('API responde durante a gravação', worst < 1500, worst);
} catch (e) {
  ok('execução', false, e.stack);
} finally {
  const logs = st.logs();
  if (/error|exception/i.test(logs)) console.log('--- log do servidor ---\n' + logs.split('\n').filter((l) => !/Token de/.test(l)).slice(-25).join('\n'));
  await st.stop();
  console.log(failures() ? `\n${failures()} falha(s)` : '\nTudo certo.');
  process.exit(failures() ? 1 : 0);
}
