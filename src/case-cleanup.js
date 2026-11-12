// Conversão única dos produtos já cadastrados para "maiúsculas por palavra" (nome, marca, fabricante, categoria).
// Roda uma vez, em segundo plano, depois que o servidor sobe; em blocos, para não travar a API.
// Cada valor antigo fica em text_cleanup_log (status 'maiusculas'), para conferir ou desfazer.
// Não renova prazo nem mexe nas datas por campo: é só formatação.
import { db, tx } from './db.js';
import { CASE_FIELDS, cleanProductField } from './text.js';

export const CASE_FLAG = 'migr_maiusculas_por_palavra';
const BLOCO = 500;

export async function runCaseCleanup(log = console.log) {
  if (await db.get('SELECT 1 FROM settings WHERE key = ?', CASE_FLAG)) return null;
  const fields = [...CASE_FIELDS];
  const out = { products: 0, values: 0 };
  let lastId = 0;
  const inicio = Date.now();
  for (;;) {
    const rows = await db.all(`SELECT id, ${fields.join(', ')} FROM products WHERE id > ? ORDER BY id LIMIT ?`, lastId, BLOCO);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    await tx(async () => {
      for (const row of rows) {
        const changed = {};
        for (const f of fields) {
          const old = String(row[f] ?? '');
          const now = cleanProductField(f, old);
          if (now !== old) changed[f] = [old, now];
        }
        const cols = Object.keys(changed);
        if (!cols.length) continue;
        await db.run(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => changed[c][1]), row.id);
        for (const c of cols) {
          await db.run(`INSERT INTO text_cleanup_log (table_name, row_id, column_name, old_value, new_value, status)
            VALUES ('products', ?, ?, ?, ?, 'maiusculas')`, row.id, c, changed[c][0], changed[c][1]);
        }
        out.products++;
        out.values += cols.length;
      }
    });
    // Respiro entre blocos: a API continua respondendo durante a conversão
    await new Promise((r) => setTimeout(r, 20));
  }
  await db.run("INSERT INTO settings (key, value) VALUES (?, datetime('now')) ON CONFLICT (key) DO NOTHING", CASE_FLAG);
  log(`Maiúsculas por palavra: ${out.products} produto(s), ${out.values} valor(es) convertidos em ${Math.round((Date.now() - inicio) / 1000)} s (valores antigos em text_cleanup_log).`);
  return out;
}
