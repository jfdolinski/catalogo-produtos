// Resumo da limpeza única de espaços feita nos dados antigos (quando o banco ainda era SQLite).
// Os dados vieram limpos para o PostgreSQL; o registro de cada valor antigo continua em text_cleanup_log.
import { db, getFlag } from './db.js';

const FLAG = 'migr_limpeza_espacos';

export async function textCleanupSummary() {
  return {
    finished_at: getFlag(FLAG) ?? null,
    items: await db.all('SELECT table_name, column_name, status, COUNT(*) AS n FROM text_cleanup_log GROUP BY 1, 2, 3 ORDER BY 1, 2, 3'),
  };
}
