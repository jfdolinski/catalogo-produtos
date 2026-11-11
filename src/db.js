// Banco PostgreSQL (DATABASE_URL). As consultas do sistema foram escritas para o SQLite; a função translate()
// converte o que difere (parâmetros "?", datas, INSERT OR IGNORE, COLLATE NOCASE, LIKE), para o SQL continuar legível.
// Transações: tx(async () => ...) — tudo que roda dentro dela, mesmo em outras funções, usa a mesma conexão.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Fuso das datas "locais" (dashboard, estatísticas por dia, "hoje")
export const APP_TZ = process.env.APP_TZ || 'America/Sao_Paulo';

// COUNT/SUM voltam como bigint/numeric, que o driver entrega como texto: aqui viram número
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Defina DATABASE_URL (ex.: postgres://usuario:senha@host:5432/catalogo)');
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10,
  options: `-c app.tz=${APP_TZ}`,
});
pool.on('error', (e) => console.error('PostgreSQL: conexão ociosa com erro', e.message));

const store = new AsyncLocalStorage();
const runner = () => store.getStore() ?? pool;

// ---- Tradução do SQL ------------------------------------------------------------

// "x COLLATE NOCASE" -> "lower(x)", onde x é uma coluna (p.name) ou uma chamada de função com parênteses (COALESCE(...))
function nocase(sql) {
  const marker = ' COLLATE NOCASE';
  let out = sql;
  for (let at = out.toUpperCase().indexOf(marker); at >= 0; at = out.toUpperCase().indexOf(marker)) {
    let start = at;
    if (out[at - 1] === ')') {
      let depth = 0;
      for (start = at - 1; start >= 0; start--) {
        if (out[start] === ')') depth++;
        else if (out[start] === '(' && --depth === 0) break;
      }
    }
    while (start > 0 && /[\w.]/.test(out[start - 1])) start--;
    out = `${out.slice(0, start)}lower(${out.slice(start, at)})${out.slice(at + marker.length)}`;
  }
  return out;
}

const cache = new Map();
export function translate(sql) {
  let out = cache.get(sql);
  if (out) return out;
  out = nocase(sql)
    .replace(/\bdatetime\(/g, 'sqlite_datetime(')
    .replace(/(?<![\w.])date\(/g, 'sqlite_date(')
    .replace(/(\s)LIKE(\s)/g, '$1ILIKE$2');
  if (/INSERT OR IGNORE INTO/i.test(out)) {
    out = out.replace(/INSERT OR IGNORE INTO/i, 'INSERT INTO');
    const ret = out.search(/\sRETURNING\s/i);
    out = ret >= 0 ? `${out.slice(0, ret)} ON CONFLICT DO NOTHING${out.slice(ret)}` : `${out.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
  }
  // "?" -> $1, $2... (fora de textos entre aspas)
  let n = 0;
  let quoted = false;
  let res = '';
  for (const ch of out) {
    if (ch === "'") quoted = !quoted;
    res += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  cache.set(sql, res);
  return res;
}

async function query(sql, params) {
  try {
    return await runner().query(translate(sql), params);
  } catch (e) {
    e.message = `${e.message} — SQL: ${translate(sql).replace(/\s+/g, ' ').slice(0, 300)}`;
    throw e;
  }
}

// INSERT devolve o id criado, como o lastInsertRowid do SQLite
async function run(sql, params) {
  const insert = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql);
  const r = await query(insert ? `${sql.replace(/;\s*$/, '')} RETURNING *` : sql, params);
  return { changes: r.rowCount, rows: r.rows, lastInsertRowid: insert ? r.rows[0]?.id : undefined };
}

// Mesma forma de uso de antes (db.prepare(sql).get/all/run), agora com await
export const db = {
  prepare(sql) {
    return {
      get: async (...params) => (await query(sql, params)).rows[0],
      all: async (...params) => (await query(sql, params)).rows,
      run: (...params) => run(sql, params),
    };
  },
  get: async (sql, ...params) => (await query(sql, params)).rows[0],
  all: async (sql, ...params) => (await query(sql, params)).rows,
  run: (sql, ...params) => run(sql, params),
  // Vários comandos sem parâmetros
  exec: async (sql) => runner().query(translate(sql)),
  end: () => pool.end(),
};

// Como Array.map, mas uma de cada vez e na ordem: para laços que dependem do que as linhas anteriores fizeram
export async function mapSeries(list, fn) {
  const out = [];
  for (let i = 0; i < list.length; i++) out.push(await fn(list[i], i));
  return out;
}

// Insere e devolve o id criado
export async function insertId(sql, ...params) {
  return (await db.get(`${sql.replace(/;\s*$/, '')} RETURNING id`, ...params)).id;
}

// Tudo ou nada. Chamada dentro de outra transação, só participa dela.
export async function tx(fn) {
  if (store.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await store.run(client, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---- Esquema e parâmetros -------------------------------------------------------

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)));
await pool.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

// Migração a partir do SQLite antigo: com MIGRAR_SQLITE apontando para o arquivo e o PostgreSQL sem produtos.
// Se falhar, o serviço não sobe (melhor que subir vazio); nada é gravado pela metade.
if (process.env.MIGRAR_SQLITE) {
  const empty = !(await pool.query('SELECT 1 FROM products LIMIT 1')).rows.length;
  if (empty && fs.existsSync(process.env.MIGRAR_SQLITE)) {
    const { migrateFromSqlite } = await import('./migrate-sqlite.js');
    console.log(`Migrando os dados de ${process.env.MIGRAR_SQLITE} para o PostgreSQL...`);
    await migrateFromSqlite(process.env.MIGRAR_SQLITE, pool);
    console.log('Migração concluída. A variável MIGRAR_SQLITE já pode ser removida.');
  } else if (!empty) {
    console.log('MIGRAR_SQLITE ignorada: o PostgreSQL já tem dados. A variável pode ser removida.');
  } else {
    throw new Error(`MIGRAR_SQLITE aponta para um arquivo que não existe: ${process.env.MIGRAR_SQLITE}`);
  }
}

// Parâmetros e valores padrão (em dias; 0 = sem prazo)
export const SETTINGS_DEFAULTS = {
  prazo_cadastro_dias: 180,
  prazo_imagens_dias: 365,
  exigir_chave: 0, // 1 = API pública só responde com a chave de uma empresa ativa
  imagem_padrao: 1, // qual das opções de assets/padrao vale para os produtos sem imagem
};
for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) await db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, String(v));

// Parâmetros de texto sensíveis (tokens de APIs externas): nunca são devolvidos pela API, só "configurado sim/não"
export const SECRET_SETTINGS = ['cosmos_token', 'cnpja_token', 'ia_token'];
// Parâmetros de texto (provedor e modelo da geração de imagem por IA)
export const TEXT_SETTINGS = { ia_provedor: '', ia_modelo: '' };

// Os parâmetros são lidos o tempo todo: ficam em memória, recarregados depois de cada alteração
// e a cada 30 s (para valer também entre réplicas do serviço)
let settingsRows = new Map();
export async function reloadSettings() {
  settingsRows = new Map((await db.all('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
}
await reloadSettings();
setInterval(() => reloadSettings().catch((e) => console.error('parâmetros:', e.message)), 30000).unref();

export const getSecret = (key) => settingsRows.get(key) || '';
export const getFlag = (key) => settingsRows.get(key);

export function getSettings() {
  const out = { ...SETTINGS_DEFAULTS, ...TEXT_SETTINGS };
  for (const [k, v] of settingsRows) {
    if (k in SETTINGS_DEFAULTS) out[k] = Number(v);
    else if (k in TEXT_SETTINGS) out[k] = v;
  }
  return out;
}

// Reforma tributária (IBS, CBS e IS) em todas as camadas da tributação; vazio herda da camada anterior
export const REFORM_FIELDS = ['cst_ibs_cbs', 'c_class_trib', 'ibs_uf_rate', 'ibs_uf_reduction', 'ibs_mun_rate', 'ibs_mun_reduction', 'cbs_rate', 'cbs_reduction',
  'cst_is', 'c_class_trib_is', 'is_rate', 'is_specific'];
// Campos que uma NFC-e informa por estado. A exceção por estado fica acima de todas as outras camadas.
export const STATE_TAX_FIELDS = ['cfop', 'cst_icms', 'icms_rate', 'icms_reduction', 'fcp_rate', 'mva', 'icms_st_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', ...REFORM_FIELDS];

// Token de administração: variável ADMIN_TOKEN ou gerado e salvo em data/config.json
const configPath = path.join(DATA_DIR, 'config.json');
let config = {};
if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.adminToken && !process.env.ADMIN_TOKEN) {
  config.adminToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || config.adminToken;
