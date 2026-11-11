// Limpeza única dos espaços nos dados gravados antes do tratamento automático (roda uma vez, ao iniciar o serviço).
// Guarda o valor antigo de cada alteração em text_cleanup_log, para poder conferir ou desfazer.
// Em campo de valor único, se a limpeza criar duplicidade, mantém o valor antigo e registra.
// Ficam de fora: login (é o que a pessoa digita para entrar), faturas (são o retrato do fechamento) e estatísticas de consulta.
import { db } from './db.js';
import { tx } from './business.js';
import { cleanField } from './text.js';

const COLUMNS = {
  products: ['sku', 'name', 'description', 'brand', 'category', 'unit', 'manufacturer', 'tax_notes',
    'med_type', 'med_stripe', 'med_controlled', 'med_form', 'med_presentation', 'med_therapeutic_class', 'med_notes'],
  barcodes: ['note'],
  barcode_requests: ['last_source'],
  dcb: ['code', 'name', 'cas'],
  product_dcb: ['concentration'],
  ncm: ['description', 'notes'],
  ncm_rules: ['notes'],
  tax_classes: ['code', 'name', 'notes'],
  users: ['name'],
  plans: ['name'],
  companies: ['razao_social', 'nome_fantasia', 'situacao', 'natureza_juridica', 'porte', 'cnae', 'logradouro', 'numero', 'complemento',
    'bairro', 'municipio', 'telefone', 'email', 'contato_nome', 'contato_email', 'contato_telefone', 'notes'],
};
const FLAG = 'migr_limpeza_espacos';

db.exec(`CREATE TABLE IF NOT EXISTS text_cleanup_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT NOT NULL,
  row_id      INTEGER NOT NULL,
  column_name TEXT NOT NULL,
  old_value   TEXT NOT NULL,
  new_value   TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`);

export function runTextCleanup() {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(FLAG)) return;
  const log = db.prepare('INSERT INTO text_cleanup_log (table_name, row_id, column_name, old_value, new_value, status) VALUES (?, ?, ?, ?, ?, ?)');
  const trackField = db.prepare(`INSERT INTO field_dates (product_id, field) VALUES (?, ?)
    ON CONFLICT(product_id, field) DO UPDATE SET updated_at = datetime('now')`);
  try {
    tx(() => {
      for (const [table, columns] of Object.entries(COLUMNS)) {
        const hasUpdatedAt = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'updated_at');
        const stamp = hasUpdatedAt ? ", updated_at = datetime('now')" : '';
        for (const column of columns) {
          const rows = db.prepare(`SELECT rowid AS row_id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`).all();
          const update = db.prepare(`UPDATE ${table} SET ${column} = ?${stamp} WHERE rowid = ?`);
          for (const { row_id: rowId, value } of rows) {
            if (typeof value !== 'string') continue;
            const clean = cleanField(column, value);
            if (clean === value) continue;
            // Só espaços em campo obrigatório não pode virar vazio
            if (!clean && column === 'name') { log.run(table, rowId, column, value, clean, 'mantido: ficaria vazio'); continue; }
            try {
              update.run(clean, rowId);
              log.run(table, rowId, column, value, clean, 'alterado');
              if (table === 'products') trackField.run(rowId, column);
            } catch (e) {
              if (!/UNIQUE/i.test(e.message)) throw e;
              log.run(table, rowId, column, value, clean, 'mantido: duplicidade');
            }
          }
        }
      }
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(FLAG, new Date().toISOString());
    });
    console.log('Limpeza de espaços:', JSON.stringify(textCleanupSummary()));
  } catch (e) {
    // Tudo ou nada: nada foi alterado, o serviço segue e a limpeza tenta de novo no próximo início
    console.error('Limpeza de espaços não concluída:', e);
  }
}

export function textCleanupSummary() {
  return {
    finished_at: db.prepare('SELECT value FROM settings WHERE key = ?').get(FLAG)?.value ?? null,
    items: db.prepare('SELECT table_name, column_name, status, COUNT(*) AS n FROM text_cleanup_log GROUP BY 1, 2, 3 ORDER BY 1, 2, 3').all(),
  };
}
