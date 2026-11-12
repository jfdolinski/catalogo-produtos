// Tratamento de espaços de todo texto que entra no sistema: sem espaço no início e no fim, e um só entre as palavras.
// \s também pega o espaço invisível (NBSP) que costuma vir de páginas e do Excel.

export const cleanLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Campos de várias linhas mantêm as quebras; o tratamento vale para cada linha
export const cleanMultiline = (s) => String(s ?? '').replace(/\r\n?/g, '\n').split('\n')
  .map((line) => line.replace(/\s+/g, ' ').trim()).join('\n').trim();

const MULTILINE_FIELDS = new Set(['description', 'notes', 'tax_notes', 'med_notes']);
// Senhas e tokens valem exatamente como foram digitados; "original" é a cópia do que está gravado, usada para detectar conflito
const UNTOUCHED_FIELDS = /password|senha|token|secret|^original$/i;

export const cleanField = (field, value) => (MULTILINE_FIELDS.has(field) ? cleanMultiline(value) : cleanLine(value));

// Aplica em um corpo de requisição inteiro, com as listas e objetos dentro dele
export function cleanBody(value, field = '') {
  if (typeof value === 'string') return UNTOUCHED_FIELDS.test(field) ? value : cleanField(field, value);
  if (Array.isArray(value)) return value.map((item) => cleanBody(item, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanBody(v, k)]));
  return value;
}

// ---- Maiúsculas: primeira letra de cada palavra (nome, marca, fabricante e categoria dos produtos) ----
// "DIPIRONA SÓDICA 500MG C/10 CPR" -> "Dipirona Sódica 500mg C/10 CPR"
// - de, da, do, e, com, para... ficam minúsculos no meio do texto;
// - número com unidade fica padronizado (500mg, 10ml, 1L, 200UI) e "2X" vira "2x";
// - siglas curtas sem vogal (CX, UN, PCT, CPR) e códigos com número (B12, 3M, C30) ficam maiúsculos;
// - algarismos romanos (II, IV) ficam maiúsculos.
export const CASE_FIELDS = new Set(['name', 'brand', 'manufacturer', 'category']);
// Nome provisório do cadastro automático: fica como está (o sistema reconhece por ele)
export const PROVISIONAL_NAME = 'PRODUTO NÃO CADASTRADO';

const LOCALE = 'pt-BR';
const LOWER_WORDS = new Set(['a', 'à', 'ao', 'aos', 'as', 'às', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'p/', 'por', 'sem']);
// Sem "m" (metro): "3M" costuma ser marca; "10M" fica maiúsculo pela regra dos códigos com número
const UNITS = { mg: 'mg', g: 'g', kg: 'kg', mcg: 'mcg', 'µg': 'µg', ml: 'ml', l: 'L', ui: 'UI', cm: 'cm', mm: 'mm', w: 'W', v: 'V', gb: 'GB', mah: 'mAh' };
const NUMBER = /^\d+([.,]\d+)?$/;
const NUMBER_UNIT = /^(\d+(?:[.,]\d+)?)(mg|g|kg|mcg|µg|ml|l|ui|cm|mm|w|v|gb|mah)$/i;
const ROMAN = /^(ii|iii|iv|vi|vii|viii|ix|xi|xii)$/i;
// Siglas com vogal que ficam maiúsculas (as sem vogal, como CX e PCT, já ficam pela regra)
const ACRONYMS = new Set(['usb', 'led', 'lcd', 'tv', 'hd', 'uhd', 'ssd', 'uv', 'uva', 'uvb', 'uht', 'dvd', 'cd', 'pvc', 'abs', 'eva', 'ems', 'aas', 'otc', 'ean', 'gtin', 'upc', 'ue', 'eua', 'usa']);
const VOWEL = /[aeiouáàâãéêíóôõúü]/i;

const lower = (s) => s.toLocaleLowerCase(LOCALE);
const capitalize = (s) => {
  const l = lower(s);
  const i = l.search(/\p{L}/u); // pula apóstrofo e afins: d'água -> D'água
  return i < 0 ? l : l.slice(0, i) + l.charAt(i).toLocaleUpperCase(LOCALE) + l.slice(i + 1);
};

// Uma parte de palavra (sem espaços, hífens nem barras)
function casePart(core, { middle, prevNumber, nextNumber }) {
  if (!core) return core;
  const l = lower(core);
  if (NUMBER.test(core)) return core;
  const nu = l.match(NUMBER_UNIT);
  if (nu) return nu[1] + UNITS[nu[2]];
  if (prevNumber && UNITS[l]) return UNITS[l]; // "500 MG" -> "500 mg"
  if (l === 'x' && (prevNumber || nextNumber)) return 'x';
  if (/^\d+x\d*$/.test(l)) return l; // 2x, 10x20
  const mult = l.match(/^(\d+)x(\d+(?:[.,]\d+)?)(\p{L}+)$/u); // 2x30un, 3x200ml
  if (mult) return `${mult[1]}x${mult[2]}${UNITS[mult[3]] ?? mult[3].toLocaleUpperCase(LOCALE)}`;
  if (/\d/.test(core)) return core.toLocaleUpperCase(LOCALE); // B12, 3M, C30CPR
  if (ROMAN.test(core) || ACRONYMS.has(l)) return core.toLocaleUpperCase(LOCALE);
  if (middle && LOWER_WORDS.has(l)) return l;
  if (/^\p{L}+$/u.test(core) && core.length <= 4 && !VOWEL.test(core) && core.length > 1) return core.toLocaleUpperCase(LOCALE); // CX, PCT
  if (core.length === 1) return core.toLocaleUpperCase(LOCALE);
  return capitalize(core);
}

export function caseWords(text) {
  const words = cleanLine(text).split(' ');
  if (!words[0]) return '';
  const cores = words.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  return words.map((w, i) => {
    const middle = i > 0 && i < words.length - 1;
    const prevNumber = i > 0 && NUMBER.test(cores[i - 1]);
    const nextNumber = i < words.length - 1 && NUMBER.test(cores[i + 1]);
    // "p/" e "c/" sozinhos no meio são abreviações de para/com
    if (middle && /^[pc]\/$/i.test(w)) return lower(w);
    // Divide em pedaços por hífen e barra, mantendo a pontuação de volta
    return w.split(/([-/])/).map((piece, j, all) => {
      if (piece === '-' || piece === '/') return piece;
      const lead = piece.match(/^[^\p{L}\p{N}]*/u)[0];
      const trail = piece.slice(lead.length).match(/[^\p{L}\p{N}]*$/u)[0];
      const core = piece.slice(lead.length, piece.length - trail.length);
      const partMiddle = middle && all.length === 1;
      const partPrevNumber = j === 0 ? prevNumber : NUMBER.test(all[j - 2] ?? '');
      return lead + casePart(core, { middle: partMiddle, prevNumber: partPrevNumber, nextNumber }) + trail;
    }).join('');
  }).join(' ');
}

// Texto de produto: espaços e, nos campos de CASE_FIELDS, maiúsculas por palavra
export function cleanProductField(field, value) {
  const v = cleanField(field, value);
  if (!CASE_FIELDS.has(field) || v.startsWith(PROVISIONAL_NAME)) return v;
  return caseWords(v);
}
