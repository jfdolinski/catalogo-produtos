// PostgreSQL local para desenvolvimento e testes, sem instalar nada: o PGlite (PostgreSQL em WebAssembly) atende na porta indicada.
// Uso: node scripts/pg-local.mjs [porta=5433] [pasta dos dados; vazio = só em memória]
// Depois: DATABASE_URL=postgres://postgres@localhost:5433/postgres
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2] || 5433);
const dir = process.argv[3];
const db = await PGlite.create(dir ? { dataDir: dir } : {});
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
console.log(`PostgreSQL (PGlite) pronto em postgres://postgres@localhost:${port}/postgres${dir ? ` — dados em ${dir}` : ' — em memória'}`);
const stop = async () => { await server.stop(); await db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
