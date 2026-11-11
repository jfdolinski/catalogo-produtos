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
