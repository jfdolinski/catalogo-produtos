// Copia os dados do banco SQLite antigo para o PostgreSQL, tudo ou nada.
// Só roda com o PostgreSQL sem produtos (não mistura bases). Antes, faz uma cópia de segurança do arquivo SQLite.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Ordem das chaves estrangeiras: quem é referenciado vem antes
const TABLES = ['products', 'barcodes', 'images', 'barcode_requests', 'field_dates', 'merges', 'lookup_stats', 'autofill_log', 'lookup_cache',
  'settings', 'dcb', 'product_dcb', 'ncm', 'tax_classes', 'ncm_rules', 'users', 'sessions', 'plans', 'companies', 'company_usage', 'invoices',
  'product_tax_uf', 'xml_observations', 'xml_imports', 'xml_documents', 'text_cleanup_log'];
const MAX_PARAMS = 30000;

// pool: conexão pg (Pool ou Client); log: função de mensagem
export async function migrateFromSqlite(sqlitePath, pool, log = console.log) {
  if (!fs.existsSync(sqlitePath)) throw new Error(`arquivo SQLite não encontrado: ${sqlitePath}`);
  const already = (await pool.query('SELECT COUNT(*)::int AS n FROM products')).rows[0].n;
  if (already) throw new Error(`o PostgreSQL já tem ${already} produto(s); a migração só roda num banco vazio`);

  const backup = `${sqlitePath}.antes-postgres-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  fs.copyFileSync(sqlitePath, backup);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(sqlitePath + ext)) fs.copyFileSync(sqlitePath + ext, backup + ext);
  log(`cópia de segurança do SQLite: ${backup}`);

  const lite = new DatabaseSync(sqlitePath);
  lite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // o que estava só no -wal entra no arquivo principal
  const liteTables = new Set(lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  const counts = [];
  try {
    await client.query('BEGIN');
    for (const table of TABLES) {
      if (!liteTables.has(table)) { counts.push([table, 0, 0]); continue; }
      const pgCols = new Set((await client.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map((r) => r.column_name));
      const cols = lite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((c) => pgCols.has(c));
      const rows = lite.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`).all();
      const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        const params = [];
        const values = chunk.map((r) => `(${cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(', ')})`);
        await client.query(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${values.join(', ')}`, params);
      }
      // A numeração dos ids continua de onde parou
      if (pgCols.has('id')) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT MAX(id) FROM ${table}) IS NOT NULL)`);
      }
      const pgCount = (await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
      counts.push([table, rows.length, pgCount]);
      if (pgCount !== rows.length) throw new Error(`${table}: ${rows.length} no SQLite, ${pgCount} no PostgreSQL`);
    }
    const extra = [...liteTables].filter((t) => !TABLES.includes(t) && !t.startsWith('sqlite_'));
    if (extra.length) throw new Error(`tabelas do SQLite sem destino: ${extra.join(', ')}`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (client !== pool) client.release();
    lite.close();
  }
  for (const [t, a, b] of counts) if (a || b) log(`  ${t}: ${a} -> ${b}`);
  return { backup, counts };
}
