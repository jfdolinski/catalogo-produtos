// Catálogo completo (JSON e CSV): montado em blocos, para não parar o servidor, e guardado já comprimido.
// Até CACHE_MS devolve a cópia pronta. Até STALE_MS devolve a cópia e monta outra por trás; depois disso, espera a nova.
// Assim o catálogo nunca fica mais antigo do que STALE_MS.
import crypto from 'node:crypto';
import { once } from 'node:events';
import zlib from 'node:zlib';
import { db } from './db.js';

const CACHE_MS = (Number(process.env.CATALOGO_CACHE_SEGUNDOS) || 300) * 1000;
const STALE_MS = CACHE_MS * 2;
const BATCH = 200;
const MAX_COPIES = 6;

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const CSV_HEADER = ['id', 'sku', 'nome', 'descricao', 'marca', 'categoria', 'unidade', 'codigos_barras', 'imagem_principal', 'imagens', 'link'];

const FORMATS = {
  json: {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    start: (total) => `{"generated_at":${JSON.stringify(new Date().toISOString())},"total":${total},"items":[`,
    item: (p, first) => (first ? '' : ',') + JSON.stringify(p),
    end: ']}',
  },
  csv: {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'inline; filename="catalogo.csv"' },
    start: () => `﻿${CSV_HEADER.join(';')}`,
    item: (p) => `\r\n${[
      p.id, p.sku, p.name, p.description, p.brand, p.category, p.unit,
      p.barcodes.map((b) => b.code).join('|'), p.main_image, p.images.map((i) => i.url).join('|'), p.links.page,
    ].map(csvCell).join(';')}`,
    end: '',
  },
};

// A impressão digital ignora a data de geração: o catálogo igual mantém a mesma ETag e o cliente recebe 304
async function build(format, base, hydrate) {
  const f = FORMATS[format];
  const ids = db.prepare('SELECT id FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE, id').all().map((r) => r.id);
  const gzip = zlib.createGzip();
  const chunks = [];
  gzip.on('data', (d) => chunks.push(d));
  const finished = once(gzip, 'end');
  const hash = crypto.createHash('sha1');
  const write = async (text) => {
    if (!gzip.write(text)) await once(gzip, 'drain');
  };
  await write(f.start(ids.length));
  let first = true;
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    const rows = db.prepare(`SELECT * FROM products WHERE active = 1 AND id IN (${part.map(() => '?').join(',')})`).all(...part);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = hydrate(part.map((id) => byId.get(id)).filter(Boolean), base);
    let text = '';
    for (const p of items) { text += f.item(p, first); first = false; }
    hash.update(text);
    await write(text);
    await yieldLoop();
  }
  await write(f.end);
  gzip.end();
  await finished;
  const body = Buffer.concat(chunks);
  return { body, etag: `"${hash.digest('hex')}"`, builtAt: Date.now() };
}

export function mountCatalog(pub, { hydrate, baseUrl }) {
  const cache = new Map(); // formato + domínio -> { entry, building }

  function refresh(key, format, base) {
    const slot = cache.get(key) ?? {};
    // Os links dependem do domínio da chamada: poucas cópias, para um cabeçalho Host forjado não encher a memória
    if (!cache.has(key) && cache.size >= MAX_COPIES) cache.delete(cache.keys().next().value);
    cache.set(key, slot);
    if (!slot.building) {
      slot.building = build(format, base, hydrate).then((entry) => {
        // Sem mudança nos produtos, fica a cópia anterior; só renova o relógio
        slot.entry = slot.entry?.etag === entry.etag ? { ...slot.entry, builtAt: entry.builtAt } : entry;
        return slot.entry;
      }).finally(() => { slot.building = null; });
    }
    return slot.building;
  }

  async function current(format, base) {
    const key = `${format} ${base}`;
    const slot = cache.get(key);
    const age = slot?.entry ? Date.now() - slot.entry.builtAt : Infinity;
    if (age < CACHE_MS) return slot.entry;
    if (age < STALE_MS) {
      refresh(key, format, base).catch((e) => console.error('catálogo:', e));
      return slot.entry;
    }
    return refresh(key, format, base);
  }

  const route = (format) => async (req, res, next) => {
    try {
      const entry = await current(format, baseUrl(req));
      res.set({ ...FORMATS[format].headers, ETag: entry.etag, Vary: 'Accept-Encoding', 'Cache-Control': 'no-cache' });
      // Compara direto em vez de req.fresh: o fetch envia Cache-Control: no-cache junto, e req.fresh ignoraria a ETag
      const known = String(req.get('if-none-match') ?? '').split(',').map((v) => v.trim().replace(/^W\//, ''));
      if (known.includes(entry.etag) || known.includes('*')) return res.status(304).end();
      if (req.acceptsEncodings('gzip')) {
        res.set({ 'Content-Encoding': 'gzip', 'Content-Length': String(entry.body.length) });
        return res.end(entry.body);
      }
      // Cliente sem gzip: descomprime em fluxo, fora da linha principal
      const gunzip = zlib.createGunzip();
      gunzip.on('error', next);
      gunzip.pipe(res);
      gunzip.end(entry.body);
    } catch (e) { next(e); }
  };

  pub.get('/api/v1/catalog.json', route('json'));
  pub.get('/api/v1/catalog.csv', route('csv'));
}
