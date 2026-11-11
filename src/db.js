import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'catalogo.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  -- Com WAL, NORMAL não corrompe o banco e evita um fsync a cada gravação; uma queda do sistema pode perder só as últimas gravações
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -32000;
  PRAGMA temp_store = MEMORY;

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sku         TEXT UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    brand       TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT '',
    unit        TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS barcodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    code       TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL DEFAULT 'OUTRO',
    note       TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_barcodes_product ON barcodes(product_id);

  CREATE TABLE IF NOT EXISTS images (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL DEFAULT '',
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_images_product ON images(product_id, position);

  -- Códigos consultados por outros sistemas que não existiam: cadastrados automaticamente
  -- e mantidos aqui como lista de atualização posterior.
  CREATE TABLE IF NOT EXISTS barcode_requests (
    code               TEXT PRIMARY KEY,
    product_id         INTEGER REFERENCES products(id) ON DELETE CASCADE,
    status             TEXT NOT NULL DEFAULT 'pendente',
    request_count      INTEGER NOT NULL DEFAULT 1,
    first_requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_source        TEXT NOT NULL DEFAULT '',
    resolved_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_requests_status ON barcode_requests(status, last_requested_at);

  -- Data de cadastro e de alteração de cada informação do produto (nome, descrição, marca...)
  CREATE TABLE IF NOT EXISTS field_dates (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    field      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (product_id, field)
  );

  -- Histórico de mesclagens: produto removido (source) e para qual foi agregado (target)
  CREATE TABLE IF NOT EXISTS merges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id       INTEGER NOT NULL,
    source_id       INTEGER NOT NULL,
    source_snapshot TEXT NOT NULL,
    merged_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_merges_source ON merges(source_id);
  CREATE INDEX IF NOT EXISTS idx_merges_target ON merges(target_id);

  -- Consultas por código de barras recebidas de outros sistemas, por origem e por dia (data local)
  CREATE TABLE IF NOT EXISTS lookup_stats (
    source    TEXT NOT NULL,
    day       TEXT NOT NULL,
    hits      INTEGER NOT NULL DEFAULT 0,
    created   INTEGER NOT NULL DEFAULT 0,
    not_found INTEGER NOT NULL DEFAULT 0,
    last_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, day)
  );

  -- Último preenchimento automático (busca externa) de cada produto, para revisão na fila
  CREATE TABLE IF NOT EXISTS autofill_log (
    product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,
    fields     TEXT NOT NULL,
    filled_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Respostas das bases externas por código e base (evita gastar franquia consultando de novo)
  CREATE TABLE IF NOT EXISTS lookup_cache (
    code       TEXT NOT NULL,
    source     TEXT NOT NULL,
    found      INTEGER NOT NULL,
    result     TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (code, source)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Lista DCB (Denominação Comum Brasileira): princípios ativos.
  -- name_key = nome sem acentos e em minúsculas (impede repetidos); search = nome, código e CAS, para a busca
  CREATE TABLE IF NOT EXISTS dcb (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT UNIQUE,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    cas        TEXT NOT NULL DEFAULT '',
    search     TEXT NOT NULL DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Princípios ativos de cada medicamento (um produto pode ter vários), na ordem escolhida
  CREATE TABLE IF NOT EXISTS product_dcb (
    product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    dcb_id        INTEGER NOT NULL REFERENCES dcb(id),
    concentration TEXT NOT NULL DEFAULT '',
    position      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, dcb_id)
  );
  CREATE INDEX IF NOT EXISTS idx_product_dcb_dcb ON product_dcb(dcb_id);

  -- NCM: descrição, CEST e tributos federais padrão
  CREATE TABLE IF NOT EXISTS ncm (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    cest        TEXT NOT NULL DEFAULT '',
    cst_ipi     TEXT NOT NULL DEFAULT '',
    ipi_rate    TEXT NOT NULL DEFAULT '',
    cst_pis     TEXT NOT NULL DEFAULT '',
    pis_rate    TEXT NOT NULL DEFAULT '',
    cst_cofins  TEXT NOT NULL DEFAULT '',
    cofins_rate TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    search      TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Classificações tributárias (ex.: lista positiva, monofásico), com os dados de IBS/CBS da reforma
  CREATE TABLE IF NOT EXISTS tax_classes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT NOT NULL DEFAULT '',
    name         TEXT NOT NULL UNIQUE,
    cst_ibs_cbs  TEXT NOT NULL DEFAULT '',
    c_class_trib TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Regras do NCM por estado e classificação. uf '' = todos os estados; class_id 0 = todas as classificações.
  -- Campo vazio herda da camada mais geral.
  CREATE TABLE IF NOT EXISTS ncm_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ncm_id         INTEGER NOT NULL REFERENCES ncm(id) ON DELETE CASCADE,
    uf             TEXT NOT NULL DEFAULT '',
    class_id       INTEGER NOT NULL DEFAULT 0,
    cfop           TEXT NOT NULL DEFAULT '',
    cst_icms       TEXT NOT NULL DEFAULT '',
    icms_rate      TEXT NOT NULL DEFAULT '',
    icms_reduction TEXT NOT NULL DEFAULT '',
    fcp_rate       TEXT NOT NULL DEFAULT '',
    mva            TEXT NOT NULL DEFAULT '',
    icms_st_rate   TEXT NOT NULL DEFAULT '',
    cst_ipi        TEXT NOT NULL DEFAULT '',
    ipi_rate       TEXT NOT NULL DEFAULT '',
    cst_pis        TEXT NOT NULL DEFAULT '',
    pis_rate       TEXT NOT NULL DEFAULT '',
    cst_cofins     TEXT NOT NULL DEFAULT '',
    cofins_rate    TEXT NOT NULL DEFAULT '',
    ibs_rate       TEXT NOT NULL DEFAULT '',
    cbs_rate       TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ncm_id, uf, class_id)
  );

  -- Usuários do painel e permissões por módulo (JSON: ["produtos", "empresas", ...])
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    permissions   TEXT NOT NULL DEFAULT '[]',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  -- Sessões de login (guarda só o hash do token)
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Planos de cobrança: mensalidade + consultas incluídas + valor por consulta excedente (valores em R$)
  CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    monthly     REAL NOT NULL DEFAULT 0,
    included    INTEGER NOT NULL DEFAULT 0,
    extra_price REAL NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Empresas clientes (dados da Receita/Sintegra + cobrança + chave de acesso à API)
  CREATE TABLE IF NOT EXISTS companies (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj               TEXT NOT NULL UNIQUE,
    razao_social       TEXT NOT NULL,
    nome_fantasia      TEXT NOT NULL DEFAULT '',
    situacao           TEXT NOT NULL DEFAULT '',
    abertura           TEXT NOT NULL DEFAULT '',
    natureza_juridica  TEXT NOT NULL DEFAULT '',
    porte              TEXT NOT NULL DEFAULT '',
    cnae               TEXT NOT NULL DEFAULT '',
    inscricao_estadual TEXT NOT NULL DEFAULT '',
    ie_situacao        TEXT NOT NULL DEFAULT '',
    logradouro         TEXT NOT NULL DEFAULT '',
    numero             TEXT NOT NULL DEFAULT '',
    complemento        TEXT NOT NULL DEFAULT '',
    bairro             TEXT NOT NULL DEFAULT '',
    municipio          TEXT NOT NULL DEFAULT '',
    uf                 TEXT NOT NULL DEFAULT '',
    cep                TEXT NOT NULL DEFAULT '',
    telefone           TEXT NOT NULL DEFAULT '',
    email              TEXT NOT NULL DEFAULT '',
    contato_nome       TEXT NOT NULL DEFAULT '',
    contato_email      TEXT NOT NULL DEFAULT '',
    contato_telefone   TEXT NOT NULL DEFAULT '',
    plan_id            INTEGER REFERENCES plans(id),
    due_day            INTEGER NOT NULL DEFAULT 10,
    status             TEXT NOT NULL DEFAULT 'ativa',
    notes              TEXT NOT NULL DEFAULT '',
    api_key_hash       TEXT UNIQUE,
    api_key_prefix     TEXT NOT NULL DEFAULT '',
    data_source        TEXT NOT NULL DEFAULT '',
    data_fetched_at    TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Consumo da API pública por empresa e dia (data local)
  CREATE TABLE IF NOT EXISTS company_usage (
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (company_id, day)
  );

  -- Faturas mensais: os valores do plano ficam gravados como estavam no fechamento
  CREATE TABLE IF NOT EXISTS invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    period         TEXT NOT NULL,
    plan_name      TEXT NOT NULL DEFAULT '',
    usage          INTEGER NOT NULL DEFAULT 0,
    included       INTEGER NOT NULL DEFAULT 0,
    extra_usage    INTEGER NOT NULL DEFAULT 0,
    monthly        REAL NOT NULL DEFAULT 0,
    extra_price    REAL NOT NULL DEFAULT 0,
    extra_amount   REAL NOT NULL DEFAULT 0,
    discount       REAL NOT NULL DEFAULT 0,
    total          REAL NOT NULL DEFAULT 0,
    due_date       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'aberta',
    paid_at        TEXT,
    notes          TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, period)
  );
`);

// Parâmetros e valores padrão (em dias; 0 = sem prazo)
export const SETTINGS_DEFAULTS = {
  prazo_cadastro_dias: 180,
  prazo_imagens_dias: 365,
  exigir_chave: 0, // 1 = API pública só responde com a chave de uma empresa ativa
  imagem_padrao: 1, // qual das opções de assets/padrao vale para os produtos sem imagem
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) insSetting.run(k, String(v));

// Parâmetros de texto sensíveis (tokens de APIs externas): nunca são devolvidos pela API, só "configurado sim/não"
export const SECRET_SETTINGS = ['cosmos_token', 'cnpja_token', 'ia_token'];

// Parâmetros de texto (provedor e modelo da geração de imagem por IA)
export const TEXT_SETTINGS = { ia_provedor: '', ia_modelo: '' };
export function getSecret(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

export function getSettings() {
  const out = { ...SETTINGS_DEFAULTS };
  Object.assign(out, TEXT_SETTINGS);
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in SETTINGS_DEFAULTS) out[r.key] = Number(r.value);
    else if (r.key in TEXT_SETTINGS) out[r.key] = r.value;
  }
  return out;
}

// Migrações de colunas em bancos já existentes
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('images', 'is_placeholder')) db.exec('ALTER TABLE images ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0');
// Imagem ilustrativa gerada por IA: substitui a imagem padrão, mas não conta como foto real
if (!hasColumn('images', 'is_ai')) db.exec('ALTER TABLE images ADD COLUMN is_ai INTEGER NOT NULL DEFAULT 0');

// products.updated_at = qualquer alteração no registro
// products.data_updated_at = última atualização/revisão dos dados
// products.images_updated_at = última alteração de imagens reais
if (!hasColumn('products', 'data_updated_at')) {
  db.exec('ALTER TABLE products ADD COLUMN data_updated_at TEXT');
  db.exec('UPDATE products SET data_updated_at = updated_at');
}
if (!hasColumn('products', 'images_updated_at')) {
  db.exec('ALTER TABLE products ADD COLUMN images_updated_at TEXT');
  db.exec(`UPDATE products SET images_updated_at =
    (SELECT MAX(created_at) FROM images i WHERE i.product_id = products.id AND i.is_placeholder = 0)`);
}
// Campos do cadastro em abas: dados gerais (pesos em kg, medidas em cm), tributação e medicamento
for (const col of ['manufacturer', 'gross_weight', 'net_weight', 'height', 'width', 'depth', 'pack_qty',
  'ncm', 'cest', 'cfop', 'tax_origin', 'cst_icms', 'icms_rate', 'cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', 'tax_notes',
  'anvisa_registry', 'med_type', 'med_stripe', 'med_controlled', 'med_form', 'med_presentation', 'med_therapeutic_class', 'med_notes']) {
  if (!hasColumn('products', col)) db.exec(`ALTER TABLE products ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
}
// Reforma tributária (IBS, CBS e IS) em todas as camadas da tributação; vazio herda da camada anterior
export const REFORM_FIELDS = ['cst_ibs_cbs', 'c_class_trib', 'ibs_uf_rate', 'ibs_uf_reduction', 'ibs_mun_rate', 'ibs_mun_reduction', 'cbs_rate', 'cbs_reduction',
  'cst_is', 'c_class_trib_is', 'is_rate', 'is_specific'];
for (const table of ['ncm', 'tax_classes', 'ncm_rules', 'products']) {
  for (const col of REFORM_FIELDS) {
    if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}
// A regra tinha um único campo de IBS; agora ele se divide em estadual e municipal
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_ibs_uf_mun'").get()) {
  db.exec(`UPDATE ncm_rules SET ibs_uf_rate = ibs_rate,
    notes = TRIM(notes || ' Confira: o IBS informado antes da divisão em estadual e municipal foi para o estadual.')
    WHERE ibs_rate <> ''`);
  db.exec("INSERT INTO settings (key, value) VALUES ('migr_ibs_uf_mun', '1')");
}

// Campos que uma NFC-e informa por estado. A exceção por estado fica acima de todas as outras camadas.
export const STATE_TAX_FIELDS = ['cfop', 'cst_icms', 'icms_rate', 'icms_reduction', 'fcp_rate', 'mva', 'icms_st_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', ...REFORM_FIELDS];
db.exec(`
  CREATE TABLE IF NOT EXISTS product_tax_uf (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    uf         TEXT NOT NULL,
    ${STATE_TAX_FIELDS.map((f) => `${f} TEXT NOT NULL DEFAULT ''`).join(',\n    ')},
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (product_id, uf)
  );

  -- Importação de NFC-e. Guarda o último dado de cada produto por estado e emitente; não guarda o XML nem o consumidor.
  CREATE TABLE IF NOT EXISTS xml_observations (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    uf         TEXT NOT NULL,
    emitter    TEXT NOT NULL,
    emitted_at INTEGER NOT NULL,
    simples    INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    PRIMARY KEY (product_id, uf, emitter)
  );
  CREATE TABLE IF NOT EXISTS xml_imports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name  TEXT NOT NULL DEFAULT '',
    summary    TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS xml_documents (
    access_key TEXT PRIMARY KEY,
    import_id  INTEGER NOT NULL REFERENCES xml_imports(id) ON DELETE CASCADE,
    uf         TEXT NOT NULL,
    emitter    TEXT NOT NULL,
    emitted_at INTEGER NOT NULL
  ) WITHOUT ROWID;
`);

if (!hasColumn('products', 'tax_class_id')) db.exec('ALTER TABLE products ADD COLUMN tax_class_id INTEGER');
if (!hasColumn('products', 'is_medicine')) db.exec('ALTER TABLE products ADD COLUMN is_medicine INTEGER NOT NULL DEFAULT 0');
// Sem estes índices, "o produto está pendente?" e "quantos produtos usam o NCM?" percorrem a tabela inteira para cada linha.
// O SQLite é síncrono: enquanto uma consulta dessas roda, o servidor não atende mais ninguém.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_requests_product ON barcode_requests(product_id, status);
  CREATE INDEX IF NOT EXISTS idx_products_ncm ON products(ncm);
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
  PRAGMA optimize = 0x10002;
`);
if (!hasColumn('barcodes', 'created_at')) {
  db.exec('ALTER TABLE barcodes ADD COLUMN created_at TEXT');
  db.exec('ALTER TABLE barcodes ADD COLUMN updated_at TEXT');
  db.exec('UPDATE barcodes SET created_at = (SELECT created_at FROM products p WHERE p.id = product_id), updated_at = (SELECT updated_at FROM products p WHERE p.id = product_id)');
}
// Estimativa do histórico de consultas anterior à contagem: usa a última origem de cada código pendente
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_lookup_stats'").get()) {
  db.exec(`INSERT OR IGNORE INTO lookup_stats (source, day, hits, created, last_at)
    SELECT COALESCE(NULLIF(last_source, ''), 'desconhecida'), date(last_requested_at, 'localtime'),
           SUM(request_count), COUNT(*), MAX(last_requested_at)
    FROM barcode_requests GROUP BY 1, 2`);
  db.exec("INSERT INTO settings (key, value) VALUES ('migr_lookup_stats', '1')");
}
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_field_dates'").get()) {
  for (const f of ['name', 'sku', 'description', 'brand', 'category', 'unit']) {
    db.exec(`INSERT OR IGNORE INTO field_dates (product_id, field, created_at, updated_at)
      SELECT id, '${f}', created_at, updated_at FROM products WHERE COALESCE(${f}, '') <> ''`);
  }
  db.exec(`INSERT OR IGNORE INTO field_dates (product_id, field, created_at, updated_at) SELECT id, 'active', created_at, updated_at FROM products`);
  db.exec("INSERT INTO settings (key, value) VALUES ('migr_field_dates', '1')");
}

// Token de administração: variável ADMIN_TOKEN ou gerado e salvo em data/config.json
const configPath = path.join(DATA_DIR, 'config.json');
let config = {};
if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.adminToken) {
  config.adminToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || config.adminToken;
