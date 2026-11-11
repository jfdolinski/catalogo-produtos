// Verifica o catálogo publicado. Uso: node deploy/verificar.mjs https://dominio [arquivo-config-com-token]
import fs from 'node:fs';
import net from 'node:net';

const [, , base = 'https://catalogo.b6nhiy.easypanel.host', configPath = 'data/config.json'] = process.argv;
const token = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')).adminToken : null;
const host = new URL(base).hostname;
let falhas = 0;
const ok = (nome, cond, info = '') => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${nome}${info ? ' — ' + info : ''}`); if (!cond) falhas++; };

let r;
for (let i = 0; i < 20; i++) { // o certificado pode levar alguns segundos na primeira vez
  try { r = await fetch(`${base}/api/v1/categories`); break; } catch { await new Promise((s) => setTimeout(s, 3000)); }
}
ok('HTTPS com certificado válido', r?.ok, r ? `status ${r.status}` : 'sem resposta');

r = await fetch(`http://${host}/`, { redirect: 'manual' });
ok('HTTP redireciona para HTTPS', r.status >= 300 && r.status < 400 && r.headers.get('location')?.startsWith('https://'), `${r.status} -> ${r.headers.get('location')}`);

r = await fetch(`${base}/`);
ok('painel na raiz', r.ok && (await r.text()).includes('Dashboard'));

r = await fetch(`${base}/api/v1/products?limit=1`);
const lista = await r.json();
ok('API pública', r.ok, `${lista.total} produto(s) ativos`);
const p = lista.items[0];
ok('links gerados com o domínio', p?.links.page.startsWith(base), p?.links.page);

if (p?.barcodes[0]) {
  r = await fetch(`${base}/img/${p.barcodes[0].code}`, { redirect: 'manual' });
  const loc = r.headers.get('location');
  ok('/img/{codigo} redireciona', r.status === 302, loc);
  r = await fetch(new URL(loc, base));
  ok('arquivo de imagem', r.ok && r.headers.get('content-type')?.startsWith('image/'), r.headers.get('content-type'));
}

if (token) {
  r = await fetch(`${base}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  ok('API admin com o token', r.ok, `${d.products?.total} produtos, ${d.products?.pending} pendentes`);
  const tDash = Date.now();
  r = await fetch(`${base}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
  await r.arrayBuffer();
  ok('dashboard responde em menos de 2 s', Date.now() - tDash < 2000, `${Date.now() - tDash} ms`);
  r = await fetch(`${base}/api/v1/products?limit=50`, { headers: { 'Accept-Encoding': 'gzip' } });
  await r.arrayBuffer();
  ok('respostas comprimidas', r.headers.get('content-encoding') === 'gzip', r.headers.get('content-encoding') ?? 'sem compressão');
  ok('conexões filtradas por 7 dias por padrão', !!d.lookups?.period?.from && !!d.lookups?.period?.to, `${d.lookups?.period?.from} a ${d.lookups?.period?.to}: ${d.lookups?.sources?.length} conexão(ões)`);
  r = await fetch(`${base}/api/admin/dashboard?de=2026-02-31`, { headers: { Authorization: `Bearer ${token}` } });
  ok('dashboard recusa data inválida', r.status === 400);
}
r = await fetch(`${base}/api/admin/dashboard`);
ok('API admin bloqueada sem token', r.status === 401);

// Ferramentas de atualização (somente leitura; a prévia de importação não grava)
if (token) {
  const H = { Authorization: `Bearer ${token}` };
  r = await fetch(`${base}/update.js`);
  ok('tela de Atualização publicada', r.ok && (await r.text()).includes('Fila de atualização'));
  r = await fetch(`${base}/api/admin/settings`, { headers: H });
  const s = await r.json();
  ok('parâmetros com token Cosmos oculto', r.ok && 'cosmos_token_set' in s && !('cosmos_token' in s), `cosmos configurado: ${s.cosmos_token_set}`);
  r = await fetch(`${base}/api/admin/product-ids?pending=1&order=requests`, { headers: H });
  ok('fila (ids de pendentes)', r.ok, `${(await r.json()).ids?.length} itens`);
  r = await fetch(`${base}/api/admin/autofill`, { headers: H });
  const af = await r.json();
  ok('busca automática disponível', r.ok && 'running' in af, af.running ? 'em andamento' : 'parada');
  r = await fetch(`${base}/api/admin/lookup/7891000315507?cosmos=0`, { headers: H }); // não gasta a franquia da Cosmos
  const lk = await r.json();
  ok('busca externa a partir da VPS', r.ok && lk.results?.some((x) => x.name), lk.results?.map((x) => `${x.source}: ${x.name || x.error || 'nada'}`).join(' | '));
  const fd = new FormData();
  fd.append('file', new Blob(['﻿codigo_barras;nome\r\n7891000315508;teste\r\n']), 'verificacao.csv');
  r = await fetch(`${base}/api/admin/import/preview`, { method: 'POST', headers: H, body: fd });
  const pv = await r.json();
  ok('prévia de importação', r.ok && pv.plan?.[0]?.action === 'error', pv.plan?.[0]?.error);
  r = await fetch(`${base}/api/admin/bulk`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
  ok('edição em massa (validação)', r.status === 400);

  // Empresas, cobrança e usuários (somente leitura; a busca de CNPJ é numa base pública)
  r = await fetch(`${base}/api/admin/cnpj/33000167000101`, { headers: H });
  const cj = await r.json();
  ok('busca de CNPJ a partir da VPS', r.ok && !!cj.data?.razao_social, cj.source_name || cj.error);
  r = await fetch(`${base}/api/admin/billing`, { headers: H });
  const bi = await r.json();
  ok('cobrança', r.ok && Array.isArray(bi.items), `${bi.items?.length} empresa(s) em ${bi.period}`);
  r = await fetch(`${base}/api/admin/ai/status`, { headers: H });
  const ia = await r.json();
  ok('geração de imagem por IA (status)', r.ok && 'ready' in ia, ia.ready ? `${ia.provider_name} ${ia.model}` : 'não configurada');
  r = await fetch(`${base}/api/admin/dcb?limit=1`, { headers: H });
  ok('lista DCB', r.ok, `${(await r.json()).total} princípio(s) ativo(s)`);
  r = await fetch(`${base}/dcb.js`);
  ok('tela de DCB publicada', r.ok && (await r.text()).includes('previewDcbFile'));
  r = await fetch(`${base}/api/v1/products?limit=1`);
  ok('API pública com os campos novos', r.ok && 'ncm' in ((await r.json()).items[0] || {}));
  r = await fetch(`${base}/api/admin/ncm?limit=1`, { headers: H });
  const nc = await r.json();
  ok('cadastro de NCM', r.ok, `${nc.total} NCM(s); ${nc.products_no_ncm} produto(s) sem NCM`);
  r = await fetch(`${base}/api/admin/tax-classes`, { headers: H });
  ok('classificações tributárias', r.ok, `${(await r.json()).length} classificação(ões)`);
  r = await fetch(`${base}/ncm.js`);
  ok('tela de NCM publicada', r.ok && (await r.text()).includes('renderTaxPreview'));
  r = await fetch(`${base}/ncm-import.js`);
  ok('importação de NCM publicada', r.ok && (await r.text()).includes('previewTaxFile'));
  const fdNcm = new FormData();
  fdNcm.append('file', new Blob(['ncm;descricao\r\n12;verificacao\r\n']), 'verificacao.csv'); // prévia não grava
  r = await fetch(`${base}/api/admin/ncm/import/preview`, { method: 'POST', headers: H, body: fdNcm });
  ok('prévia da importação de NCM', r.ok && (await r.json()).summary?.skip === 1);
  if (p) {
    r = await fetch(`${base}/api/v1/products/${p.id}/tax?uf=SP`);
    ok('tributação do produto pela API', r.ok && 'values' in (await r.json()));
  }
  r = await fetch(`${base}/names.js`);
  ok('planilha de nomes publicada', r.ok && (await r.text()).includes('saveNames'));
  r = await fetch(`${base}/api/admin/product-names?limit=1&sort=code`, { headers: H });
  const nm = await r.json();
  ok('lista da planilha de nomes', r.ok && nm.items?.length === 1, `${nm.total} produto(s)`);
  r = await fetch(`${base}/api/admin/product-names`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
  ok('gravação de nomes (validação)', r.status === 400);
  r = await fetch(`${base}/xml-import.js`);
  ok('tela de importação de XML publicada', r.ok && (await r.text()).includes('xmlSend'));
  r = await fetch(`${base}/api/admin/xml-import`, { headers: H });
  ok('importação de XML disponível', r.ok && 'status' in (await r.json()));
  if (p) {
    r = await fetch(`${base}/api/v1/products/${p.id}/tax?uf=SP`);
    ok('tributação por estado responde', r.ok && (await r.json()).uf === 'SP');
  }
  r = await fetch(`${base}/api/admin/users`, { headers: H });
  ok('usuários', r.ok, `${(await r.json()).items?.length} usuário(s)`);
}

r = await fetch(`${base}/api/v1/catalog.json`);
const catalogo = await r.json();
ok('catálogo completo', r.ok && catalogo.total === catalogo.items.length, `${catalogo.total} produto(s) em ${catalogo.generated_at}`); // pode estar até 10 min atrás da lista
const etagCatalogo = r.headers.get('etag');
const tCatalogo = Date.now();
r = await fetch(`${base}/api/v1/catalog.json`, { headers: { 'If-None-Match': etagCatalogo } });
ok('catálogo em cache responde 304', r.status === 304, `${Date.now() - tCatalogo} ms`);
r = await fetch(`${base}/api/v1/catalog.csv`);
ok('catálogo em CSV', r.ok && (await r.text()).includes('codigos_barras'));

r = await fetch(`${base}/padrao/1.png`);
ok('imagem padrão', r.ok && r.headers.get('content-type')?.startsWith('image/'), r.headers.get('content-type'));
r = await fetch(`${base}/consulta/`);
ok('tela de consulta pública', r.ok && (await r.text()).includes('Consulta de produtos'));
r = await fetch(`${base}/api/consulta?q=${p?.barcodes[0]?.code || 'teste'}`);
ok('consulta pública sem login', r.ok, `${(await r.json()).total} resultado(s)`);
r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"login":"verificacao-inexistente","password":"x"}' });
ok('login recusa usuário inexistente', r.status === 401);

const aberta = await new Promise((res) => {
  const s = net.connect({ host, port: 8091, timeout: 4000 }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); });
});
ok('porta 8091 fechada para a internet', !aberta);

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
