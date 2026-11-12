// Leitura de planilhas (CSV ou XLSX) para importação de cadastros.
import ExcelJS from 'exceljs';
import { cleanMultiline, cleanProductField } from './text.js';

// Nomes de coluna aceitos (comparados sem acentos, minúsculos, com "_" no lugar de espaços/símbolos)
const ALIASES = {
  barcodes: ['codigo_barras', 'codigo_de_barras', 'cod_barras', 'codigos_barras', 'codigos_de_barras', 'barras', 'ean', 'ean13', 'gtin', 'dun', 'dun14', 'barcode', 'barcodes', 'codigo_barra'],
  sku: ['sku', 'codigo_interno', 'cod_interno', 'codigo', 'referencia', 'ref'],
  name: ['nome', 'produto', 'nome_produto', 'nome_do_produto', 'descricao_curta', 'titulo', 'name'],
  description: ['descricao', 'descricao_longa', 'detalhes', 'description'],
  brand: ['marca', 'fabricante', 'laboratorio', 'brand'],
  category: ['categoria', 'grupo', 'secao', 'departamento', 'category'],
  unit: ['unidade', 'un', 'embalagem', 'unit'],
  active: ['ativo', 'status', 'active'],
  images: ['imagem', 'imagens', 'imagem_url', 'url_imagem', 'urls_imagens', 'foto', 'fotos', 'image', 'images', 'image_url'],
};

export const FIELD_LABELS = {
  barcodes: 'Códigos de barras', sku: 'SKU', name: 'Nome', description: 'Descrição', brand: 'Marca',
  category: 'Categoria', unit: 'Unidade', active: 'Ativo', images: 'Imagens (URLs)',
};

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function mapHeaders(headers) {
  const mapping = {};   // índice da coluna -> campo
  const unknown = [];
  headers.forEach((h, i) => {
    const key = norm(h);
    const field = Object.keys(ALIASES).find((f) => ALIASES[f].includes(key));
    if (field && !Object.values(mapping).includes(field)) mapping[i] = field;
    else if (key) unknown.push(String(h).trim());
  });
  return { mapping, unknown };
}

// Texto do arquivo: UTF-8; se vier com caracteres inválidos, tenta Windows-1252 (CSV salvo pelo Excel)
function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const text = utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
  return text.replace(/^﻿/, '');
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [';', '\t', ','].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.hyperlink) return String(v.hyperlink);
    return '';
  }
  // Números grandes (EAN) vêm como number; evita notação científica
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v).toString() : String(v);
  return String(v);
}

async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  const columns = ws.actualColumnCount; // fora do laço: é recalculado a cada leitura e percorre a planilha inteira
  ws.eachRow({ includeEmpty: false }, (r) => {
    const out = [];
    for (let c = 1; c <= columns; c++) out.push(cellText(r.getCell(c).value));
    rows.push(out);
  });
  return rows;
}

const splitList = (s) => String(s || '').split(/[|,;\s]+/).map((x) => x.trim()).filter(Boolean);

function parseActive(v) {
  const s = norm(v);
  if (!s) return undefined;
  if (['1', 'sim', 's', 'true', 'ativo', 'yes', 'y', 'x'].includes(s)) return true;
  if (['0', 'nao', 'n', 'false', 'inativo', 'no'].includes(s)) return false;
  return undefined;
}

// Arquivo CSV ou XLSX -> { format, grid } (grid = lista de linhas, cada uma uma lista de células)
export async function readGrid(buf, filename = '') {
  const isXlsx = /\.xlsx$/i.test(filename) || (buf[0] === 0x50 && buf[1] === 0x4b); // "PK" = zip
  if (/\.xls$/i.test(filename)) throw new Error('Formato .xls antigo não suportado: salve como .xlsx ou .csv');
  if (/\.pdf$/i.test(filename) || buf.subarray(0, 4).toString() === '%PDF') throw new Error('PDF não é suportado: salve a lista como .xlsx ou .csv');
  const grid = isXlsx ? await parseXlsx(buf) : parseCsv(decodeText(buf));
  // Mantém as quebras de linha da célula; quem grava em campo de uma linha só as troca por espaço
  return { format: isXlsx ? 'xlsx' : 'csv', grid: grid.map((row) => row.map(cleanMultiline)) };
}

// Lê o arquivo e devolve linhas normalizadas: { line, barcodes[], sku, name, description, brand, category, unit, active, images[] }
export async function readSpreadsheet(buf, filename = '') {
  const { format, grid } = await readGrid(buf, filename);
  const headerIdx = grid.findIndex((r) => r.some((c) => String(c).trim()));
  if (headerIdx < 0) throw new Error('Planilha vazia');
  const { mapping, unknown } = mapHeaders(grid[headerIdx]);
  if (!Object.values(mapping).some((f) => f === 'barcodes' || f === 'sku')) {
    throw new Error('A planilha precisa de uma coluna de código de barras (ex.: "codigo_barras", "EAN") ou de SKU');
  }
  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r.some((c) => String(c).trim())) continue;
    const row = { line: i + 1 };
    for (const [idx, field] of Object.entries(mapping)) {
      const v = String(r[idx] ?? '').trim();
      if (field === 'barcodes') row.barcodes = splitList(v);
      else if (field === 'images') row.images = v.split(/[|\s]+/).filter(Boolean); // URLs podem ter vírgula
      else if (field === 'active') row.active = parseActive(v);
      else row[field] = cleanProductField(field, v); // a prévia já mostra como vai ficar
    }
    rows.push(row);
  }
  return {
    format,
    columns: Object.values(mapping),
    unknown_columns: unknown,
    rows,
  };
}
