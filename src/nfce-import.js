// Importação de XML de NFC-e (modelo 65): atualiza produtos, regras do NCM no estado do emitente e exceções por estado.
// Lê em segundo plano, mostra a prévia e só grava na confirmação. Não guarda o XML nem lê os dados do consumidor.
//
// De cada produto fica o dado mais recente por estado e emitente (xml_observations). Entre emitentes vale a maioria.
// Em cada NCM + classificação + estado, o valor da maioria dos produtos vai para a regra e quem difere recebe exceção:
// assim a tributação resolvida de cada produto com nota é a que a nota informa.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import yauzl from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import { db, STATE_TAX_FIELDS, mapSeries } from './db.js';
import { HttpError, tx } from './business.js';
import { analyzeBarcode } from './barcode.js';
import { RATES, RULE_FIELDS, PRODUCT_OVERRIDES, LABELS, UFS, fiscalValue } from './tax.js';

const MAX_XML_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_FILES = 5000;
const MAX_ZIP_ENTRIES = 500000;
const SHOWN_ROWS = 500;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false,
  trimValues: true, processEntities: false, isArray: (name) => name === 'det' || name === 'NFe',
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ENTITIES[k]);
const clean = (s, max = 300) => decode(s).replace(/\s+/g, ' ').trim().slice(0, max);
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const firstChild = (o) => (o && typeof o === 'object' ? Object.values(o).find((v) => v && typeof v === 'object') : undefined);

// "18.0000" -> "18"; vazio continua vazio
function rate(raw) {
  const v = String(raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return '';
  return v.includes('.') ? v.replace(/\.?0+$/, '') || '0' : String(Number(v));
}
const rateOrZero = (raw) => rate(raw) || '0';

// ---- Leitura de um XML ----------------------------------------------------------

function itemReform(imposto, tax) {
  const g = imposto?.IBSCBS;
  if (g) {
    tax.cst_ibs_cbs = digits(g.CST);
    tax.c_class_trib = digits(g.cClassTrib);
    // Monofásico e transferência de crédito não trazem alíquota nestes grupos: não há o que comparar
    const main = g.gIBSCBS;
    if (main || !(g.gIBSCBSMono || g.gTransfCred || g.gAjusteCompet)) {
      tax.ibs_uf_rate = rateOrZero(main?.gIBSUF?.pIBSUF);
      tax.ibs_uf_reduction = rateOrZero(main?.gIBSUF?.gRed?.pRedAliq);
      tax.ibs_mun_rate = rateOrZero(main?.gIBSMun?.pIBSMun);
      tax.ibs_mun_reduction = rateOrZero(main?.gIBSMun?.gRed?.pRedAliq);
      tax.cbs_rate = rateOrZero(main?.gCBS?.pCBS);
      tax.cbs_reduction = rateOrZero(main?.gCBS?.gRed?.pRedAliq);
    }
  }
  const is = imposto?.IS;
  if (is) {
    tax.cst_is = digits(is.CSTIS);
    tax.c_class_trib_is = digits(is.cClassTribIS);
    tax.is_rate = rateOrZero(is.pIS);
    tax.is_specific = rateOrZero(is.pISEspec);
  }
  return !!(g || is);
}

function readItem(det) {
  const prod = det.prod ?? {};
  const imposto = det.imposto ?? {};
  const tax = { cfop: digits(prod.CFOP) };
  const icms = firstChild(imposto.ICMS);
  if (icms) {
    const cst = digits(icms.CST ?? icms.CSOSN);
    if (cst) {
      tax.cst_icms = cst;
      tax.icms_rate = rateOrZero(icms.pICMS);
      tax.icms_reduction = rateOrZero(icms.pRedBC);
      tax.fcp_rate = rateOrZero(icms.pFCP);
      tax.mva = rateOrZero(icms.pMVAST);
      tax.icms_st_rate = rateOrZero(icms.pICMSST ?? icms.pST);
    }
  }
  const pis = firstChild(imposto.PIS);
  if (pis?.CST) { tax.cst_pis = digits(pis.CST); tax.pis_rate = rateOrZero(pis.pPIS); }
  const cofins = firstChild(imposto.COFINS);
  if (cofins?.CST) { tax.cst_cofins = digits(cofins.CST); tax.cofins_rate = rateOrZero(cofins.pCOFINS); }
  const reform = itemReform(imposto, tax);

  const med = Array.isArray(prod.med) ? prod.med[0] : prod.med;
  const anvisa = digits(med?.cProdANVISA);
  const ncm = digits(prod.NCM);
  return {
    barcodes: [prod.cEAN, prod.cEANTrib].map((c) => String(c ?? '').trim()).filter((c, i, all) => /^\d+$/.test(c) && all.indexOf(c) === i),
    name: clean(prod.xProd, 200),
    unit: clean(prod.uCom, 20),
    ncm: ncm.length === 8 && ncm !== '00000000' ? ncm : '',
    cest: digits(prod.CEST).length === 7 ? digits(prod.CEST) : '',
    origin: /^[0-8]$/.test(String(icms?.orig ?? '')) ? String(icms.orig) : '',
    anvisa: anvisa.length >= 9 && anvisa.length <= 13 ? anvisa : '',
    medicine: !!med,
    reform,
    tax,
  };
}

// Devolve { kind: 'note' | 'cancel' | 'ignored' }. Só é nota válida: NFC-e de venda autorizada em produção.
export function parseNfce(text) {
  const raw = text.replace(/^﻿/, '');
  if (/<!DOCTYPE/i.test(raw.slice(0, 2000))) return { kind: 'ignored', reason: 'invalid' };
  let doc;
  try { doc = parser.parse(raw); } catch { return { kind: 'ignored', reason: 'invalid' }; }
  const event = doc.procEventoNFe?.evento?.infEvento ?? doc.evento?.infEvento;
  if (event) return String(event.tpEvento) === '110111' ? { kind: 'cancel', key: digits(event.chNFe) } : { kind: 'ignored', reason: 'other_document' };
  const proc = doc.nfeProc;
  const nfe = (proc?.NFe ?? doc.NFe)?.[0];
  const inf = nfe?.infNFe;
  if (!inf?.ide) return { kind: 'ignored', reason: Object.keys(doc).some((k) => k !== '?xml') ? 'other_document' : 'invalid' };
  const { ide, emit = {} } = inf;
  if (String(ide.mod) !== '65') return { kind: 'ignored', reason: 'not_nfce' };
  if (String(ide.tpAmb) !== '1') return { kind: 'ignored', reason: 'homologation' };
  if (String(ide.tpNF ?? '1') !== '1' || String(ide.finNFe ?? '1') !== '1') return { kind: 'ignored', reason: 'not_sale' };
  const prot = proc?.protNFe?.infProt;
  if (!prot) return { kind: 'ignored', reason: 'not_authorized' };
  if (!['100', '150'].includes(String(prot.cStat))) return { kind: 'ignored', reason: 'not_authorized' };
  const uf = String(emit.enderEmit?.UF ?? '').toUpperCase();
  const key = digits(prot.chNFe || inf['@_Id']);
  const emittedAt = Date.parse(ide.dhEmi);
  if (!UFS.includes(uf) || key.length !== 44 || Number.isNaN(emittedAt)) return { kind: 'ignored', reason: 'invalid' };
  return {
    kind: 'note', key, uf, emittedAt,
    emitter: digits(emit.CNPJ),
    simples: ['1', '4'].includes(String(emit.CRT)), // regimes que informam CSOSN e, em geral, PIS/COFINS sem alíquota
    items: (inf.det ?? []).map(readItem),
  };
}

// ---- Leitura dos arquivos -------------------------------------------------------

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

function decodeXml(buffer) {
  const head = buffer.subarray(0, 100).toString('latin1');
  return buffer.toString(/encoding=["']ISO-8859-1["']/i.test(head) ? 'latin1' : 'utf8');
}

function readZip(file, onXml, onOther) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(new Error('arquivo .zip inválido'));
      let count = 0;
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (++count > MAX_ZIP_ENTRIES) { zip.close(); return reject(new Error(`.zip com mais de ${MAX_ZIP_ENTRIES} arquivos`)); }
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        if (!/\.xml$/i.test(entry.fileName)) { onOther(); return zip.readEntry(); }
        if (entry.uncompressedSize > MAX_XML_BYTES) { onOther(); return zip.readEntry(); }
        zip.openReadStream(entry, (e, stream) => {
          if (e) { onOther(); return zip.readEntry(); }
          const parts = [];
          stream.on('data', (d) => parts.push(d));
          stream.on('error', () => { onOther(); zip.readEntry(); });
          stream.on('end', async () => {
            try { await onXml(Buffer.concat(parts)); zip.readEntry(); } catch (x) { zip.close(); reject(x); }
          });
        });
      });
      zip.readEntry();
    });
  });
}

function newBatch() {
  return {
    files: 0, notes: 0, items: 0, reform_items: 0, no_gtin: 0, invalid_values: 0,
    ignored: { invalid: 0, not_nfce: 0, homologation: 0, not_sale: 0, not_authorized: 0, other_document: 0, already_imported: 0, repeated: 0, canceled: 0, not_xml: 0 },
    documents: new Map(), // chave -> { uf, emitter, emitted_at, lines: [...] }
    cancels: new Set(),
    ufs: {},
  };
}

async function addFile(batch, buffer, seenInDb) {
  batch.files++;
  const r = parseNfce(decodeXml(buffer));
  if (r.kind === 'ignored') { batch.ignored[r.reason]++; return; }
  if (r.kind === 'cancel') { batch.cancels.add(r.key); return; }
  if (batch.documents.has(r.key)) { batch.ignored.repeated++; return; }
  if (await seenInDb.get(r.key)) { batch.ignored.already_imported++; return; }
  batch.documents.set(r.key, r);
}

// Campo fiscal fora do formato não entra; a prévia informa quantos
function validTax(batch, tax) {
  const out = {};
  for (const [f, v] of Object.entries(tax)) {
    if (!v) continue;
    try { out[f] = fiscalValue(f, v); } catch { batch.invalid_values++; }
  }
  return out;
}

// Junta as notas: fica um registro por código + estado + emitente, o da nota mais recente
function collect(batch) {
  const lines = new Map();
  for (const key of batch.cancels) if (batch.documents.delete(key)) batch.ignored.canceled++;
  for (const n of batch.documents.values()) {
    batch.notes++;
    const u = (batch.ufs[n.uf] ??= { uf: n.uf, notes: 0, items: 0, reform_items: 0, emitters: new Set() });
    u.notes++;
    u.emitters.add(n.emitter);
    for (const it of n.items) {
      batch.items++;
      u.items++;
      if (it.reform) { batch.reform_items++; u.reform_items++; }
      const codes = it.barcodes.filter((c) => { const a = analyzeBarcode(c); return !a.error && a.type !== 'OUTRO'; });
      if (!codes.length) { batch.no_gtin++; continue; }
      const k = `${codes[0]}|${n.uf}|${n.emitter}`;
      const old = lines.get(k);
      if (old && old.emitted_at >= n.emittedAt) continue;
      lines.set(k, {
        codes, uf: n.uf, emitter: n.emitter, emitted_at: n.emittedAt, simples: n.simples ? 1 : 0,
        data: { name: it.name, unit: it.unit, ncm: it.ncm, cest: it.cest, origin: it.origin, anvisa: it.anvisa, medicine: it.medicine, tax: validTax(batch, it.tax) },
      });
    }
    n.items = null; // daqui em diante só a identificação da nota importa
  }
  return lines;
}

// ---- Plano ----------------------------------------------------------------------

const SIMPLES_ONLY_NORMAL = new Set(['cst_icms', 'icms_rate', 'icms_reduction', 'fcp_rate', 'mva', 'icms_st_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate']);
const isRate = new Set([...RATES, 'mva', 'is_specific']);
const same = (f, a, b) => (isRate.has(f) ? Number(a || 0) === Number(b || 0) : String(a ?? '') === String(b ?? ''));

// O valor mais frequente; empate fica com o mais recente
function majority(votes) {
  const count = new Map();
  for (const v of votes) {
    const c = count.get(v.value) ?? { n: 0, at: 0 };
    c.n++;
    c.at = Math.max(c.at, v.at);
    count.set(v.value, c);
  }
  let best = null;
  for (const [value, c] of count) if (!best || c.n > best.n || (c.n === best.n && c.at > best.at)) best = { value, n: c.n, at: c.at };
  return { value: best?.value ?? '', conflict: count.size > 1 };
}

// Monta o plano a partir das notas lidas e dos dados de notas anteriores. Não grava.
async function buildPlan(lines, opts, deps) {
  const { findBarcode, AUTO_NAME } = deps;
  const stats = { conflicts: 0, kept_different: 0, simples_ignored: 0, new_barcodes: 0, barcode_conflicts: 0 };

  // Código -> produto. Código sem cadastro vira "novo:<código>", com o outro código da mesma nota no mesmo item.
  const newByCode = new Map();
  const productKey = async (codes) => {
    const found = [];
    for (const c of codes) {
      const id = (await findBarcode(c))?.product_id;
      if (id) found.push(id);
    }
    if (new Set(found).size > 1) stats.barcode_conflicts++;
    if (found.length) return found[0];
    const known = codes.map((c) => newByCode.get(c)).find(Boolean);
    const key = known ?? `novo:${codes[0]}`;
    codes.forEach((c) => newByCode.set(c, key));
    return key;
  };

  const obs = new Map(); // produto -> Map(uf|emitente -> { uf, emitter, at, simples, data })
  const put = (key, o) => {
    if (!obs.has(key)) obs.set(key, new Map());
    const m = obs.get(key);
    const k = `${o.uf}|${o.emitter}`;
    if (!m.has(k) || m.get(k).at <= o.at) m.set(k, o);
  };
  let n = 0;
  for (const r of await db.prepare('SELECT * FROM xml_observations').all()) {
    put(r.product_id, { uf: r.uf, emitter: r.emitter, at: r.emitted_at, simples: r.simples, data: JSON.parse(r.data) });
    if (++n % 5000 === 0) await yieldLoop();
  }

  const touched = new Set();
  const extraCodes = new Map(); // produto -> códigos da nota que ainda não estão no cadastro
  const pendingObs = [];
  for (const l of lines.values()) {
    const key = await productKey(l.codes);
    touched.add(key);
    const o = { uf: l.uf, emitter: l.emitter, at: l.emitted_at, simples: l.simples, data: l.data };
    put(key, o);
    pendingObs.push({ key, ...o });
    for (const c of l.codes) {
      if (!(await findBarcode(c))) {
        if (!extraCodes.has(key)) extraCodes.set(key, new Set());
        extraCodes.get(key).add(c);
      }
    }
    if (++n % 2000 === 0) await yieldLoop();
  }

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const skipNew = (key) => typeof key === 'string' && !opts.create_products;
  const products = [];
  const productState = new Map(); // produto -> { ncm, classId, row }

  // Dados do cadastro: valem para o Brasil todo, então a maioria é contada entre todos os estados
  for (const [key, byUf] of obs) {
    if (skipNew(key)) continue;
    const row = typeof key === 'number' ? await getProduct.get(key) : null;
    if (typeof key === 'number' && !row) continue;
    const list = [...byUf.values()];
    const pick = (f) => majority(list.filter((o) => o.data[f]).map((o) => ({ value: o.data[f], at: o.at })));
    const ncm = pick('ncm');
    if (ncm.conflict) stats.conflicts++;
    const keepNcm = row?.ncm && !opts.replace_registry;
    const effectiveNcm = keepNcm || !ncm.value ? row?.ncm ?? '' : ncm.value;
    productState.set(key, { ncm: effectiveNcm, classId: row?.tax_class_id ?? 0, row });
    if (!touched.has(key)) continue;

    const changes = {};
    const change = (f, to, replaceable = true) => {
      const from = row?.[f] ?? '';
      if (!to || String(from) === String(to)) return;
      if (from && !(replaceable && opts.replace_registry)) { stats.kept_different++; return; }
      changes[f] = { from, to };
    };
    const name = list.slice().sort((a, b) => b.at - a.at).find((o) => o.data.name)?.data.name ?? '';
    const provisional = !row || row.name.startsWith(AUTO_NAME);
    if (provisional && name && (!row || row.name !== name)) changes.name = { from: row?.name ?? '', to: name };
    change('ncm', ncm.value);
    change('cest', pick('cest').value);
    change('tax_origin', pick('origin').value);
    change('anvisa_registry', pick('anvisa').value);
    if (!row?.unit) change('unit', pick('unit').value, false);
    if (list.some((o) => o.data.medicine) && !row?.is_medicine) changes.is_medicine = { from: 0, to: 1 };
    const codes = [...(extraCodes.get(key) ?? [])];
    const isNew = typeof key === 'string';
    if (isNew || codes.length || Object.keys(changes).length) {
      if (typeof key === 'number') stats.new_barcodes += codes.length;
      products.push({ key, id: row?.id ?? null, name: row?.name ?? name, create: isNew, codes, changes });
    }
    if (n++ % 2000 === 0) await yieldLoop();
  }

  // Tributação: consenso de cada produto em cada estado e agrupamento por NCM + classificação + estado
  const groups = new Map();
  const touchedPairs = new Set(pendingObs.map((o) => `${o.key}|${o.uf}`));
  const simplesIgnored = new Set();
  for (const [key, byUf] of obs) {
    const state = productState.get(key);
    if (!state) continue;
    const perUf = new Map();
    for (const o of byUf.values()) {
      if (!perUf.has(o.uf)) perUf.set(o.uf, []);
      perUf.get(o.uf).push(o);
    }
    for (const [uf, list] of perUf) {
      const gk = `${state.ncm}|${state.classId}|${uf}`;
      if (!groups.has(gk)) groups.set(gk, { ncm: state.ncm, classId: state.classId, uf, voters: new Map(), touched: false });
      if (touchedPairs.has(`${key}|${uf}`)) groups.get(gk).touched = true;
      const values = {};
      for (const f of STATE_TAX_FIELDS) {
        const usable = list.filter((o) => o.data.tax[f] !== undefined && (opts.use_simples || !o.simples || !SIMPLES_ONLY_NORMAL.has(f)));
        if (!usable.length) {
          if (touchedPairs.has(`${key}|${uf}`) && list.some((o) => o.simples && o.data.tax[f] !== undefined)) simplesIgnored.add(`${key}|${uf}`);
          continue;
        }
        const m = majority(usable.map((o) => ({ value: o.data.tax[f], at: o.at })));
        if (m.conflict) stats.conflicts++;
        values[f] = m.value;
      }
      groups.get(gk).voters.set(key, values);
    }
    if (n++ % 2000 === 0) await yieldLoop();
  }

  const ncmByCode = db.prepare('SELECT * FROM ncm WHERE code = ?');
  const ruleRows = db.prepare('SELECT * FROM ncm_rules WHERE ncm_id = ? AND uf IN (?, \'\') AND class_id IN (?, 0) ORDER BY uf <> \'\', class_id <> 0');
  const classById = db.prepare('SELECT * FROM tax_classes WHERE id = ?');
  const stateRow = db.prepare('SELECT * FROM product_tax_uf WHERE product_id = ? AND uf = ?');
  const inherit = db.prepare('SELECT COUNT(*) AS n FROM products WHERE ncm = ? AND COALESCE(tax_class_id, 0) = ?');
  const rules = [];
  const exceptions = new Map();
  const addException = (key, uf, f, from, to) => {
    const k = `${key}|${uf}`;
    if (!exceptions.has(k)) exceptions.set(k, { key, uf, changes: {} });
    exceptions.get(k).changes[f] = { from, to };
  };

  stats.simples_ignored = simplesIgnored.size;
  for (const g of groups.values()) {
    // Só o que as notas enviadas alcançam: ajuste manual em outro NCM ou estado continua como está
    if (!g.touched) continue;
    const ncm = g.ncm ? await ncmByCode.get(g.ncm) : null;
    const cls = g.classId ? await classById.get(g.classId) : null;
    const layers = ncm ? await ruleRows.all(ncm.id, g.uf, g.classId) : [];
    const own = layers.find((r) => r.uf === g.uf && r.class_id === g.classId) ?? null;
    const ruleChanges = {};
    for (const f of STATE_TAX_FIELDS) {
      const votes = [...g.voters.values()].filter((v) => v[f] !== undefined).map((v) => ({ value: v[f], at: 0 }));
      if (!votes.length) continue;
      // Valor que vale hoje antes do produto: NCM -> classificação -> regras, da mais geral para a mais específica
      let inherited = ncm?.[f] ?? '';
      if (cls?.[f]) inherited = cls[f];
      for (const r of layers) if (r !== own && r[f]) inherited = r[f];
      const current = own?.[f] || inherited;
      let ruleValue = current;
      if (ncm && RULE_FIELDS.includes(f)) {
        const { value } = majority(votes);
        if (!same(f, value, current)) {
          if (opts.replace_tax || !current) { ruleChanges[f] = { from: current, to: value }; ruleValue = value; } else stats.kept_different++;
        }
      }
      for (const [key, v] of g.voters) {
        if (v[f] === undefined) continue;
        // Produto sem nota neste lote só muda se a regra do grupo mudou e ele deixaria de seguir a própria nota
        if (!touchedPairs.has(`${key}|${g.uf}`) && !ruleChanges[f]) continue;
        const state = productState.get(key);
        const global = PRODUCT_OVERRIDES.includes(f) ? state.row?.[f] ?? '' : '';
        const base = global || ruleValue;
        const exception = typeof key === 'number' ? (await stateRow.get(key, g.uf))?.[f] ?? '' : '';
        if (same(f, v[f], base)) {
          if (exception && !same(f, exception, v[f]) && opts.replace_tax) addException(key, g.uf, f, exception, '');
          continue;
        }
        const effective = exception || base;
        if (same(f, v[f], effective)) continue;
        if (opts.replace_tax || !effective) addException(key, g.uf, f, effective, v[f]);
        else stats.kept_different++;
      }
    }
    if (Object.keys(ruleChanges).length) {
      const covered = (await inherit.get(g.ncm, g.classId)).n;
      rules.push({ ncm: g.ncm, ncm_id: ncm.id, description: ncm.description, uf: g.uf, class_id: g.classId, class_name: cls?.name ?? '', rule_id: own?.id ?? null, changes: ruleChanges, products: covered });
    }
    if (n++ % 200 === 0) await yieldLoop();
  }

  return { products, rules, exceptions: [...exceptions.values()], observations: pendingObs, stats };
}

function labelChanges(changes) {
  return Object.entries(changes).map(([f, c]) => ({ field: f, label: LABELS[f] ?? PRODUCT_LABELS[f] ?? f, from: c.from, to: c.to }));
}
const PRODUCT_LABELS = { name: 'Nome', ncm: 'NCM', tax_origin: 'Origem', anvisa_registry: 'Registro no MS', unit: 'Unidade', is_medicine: 'Medicamento' };

async function previewOf(job, plan) {
  const b = job.batch;
  const known = new Map(plan.products.map((p) => [p.key, p.name]));
  const getName = db.prepare('SELECT name FROM products WHERE id = ?');
  const productName = async key => known.get(key) ?? (typeof key === 'string' ? key.slice(5) : (await getName.get(key))?.name ?? `#${key}`);
  const created = plan.products.filter((p) => p.create).length;
  return {
    files: b.files, notes: b.notes, items: b.items, reform_items: b.reform_items, no_gtin: b.no_gtin, invalid_values: b.invalid_values,
    ignored: b.ignored, source_errors: job.source_errors,
    ufs: Object.values(b.ufs).map((u) => ({ ...u, emitters: u.emitters.size })).sort((x, y) => y.notes - x.notes),
    options: job.options,
    summary: {
      products_created: created,
      products_updated: plan.products.length - created,
      rules: plan.rules.length,
      exceptions: plan.exceptions.length,
      ...plan.stats,
    },
    products: plan.products.slice(0, SHOWN_ROWS).map((p) => ({ id: p.id, name: p.name, create: p.create, codes: p.codes, changes: labelChanges(p.changes) })),
    rules: plan.rules.slice(0, SHOWN_ROWS).map((r) => ({ ncm: r.ncm, description: r.description, uf: r.uf, class_name: r.class_name, products: r.products, changes: labelChanges(r.changes) })),
    exceptions: await mapSeries(plan.exceptions.slice(0, SHOWN_ROWS), async (e) => ({
      id: typeof e.key === 'number' ? e.key : null,
      name: await productName(e.key),
      uf: e.uf,
      changes: labelChanges(e.changes),
    })),
    shown_limit: SHOWN_ROWS,
  };
}

// ---- Gravação -------------------------------------------------------------------

async function applyPlan(job, plan, deps, userName) {
  const { applyFields, autoRegister, findBarcode, insertBarcode } = deps;
  const ids = new Map();
  const realId = (key) => (typeof key === 'number' ? key : ids.get(key) ?? null);
  const done = { products_created: 0, products_updated: 0, rules: 0, exceptions: 0, barcodes: 0 };
  const total = plan.products.length + plan.rules.length + plan.exceptions.length + plan.observations.length + job.batch.documents.size;
  let progress = 0;
  // Blocos curtos: a API continua respondendo durante a gravação
  async function inChunks(list, fn) {
    for (let i = 0; i < list.length; i += 200) {
      await tx(async () => { for (const item of list.slice(i, i + 200)) await fn(item); });
      progress += Math.min(200, list.length - i);
      job.progress = { done: progress, total };
      await yieldLoop();
    }
  }

  // autoRegister abre a própria transação, então os novos ficam fora dos blocos
  let created = 0;
  for (const p of plan.products) {
    if (!p.create) continue;
    const id = await autoRegister(p.codes[0], 'Importação de NFC-e', p.changes.name?.to || '');
    if (!id) continue;
    ids.set(p.key, id);
    done.products_created++;
    if (++created % 50 === 0) await yieldLoop();
  }

  await inChunks(plan.products, async p => {
    const id = p.create ? ids.get(p.key) : p.id;
    if (!id) return;
    for (const code of p.codes) {
      if (await findBarcode(code)) continue;
      const a = analyzeBarcode(code);
      await insertBarcode(id, { code: a.code, type: a.type, note: 'NFC-e' });
      done.barcodes++;
    }
    const data = Object.fromEntries(Object.entries(p.changes).filter(([f]) => !p.create || f !== 'name').map(([f, c]) => [f, c.to]));
    if (Object.keys(data).length && (await applyFields(id, data, { group: null, renew: false })).length && !p.create) done.products_updated++;
  });

  await inChunks(plan.rules, async r => {
    const cols = Object.keys(r.changes);
    const vals = cols.map((f) => r.changes[f].to);
    if (r.rule_id) {
      await db.prepare(`UPDATE ncm_rules SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, r.rule_id);
    } else {
      await db.prepare(`INSERT INTO ncm_rules (ncm_id, uf, class_id, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(r.ncm_id, r.uf, r.class_id, ...vals);
    }
    done.rules++;
  });

  await inChunks(plan.exceptions, async e => {
    const id = realId(e.key);
    if (!id) return;
    const cols = Object.keys(e.changes);
    const vals = cols.map((f) => e.changes[f].to);
    await db.prepare(`INSERT INTO product_tax_uf (product_id, uf, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})
      ON CONFLICT(product_id, uf) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = datetime('now')`).run(id, e.uf, ...vals);
    // Sem nenhum campo próprio, a linha deixa de existir
    await db.prepare(`DELETE FROM product_tax_uf WHERE product_id = ? AND uf = ? AND ${STATE_TAX_FIELDS.map((f) => `${f} = ''`).join(' AND ')}`).run(id, e.uf);
    done.exceptions++;
  });

  await inChunks(plan.observations, async o => {
    const id = realId(o.key);
    if (!id) return;
    await db.prepare(`INSERT INTO xml_observations (product_id, uf, emitter, emitted_at, simples, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id, uf, emitter) DO UPDATE SET emitted_at = excluded.emitted_at, simples = excluded.simples, data = excluded.data
      WHERE excluded.emitted_at >= xml_observations.emitted_at`).run(id, o.uf, o.emitter, o.at, o.simples, JSON.stringify(o.data));
  });

  // Por último: se a gravação parar antes, as mesmas notas podem ser enviadas de novo
  const importId = Number((await db.prepare('INSERT INTO xml_imports (user_name, summary) VALUES (?, ?)').run(userName, JSON.stringify({ notes: job.batch.notes, ...done }))).lastInsertRowid);
  await inChunks([...job.batch.documents.values()], async n => {
    await db.prepare('INSERT OR IGNORE INTO xml_documents (access_key, import_id, uf, emitter, emitted_at) VALUES (?, ?, ?, ?, ?)').run(n.key, importId, n.uf, n.emitter, n.emittedAt);
  });
  return done;
}

// ---- Rotas ----------------------------------------------------------------------

const DEFAULT_OPTIONS = { create_products: true, replace_tax: true, replace_registry: false, use_simples: false };
const readOptions = (b = {}) => Object.fromEntries(Object.entries(DEFAULT_OPTIONS).map(([k, d]) => [k, typeof b[k] === 'boolean' ? b[k] : d]));

let job = null;
let jobTimer = null;

function clearJob() {
  clearTimeout(jobTimer);
  job = null;
}

function jobOut() {
  if (!job) return { status: 'idle' };
  const { status, progress, error, preview, result, id } = job;
  return { id, status, progress, error, preview, result };
}

async function readUploads(j, files) {
  const seen = db.prepare('SELECT 1 FROM xml_documents WHERE access_key = ?');
  const seenInDb = { get: async k => await seen.get(k) };
  let sinceYield = Date.now();
  const onXml = async (buffer) => {
    await addFile(j.batch, buffer, seenInDb);
    j.progress = { done: j.batch.files, total: null };
    if (Date.now() - sinceYield > 15) { await yieldLoop(); sinceYield = Date.now(); }
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.originalname)) {
      try { await readZip(f.path, onXml, () => { j.batch.ignored.not_xml++; }); } catch (e) { j.source_errors.push(`${f.originalname}: ${e.message}`); }
    } else if (/\.xml$/i.test(f.originalname) && f.size <= MAX_XML_BYTES) {
      await onXml(await fs.promises.readFile(f.path));
    } else {
      j.batch.ignored.not_xml++;
    }
  }
}

export function mountNfceImport(admin, deps) {
  const dir = path.join(os.tmpdir(), 'catalogo-nfce');
  fs.mkdirSync(dir, { recursive: true });
  const upload = multer({ dest: dir, limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES } }).array('files');

  const replan = async (j) => {
    j.plan = await buildPlan(j.lines, j.options, deps);
    j.preview = await previewOf(j, j.plan);
  };

  admin.get('/xml-import', (_req, res) => res.json(jobOut()));

  admin.post('/xml-import/start', (req, res, next) => {
    if (job && ['reading', 'planning', 'applying'].includes(job.status)) return next(new HttpError(409, 'Já existe uma importação em andamento'));
    upload(req, res, (err) => {
      const files = req.files ?? [];
      const removeAll = () => files.forEach((f) => fs.rm(f.path, { force: true }, () => {}));
      if (err) {
        removeAll();
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 1 GB: divida em partes'
          : err.code === 'LIMIT_FILE_COUNT' ? `Envie até ${MAX_UPLOAD_FILES} arquivos de cada vez; para mais, use um .zip` : err.message;
        return next(new HttpError(400, message));
      }
      if (!files.length) return next(new HttpError(400, 'Envie arquivos .xml ou .zip'));
      if (job && ['reading', 'planning', 'applying'].includes(job.status)) { removeAll(); return next(new HttpError(409, 'Já existe uma importação em andamento')); }
      clearJob();
      const j = { id: Date.now(), status: 'reading', batch: newBatch(), options: readOptions(), progress: { done: 0, total: null }, source_errors: [] };
      job = j;
      res.status(202).json(jobOut());
      (async () => {
        try {
          await readUploads(j, files);
          j.status = 'planning';
          j.lines = collect(j.batch);
          await replan(j);
          j.status = 'ready';
        } catch (e) {
          j.status = 'error';
          j.error = e.message;
          console.error('importação de NFC-e:', e);
        } finally {
          removeAll();
          if (job === j) jobTimer = setTimeout(clearJob, JOB_TTL_MS);
        }
      })();
    });
  });

  // Recalcula a prévia com outras opções, sem enviar os arquivos de novo
  admin.post('/xml-import/plan', async (req, res, next) => {
    try {
      if (job?.status !== 'ready') throw new HttpError(409, 'Nenhuma prévia pronta');
      job.options = readOptions(req.body);
      await replan(job);
      res.json(jobOut());
    } catch (e) { next(e); }
  });

  admin.post('/xml-import/apply', async (req, res, next) => {
    try {
      const j = job;
      if (j?.status !== 'ready') throw new HttpError(409, 'Nenhuma prévia pronta; envie os arquivos de novo');
      if (Number(req.body.id) !== j.id) throw new HttpError(409, 'A prévia mudou; confira antes de gravar');
      j.status = 'applying';
      j.progress = { done: 0, total: null };
      res.status(202).json(jobOut());
      try {
        // O plano é refeito para refletir o que mudou no cadastro desde a prévia
        j.plan = await buildPlan(j.lines, j.options, deps);
        j.result = await applyPlan(j, j.plan, deps, req.user?.name ?? '');
        j.status = 'done';
      } catch (e) {
        j.status = 'error';
        j.error = e.message;
        console.error('gravação da NFC-e:', e);
      }
    } catch (e) { next(e); }
  });

  admin.delete('/xml-import', (_req, res) => {
    if (job && ['reading', 'planning', 'applying'].includes(job.status)) throw new HttpError(409, 'Aguarde o fim do processamento');
    clearJob();
    res.json(jobOut());
  });
}
