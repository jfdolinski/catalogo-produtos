// Migração manual do SQLite para o PostgreSQL. Uso:
//   DATABASE_URL=postgres://... node scripts/migrar-sqlite.mjs caminho/do/catalogo.db
// Cria o esquema se faltar e copia tudo; só roda com o PostgreSQL sem produtos.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrateFromSqlite } from '../src/migrate-sqlite.js';

const file = process.argv[2];
if (!file || !process.env.DATABASE_URL) {
  console.error('Uso: DATABASE_URL=postgres://... node scripts/migrar-sqlite.mjs caminho/do/catalogo.db');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'schema.sql'), 'utf8');
  await pool.query(schema);
  const t = Date.now();
  await migrateFromSqlite(path.resolve(file), pool);
  console.log(`Migração concluída em ${Math.round((Date.now() - t) / 1000)} s.`);
} catch (e) {
  console.error(`Migração não concluída (nada foi gravado): ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
