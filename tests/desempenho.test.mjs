// Tempos das rotas mais pesadas com o volume da produção (29 mil produtos, 1/4 pendentes), contra o PostgreSQL.
// Também mede o maior atraso de uma consulta pública enquanto cada rota roda. Uso: node tests/desempenho.test.mjs
// Os limites são folgados: o PostgreSQL de teste (PGlite) é mais lento que o de verdade e atende uma conexão por vez.
import { startStack, checker, wait } from './helper.mjs';

const { ok, failures } = checker();
const st = await startStack();
const { base, H } = st;

try {
  await st.sql(`INSERT INTO ncm (code, description, search) SELECT (30040000 + i)::text, 'Medicamento ' || i, (30040000 + i)::text || ' medicamento' FROM generate_series(0, 799) AS i`);
  await st.sql(`INSERT INTO products (name, brand, ncm, active, created_at, updated_at, data_updated_at, images_updated_at)
    SELECT CASE WHEN i % 4 = 0 THEN 'PRODUTO NÃO CADASTRADO ' || i ELSE 'MEDICAMENTO ' || ((i * 7919) % 29000) || ' DIPIRONA 500MG' END,
           'Marca ' || (i % 40), (30040000 + i % 800)::text, CASE WHEN i % 3 = 0 THEN 0 ELSE 1 END,
           sqlite_datetime('now', '-' || (i % 400) || ' days'), sqlite_datetime('now', '-' || (i % 400) || ' days'),
           sqlite_datetime('now', '-' || (i % 400) || ' days'), sqlite_datetime('now', '-' || (i % 400) || ' days')
    FROM generate_series(1, 29000) AS i ORDER BY i`);
  await st.sql(`INSERT INTO barcodes (product_id, code, type, note, created_at, updated_at)
    SELECT id, (7890000000000 + id)::text, 'EAN-13', '', sqlite_datetime('now'), sqlite_datetime('now') FROM products`);
  await st.sql(`INSERT INTO barcode_requests (code, product_id, last_source, request_count)
    SELECT (7890000000000 + id)::text, id, 'Empresa', 1 + id % 9 FROM products WHERE name LIKE 'PRODUTO NÃO%'`);
  await st.sql(`INSERT INTO field_dates (product_id, field) SELECT p.id, f FROM products p, unnest(ARRAY['name', 'active', 'ncm', 'brand']) AS f`);
  await st.sql(`INSERT INTO lookup_stats (source, day, hits) SELECT 'Empresa ' || s, sqlite_date('now', '-' || d || ' days'), 100 + d
    FROM generate_series(0, 59) AS d, generate_series(0, 7) AS s`);
  await st.sql('ANALYZE');

  const code = (await st.sql('SELECT code FROM barcodes LIMIT 1'))[0].code;
  const routes = [
    ['consulta pública por código', `/api/v1/barcodes/${code}`, {}, 300],
    ['lista pública, página alta', '/api/v1/products?limit=50&page=400', {}, 2000],
    ['dashboard', '/api/admin/dashboard', H, 5000],
    ['lista do painel com filtro de pendentes', '/api/admin/products?limit=50&pending=1', H, 2000],
    ['fila de pendentes (ids)', '/api/admin/product-ids?pending=1&order=requests', H, 3000],
    ['busca por texto', '/api/admin/products?limit=50&q=dipirona', H, 3000],
    ['planilha de nomes, início', '/api/admin/product-names?limit=200', H, 2000],
    ['planilha de nomes, final', '/api/admin/product-names?limit=200&offset=28800', H, 2000],
    ['planilha por código', '/api/admin/product-names?limit=200&sort=code', H, 3000],
    ['lista de NCM', '/api/admin/ncm?limit=100', H, 2000],
    ['vence hoje', '/api/admin/products?limit=1&due_today=1', H, 3000],
  ];
  for (const [name, url, headers, limit] of routes) {
    let running = true;
    let worst = 0;
    const probe = (async () => {
      while (running) {
        const t = performance.now();
        await fetch(`${base}/api/v1/categories`).then((r) => r.arrayBuffer()).catch(() => {});
        worst = Math.max(worst, performance.now() - t);
        await wait(10);
      }
    })();
    const times = [];
    let status = 0;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const r = await fetch(base + url, { headers });
      await r.arrayBuffer();
      status = r.status;
      times.push(performance.now() - t);
    }
    running = false;
    await probe;
    const med = Math.round([...times].sort((a, b) => a - b)[1]);
    ok(`${name}: ${med} ms`, status === 200 && med < limit, `limite ${limit} ms; maior atraso de consulta pública ${Math.round(worst)} ms`);
  }
} catch (e) {
  ok('execução', false, e.stack);
} finally {
  await st.stop();
  console.log(failures() ? `\n${failures()} falha(s)` : '\nTudo certo.');
  process.exit(failures() ? 1 : 0);
}
