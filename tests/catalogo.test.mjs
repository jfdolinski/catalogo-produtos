// Cache do catálogo completo com o volume da produção (26 mil produtos), contra o PostgreSQL. Uso: node tests/catalogo.test.mjs
import http from 'node:http';
import { startStack, checker, wait } from './helper.mjs';

const TTL = 6;
const { ok, failures } = checker();
const st = await startStack({ env: { CATALOGO_CACHE_SEGUNDOS: String(TTL) } });
const { base } = st;
const H = { ...st.H, 'Content-Type': 'application/json' };

// Volume da produção, direto no banco (aspas e ponto e vírgula no nome, para testar o CSV)
await st.sql(`INSERT INTO products (name, brand, active)
  SELECT 'PRODUTO "' || ((i * 7919) % 26096) || '"; TESTE', 'Marca ' || (i % 40), CASE WHEN i % 100 = 0 THEN 0 ELSE 1 END
  FROM generate_series(1, 26096) AS i ORDER BY i`);
await st.sql(`INSERT INTO barcodes (product_id, code, type, note, created_at, updated_at)
  SELECT id, (7890000000000 + id)::text, 'EAN-13', '', sqlite_datetime('now'), sqlite_datetime('now') FROM products`);
await st.sql(`INSERT INTO field_dates (product_id, field) SELECT p.id, f FROM products p,
  unnest(ARRAY['name', 'active', 'ncm', 'brand', 'category', 'description', 'tax_origin', 'cest']) AS f`);

const raw = (url, headers = {}) => new Promise((done, fail) => http.get(base + url, { headers }, (r) => {
  const parts = [];
  r.on('data', (d) => parts.push(d));
  r.on('end', () => done({ status: r.statusCode, headers: r.headers, body: Buffer.concat(parts) }));
  r.on('error', fail);
}).on('error', fail));

try {
  // Primeira montagem: as consultas públicas não podem ficar paradas
  let running = true; let worst = 0;
  const probe = (async () => { while (running) { const t = performance.now(); await fetch(`${base}/api/v1/categories`).then((r) => r.arrayBuffer()); worst = Math.max(worst, performance.now() - t); await wait(10); } })();
  let t = performance.now();
  const [a, b] = await Promise.all([fetch(`${base}/api/v1/catalog.json`), fetch(`${base}/api/v1/catalog.json`)]);
  const firstMs = Math.round(performance.now() - t);
  // A sonda para antes de interpretar o JSON: isso roda neste processo e atrasaria a própria medição
  running = false;
  await probe;
  const j = await a.json();
  const j2 = await b.json();
  ok('montagem sem parar o servidor', worst < 400, `${firstMs} ms para montar; maior atraso público ${Math.round(worst)} ms`);
  const active = (await (await fetch(`${base}/api/v1/products?limit=1`)).json()).total;
  ok('total confere e chamadas simultâneas recebem o mesmo', j.total === active && j.items.length === active && j.generated_at === j2.generated_at, [j.total, j.items.length, active]);
  ok('nenhum inativo no catálogo', j.items.every((p) => p.active));
  const names = j.items.map((p) => p.name.toLowerCase());
  ok('ordem por nome', names.every((n, i) => !i || names[i - 1] <= n));
  const pid = j.items[100].id;
  const direct = await (await fetch(`${base}/api/v1/products/${pid}`)).json();
  const { review: r1, ...x1 } = j.items[100];
  const { review: r2, ...x2 } = direct;
  ok('item igual ao da API do produto', JSON.stringify(x1) === JSON.stringify(x2), Object.keys(x1).filter((k) => JSON.stringify(x1[k]) !== JSON.stringify(x2[k])));

  t = performance.now();
  const gz = await raw('/api/v1/catalog.json', { 'Accept-Encoding': 'gzip' });
  const cachedMs = Math.round(performance.now() - t);
  ok('cópia pronta é imediata e comprimida', cachedMs < 300 && gz.headers['content-encoding'] === 'gzip', `${cachedMs} ms; ${Math.round(gz.body.length / 1024)} KB`);
  ok('não comprime duas vezes', JSON.parse((await import('node:zlib')).gunzipSync(gz.body)).total === active);
  const plain = await raw('/api/v1/catalog.json', { 'Accept-Encoding': 'identity' });
  ok('cliente sem gzip recebe JSON puro', !plain.headers['content-encoding'] && JSON.parse(plain.body).total === active, `${Math.round(plain.body.length / 1024)} KB`);
  const etag = gz.headers.etag;
  const not = await raw('/api/v1/catalog.json', { 'If-None-Match': etag });
  ok('304 quando nada mudou', not.status === 304 && !not.body.length && not.headers.etag === etag, not.status);
  const viaFetch = await fetch(`${base}/api/v1/catalog.json`, { headers: { 'If-None-Match': etag } });
  ok('304 também pelo fetch, que envia no-cache', viaFetch.status === 304, viaFetch.status);
  const weak = await raw('/api/v1/catalog.json', { 'If-None-Match': `"outra", W/${etag}` });
  ok('304 com lista de ETags e forma fraca', weak.status === 304, weak.status);
  const other = await raw('/api/v1/catalog.json', { 'If-None-Match': '"outra"' });
  ok('ETag diferente recebe o catálogo', other.status === 200 && other.body.length > 1000, other.status);
  ok('CORS mantido', gz.headers['access-control-allow-origin'] === '*', gz.headers['access-control-allow-origin']);

  const csvR = await fetch(`${base}/api/v1/catalog.csv`);
  const csv = await csvR.text();
  const lines = csv.split('\r\n');
  ok('CSV: BOM removido pelo leitor, cabeçalho, linhas e download', lines[0].replace(/^﻿/, '').startsWith('id;sku;nome') && lines.length === active + 1 && csvR.headers.get('content-disposition')?.includes('catalogo.csv') && csvR.headers.get('content-type').includes('text/csv'), [lines.length, active]);
  ok('CSV: aspas escapadas', lines[1].includes('""'), lines[1].slice(0, 50));
  const hd = await fetch(`${base}/api/v1/catalog.json`, { method: 'HEAD' });
  ok('HEAD responde', hd.status === 200 && hd.headers.get('etag') === etag);

  // Alteração: fica fora até vencer; a chamada depois do prazo devolve a cópia e monta outra; a seguinte já traz
  await fetch(`${base}/api/admin/products/${pid}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: 'AAA NOME ALTERADO' }) });
  const hasNew = async () => ((await (await fetch(`${base}/api/v1/catalog.json`)).json()).items[0].name === 'AAA NOME ALTERADO');
  ok('dentro do prazo continua a cópia', !(await hasNew()));
  await wait(TTL * 1000 + 300);
  let appeared = false;
  for (let i = 0; i < 30 && !appeared; i++) { appeared = await hasNew(); if (!appeared) await wait(500); }
  ok('depois do prazo a alteração aparece', appeared);
  const etag2 = (await raw('/api/v1/catalog.json')).headers.etag;
  ok('ETag muda com o conteúdo', etag2 !== etag);
  // Sem nenhuma chamada além do limite: espera a nova, nunca entrega cópia velha demais
  await fetch(`${base}/api/admin/products/${pid}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: 'AAB NOME DE NOVO' }) });
  await wait(TTL * 2000 + 300);
  const late = await (await fetch(`${base}/api/v1/catalog.json`)).json();
  ok('depois do limite não entrega cópia velha', late.items[0].name === 'AAB NOME DE NOVO', late.items[0].name);
  const same1 = await raw('/api/v1/catalog.json');
  await wait(TTL * 1000 + 300);
  await raw('/api/v1/catalog.json');
  await wait(4000);
  const same2 = await raw('/api/v1/catalog.json');
  ok('sem alteração mantém a ETag ao remontar', same1.headers.etag === same2.headers.etag);
  ok('sem erro no servidor', !/catálogo:|Error/.test(st.logs()), st.logs().slice(0, 200));
} catch (e) { ok('execução', false, e.stack); } finally {
  await st.stop();
  console.log(failures() ? `${failures()} falha(s)` : 'Tudo certo.');
  process.exit(failures() ? 1 : 0);
}
