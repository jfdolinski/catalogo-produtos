// Tela Nomes: manutenção do nome dos produtos em formato de planilha.
// Só as linhas visíveis ficam na página, então rola pelo catálogo inteiro. As alterações ficam na tela até "Salvar".
// Usa $, api, esc, fmtN e goProduct de app.js, e setMsg de update.js.
const SHEET_COLS = [
  { key: 'id', label: 'ID', width: 76, sortable: true, num: true },
  { key: 'code', label: 'Código de barras', width: 170, sortable: true },
  { key: 'name', label: 'Nome', width: 520, sortable: true, editable: true },
  { key: 'brand', label: 'Marca', width: 170, sortable: true },
  { key: 'status', label: 'Situação', width: 110 },
];
const NAME_COL = SHEET_COLS.findIndex((c) => c.editable);
const SHEET_ROW = 26;
const SHEET_NUM_WIDTH = 60;
const SHEET_PAGE = 200;
const SHEET_SAVE_BATCH = 2000;
const SHEET_MAX_NAME = 300;

const sheet = {
  rows: [], byId: new Map(), total: 0, generation: 0, loading: new Map(), loadTimer: null, searchTimer: null,
  dirty: new Map(), undo: [], redo: [],
  cur: { r: 0, c: NAME_COL }, ext: { r: 0, c: NAME_COL }, all: false,
  editing: null, barEditing: false, dragging: false, clickEdit: null, saving: false, busy: false, opened: false, drawQueued: false,
  sort: 'name', dir: 'asc', fitted: false,
};
const scroller = $('#sheet-scroll');
const editor = $('#sheet-editor');
const formula = $('#sheet-formula');

const shownName = (row) => (sheet.dirty.has(row.id) ? sheet.dirty.get(row.id).name : row.name);
const invalidName = (name) => !name.trim() || name.trim().length > SHEET_MAX_NAME;
const colLeft = (c) => SHEET_NUM_WIDTH + SHEET_COLS.slice(0, c).reduce((sum, col) => sum + col.width, 0);
const sheetWidth = () => colLeft(SHEET_COLS.length);
const columnLetter = (c) => String.fromCharCode(65 + c);

function cellText(row, key) {
  if (key === 'name') return shownName(row);
  if (key === 'code') return row.code ? row.code + (row.codes > 1 ? ` +${row.codes - 1}` : '') : '';
  if (key === 'status') return row.active ? (row.pending ? 'Pendente' : 'Ativo') : 'Inativo';
  return String(row[key] ?? '');
}

function selection() {
  if (sheet.all) return { r1: 0, r2: Math.max(sheet.total - 1, 0), c1: 0, c2: SHEET_COLS.length - 1 };
  return {
    r1: Math.min(sheet.cur.r, sheet.ext.r), r2: Math.max(sheet.cur.r, sheet.ext.r),
    c1: Math.min(sheet.cur.c, sheet.ext.c), c2: Math.max(sheet.cur.c, sheet.ext.c),
  };
}

// ---- Dados ----------------------------------------------------------------------

function sheetQuery(offset) {
  const params = new URLSearchParams({ offset, limit: SHEET_PAGE, sort: sheet.sort, dir: sheet.dir });
  const q = $('#sheet-q').value.trim();
  if (q) params.set('q', q);
  const filter = $('#sheet-filter').value;
  if (filter) params.set(filter, '1');
  return params;
}

function loadPage(page) {
  if (sheet.loading.has(page)) return sheet.loading.get(page);
  const generation = sheet.generation;
  const job = api('GET', `/api/admin/product-names?${sheetQuery(page * SHEET_PAGE)}`).then((d) => {
    if (generation !== sheet.generation) return;
    sheet.total = d.total;
    d.items.forEach((row, i) => { sheet.rows[d.offset + i] = row; sheet.byId.set(row.id, row); });
    drawSheet();
  }).finally(() => { if (generation === sheet.generation) sheet.loading.delete(page); });
  sheet.loading.set(page, job);
  return job;
}

// Garante as linhas de um intervalo, para copiar ou colar além do que está na tela
async function ensureRows(r1, r2) {
  for (let page = Math.floor(r1 / SHEET_PAGE); page <= Math.floor(r2 / SHEET_PAGE); page++) {
    if (!sheet.rows[page * SHEET_PAGE] || !sheet.rows[Math.min(page * SHEET_PAGE + SHEET_PAGE - 1, sheet.total - 1)]) await loadPage(page);
  }
}

async function reloadSheet({ keepPlace = false } = {}) {
  sheet.generation++;
  sheet.rows = [];
  sheet.byId.clear();
  sheet.loading.clear();
  sheet.all = false;
  if (!keepPlace) {
    sheet.cur = { r: 0, c: sheet.cur.c };
    sheet.ext = { ...sheet.cur };
    scroller.scrollTop = 0;
  }
  try {
    await loadPage(Math.floor(Math.max(scroller.scrollTop - SHEET_ROW, 0) / SHEET_ROW / SHEET_PAGE));
    const last = Math.max(sheet.total - 1, 0);
    sheet.cur.r = Math.min(sheet.cur.r, last);
    sheet.ext.r = Math.min(sheet.ext.r, last);
    drawSheet();
  } catch (err) { setMsg('#names-msg', err.message, 'error'); }
}

// ---- Desenho --------------------------------------------------------------------

function drawHead() {
  const arrow = (c) => (sheet.sort === c.key ? (sheet.dir === 'asc' ? ' ▲' : ' ▼') : '');
  $('#sheet-head').innerHTML = `<div class="sheet-corner" role="columnheader" aria-label="Linha"></div>${SHEET_COLS.map((c, i) => `
    <div class="sheet-th" role="columnheader" data-col="${i}"${sheet.sort === c.key ? ` aria-sort="${sheet.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>
      <button type="button" class="sheet-th-label" ${c.sortable ? `data-sort="${c.key}"` : 'disabled'} tabindex="-1"><span class="sheet-letter">${columnLetter(i)}</span> ${c.label}${arrow(c)}</button>
      <span class="sheet-resize" data-resize="${i}"></span>
    </div>`).join('')}`;
  scroller.style.setProperty('--sheet-cols', `${SHEET_NUM_WIDTH}px ${SHEET_COLS.map((c) => `${c.width}px`).join(' ')}`);
  scroller.style.setProperty('--sheet-width', `${sheetWidth()}px`);
}

function drawSheet() {
  const height = sheet.total * SHEET_ROW;
  const canvas = $('#sheet-canvas');
  canvas.style.height = `${Math.max(height, SHEET_ROW)}px`;
  const first = Math.max(Math.floor((scroller.scrollTop) / SHEET_ROW) - 6, 0);
  // A altura vem do layout; o limite evita desenhar o catálogo inteiro se ele deixar a planilha crescer
  const visible = Math.ceil(Math.min(scroller.clientHeight, window.innerHeight) / SHEET_ROW) + 12;
  const last = Math.min(first + visible, sheet.total);
  const sel = selection();
  const missing = new Set();
  let html = '';
  for (let r = first; r < last; r++) {
    const row = sheet.rows[r];
    if (!row) missing.add(Math.floor(r / SHEET_PAGE));
    const rowSelected = r >= sel.r1 && r <= sel.r2;
    html += `<div class="sheet-row" role="row" aria-rowindex="${r + 2}" data-r="${r}"><div class="sheet-num${rowSelected ? ' in-range' : ''}" role="rowheader" data-num="${r}">${r + 1}</div>`;
    SHEET_COLS.forEach((col, c) => {
      const isCur = r === sheet.cur.r && c === sheet.cur.c;
      const inRange = rowSelected && c >= sel.c1 && c <= sel.c2;
      const classes = ['sheet-cell'];
      if (col.editable) classes.push('editable');
      if (col.num) classes.push('num');
      if (inRange) classes.push('in-range');
      if (isCur) classes.push('current');
      let text = '';
      if (row) {
        text = cellText(row, col.key);
        if (col.editable) {
          const change = sheet.dirty.get(row.id);
          if (change) classes.push(change.conflict ? 'is-conflict' : 'is-dirty');
          if (change && invalidName(change.name)) classes.push('is-error');
        }
        if (col.key === 'status' && !row.active) classes.push('muted');
      }
      html += `<div class="${classes.join(' ')}" role="gridcell" data-r="${r}" data-c="${c}"${isCur ? ' id="sheet-current"' : ''}${inRange ? ' aria-selected="true"' : ''}${col.editable ? '' : ' aria-readonly="true"'} title="${esc(text)}">${esc(text) || (row ? '' : '<span class="muted">…</span>')}</div>`;
    });
    html += '</div>';
  }
  const layer = $('#sheet-rows');
  layer.style.top = `${first * SHEET_ROW}px`;
  layer.innerHTML = sheet.total ? html : '';
  $('#sheet-empty').classList.toggle('hidden', sheet.total > 0 || sheet.loading.size > 0);
  scroller.setAttribute('aria-rowcount', String(sheet.total + 1));
  if (last > first) scroller.setAttribute('aria-activedescendant', 'sheet-current');
  if (missing.size) {
    clearTimeout(sheet.loadTimer);
    sheet.loadTimer = setTimeout(() => missing.forEach((page) => loadPage(page).catch((err) => setMsg('#names-msg', err.message, 'error'))), 70);
  }
  drawChrome(sel);
}

function drawChrome(sel) {
  const row = sheet.rows[sheet.cur.r];
  const col = SHEET_COLS[sheet.cur.c];
  $('#sheet-box').textContent = sheet.total ? `${columnLetter(sheet.cur.c)}${sheet.cur.r + 1}` : '';
  if (!sheet.editing && !sheet.barEditing) formula.value = row ? cellText(row, col.key) : '';
  formula.readOnly = !(row && col.editable);
  const changed = sheet.dirty.size;
  const invalid = [...sheet.dirty.values()].filter((d) => invalidName(d.name)).length;
  const lines = sel.r2 - sel.r1 + 1;
  $('#sheet-status').textContent = [
    `${fmtN(sheet.total)} produto(s)`,
    lines > 1 ? `${fmtN(lines)} linhas selecionadas` : '',
    changed ? `${fmtN(changed)} alterado(s), ainda não salvo(s)` : 'Nada a salvar',
    invalid ? `${fmtN(invalid)} sem nome válido` : '',
  ].filter(Boolean).join(' · ');
  const save = $('#sheet-save');
  save.textContent = sheet.saving ? 'Salvando…' : changed ? `Salvar (${fmtN(changed)})` : 'Salvar';
  save.disabled = !changed || sheet.saving;
  $('#sheet-discard').disabled = !changed || sheet.saving;
  $('#sheet-undo').disabled = !sheet.undo.length || sheet.saving;
  $('#sheet-redo').disabled = !sheet.redo.length || sheet.saving;
}

function queueDraw() {
  if (sheet.drawQueued) return;
  sheet.drawQueued = true;
  requestAnimationFrame(() => { sheet.drawQueued = false; drawSheet(); });
}

function revealCell(r, c) {
  const y = (r + 1) * SHEET_ROW;
  if (y < scroller.scrollTop + SHEET_ROW) scroller.scrollTop = y - SHEET_ROW;
  else if (y + SHEET_ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + SHEET_ROW - scroller.clientHeight;
  const x = colLeft(c);
  const right = x + SHEET_COLS[c].width;
  if (x < scroller.scrollLeft + SHEET_NUM_WIDTH) scroller.scrollLeft = x - SHEET_NUM_WIDTH;
  else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
}

// ---- Seleção --------------------------------------------------------------------

function moveTo(r, c, { extend = false } = {}) {
  const lastRow = Math.max(sheet.total - 1, 0);
  const target = { r: Math.min(Math.max(r, 0), lastRow), c: Math.min(Math.max(c, 0), SHEET_COLS.length - 1) };
  sheet.all = false;
  sheet.ext = target;
  if (!extend) sheet.cur = { ...target };
  revealCell(target.r, target.c);
  drawSheet();
}

// ---- Alterações -----------------------------------------------------------------

function setDirty(id, name, original) {
  if (name === original) sheet.dirty.delete(id);
  else sheet.dirty.set(id, { name, original });
}

// Aplica uma lista { row, name } como um único passo de desfazer
function applyNames(list) {
  const step = [];
  for (const { row, name } of list) {
    const value = name.replace(/\s+/g, ' ').trim(); // o mesmo tratamento do servidor, para a célula já mostrar como vai ficar
    const before = shownName(row);
    if (value === before) continue;
    step.push({ id: row.id, before, after: value, original: sheet.dirty.get(row.id)?.original ?? row.name });
    setDirty(row.id, value, step[step.length - 1].original);
  }
  if (step.length) {
    sheet.undo.push(step);
    sheet.redo = [];
    setMsg('#names-msg', '');
  }
  return step.length;
}

function replay(from, to, side) {
  const step = from.pop();
  if (!step) return;
  step.forEach((c) => setDirty(c.id, c[side], c.original));
  to.push(step);
  drawSheet();
}

async function selectedRowsForNames() {
  const sel = selection();
  if (NAME_COL < sel.c1 || NAME_COL > sel.c2) return null;
  await ensureRows(sel.r1, sel.r2);
  const rows = [];
  for (let r = sel.r1; r <= sel.r2; r++) if (sheet.rows[r]) rows.push(sheet.rows[r]);
  return rows;
}

async function clearSelection() {
  const rows = await selectedRowsForNames();
  if (!rows) { setMsg('#names-msg', 'Só a coluna Nome pode ser alterada.', 'error'); return; }
  applyNames(rows.map((row) => ({ row, name: '' })));
  drawSheet();
}

async function fillDown() {
  const rows = await selectedRowsForNames();
  if (!rows) { setMsg('#names-msg', 'Só a coluna Nome pode ser alterada.', 'error'); return; }
  if (rows.length < 2) return;
  const name = shownName(rows[0]);
  applyNames(rows.slice(1).map((row) => ({ row, name })));
  drawSheet();
}

function selectionText(sel) {
  const lines = [];
  for (let r = sel.r1; r <= sel.r2; r++) {
    const row = sheet.rows[r];
    const cells = [];
    for (let c = sel.c1; c <= sel.c2; c++) cells.push(row ? (SHEET_COLS[c].key === 'code' ? row.code ?? '' : cellText(row, SHEET_COLS[c].key)) : '');
    lines.push(cells.join('\t'));
  }
  return lines.join('\r\n');
}

// Com as linhas já na tela, usa o evento do navegador, que não pede permissão. Seleção maior precisa carregar antes.
function copyToEvent(e) {
  const sel = selection();
  const lines = sel.r2 - sel.r1 + 1;
  let loaded = true;
  for (let r = sel.r1; r <= sel.r2 && loaded; r++) loaded = !!sheet.rows[r];
  if (loaded) {
    e.clipboardData.setData('text/plain', selectionText(sel));
    setMsg('#names-msg', `${fmtN(lines)} linha(s) copiada(s).`);
    return Promise.resolve(true);
  }
  return (async () => {
    await withBusy(true, () => ensureRows(sel.r1, sel.r2));
    try {
      await navigator.clipboard.writeText(selectionText(sel));
      setMsg('#names-msg', `${fmtN(lines)} linha(s) copiada(s).`);
      return true;
    } catch {
      setMsg('#names-msg', 'O navegador não permitiu copiar tantas linhas. Selecione menos linhas ou libere a área de transferência.', 'error');
      return false;
    }
  })();
}

for (const type of ['copy', 'cut']) {
  scroller.addEventListener(type, (e) => {
    if (e.target !== scroller) return;
    e.preventDefault();
    copyToEvent(e).then((ok) => { if (ok && type === 'cut') return clearSelection(); return null; }).catch(() => {});
  });
}

function parseClipboard(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.split('\t').map((cell) => (/^".*"$/.test(cell) ? cell.slice(1, -1).replace(/""/g, '"') : cell)));
}

async function pasteText(text) {
  const grid = parseClipboard(text);
  if (!grid.length || !sheet.total) return;
  const sel = selection();
  const column = NAME_COL - sel.c1;
  const width = Math.max(...grid.map((line) => line.length));
  if (column < 0 || column >= width) { setMsg('#names-msg', 'Só a coluna Nome pode ser alterada. Cole a partir dela.', 'error'); return; }
  // Um valor só preenche toda a seleção, como no Excel
  const single = grid.length === 1 && width === 1;
  const count = single ? sel.r2 - sel.r1 + 1 : grid.length;
  const last = Math.min(sel.r1 + count - 1, sheet.total - 1);
  await withBusy(count > SHEET_PAGE, () => ensureRows(sel.r1, last));
  const list = [];
  for (let r = sel.r1; r <= last; r++) {
    const row = sheet.rows[r];
    if (row) list.push({ row, name: single ? grid[0][0] : grid[r - sel.r1][column] ?? '' });
  }
  const changed = applyNames(list);
  sheet.all = false;
  sheet.cur = { r: sel.r1, c: NAME_COL };
  sheet.ext = { r: last, c: NAME_COL };
  drawSheet();
  const dropped = count - (last - sel.r1 + 1);
  setMsg('#names-msg', `${fmtN(changed)} nome(s) alterado(s).${dropped > 0 ? ` ${fmtN(dropped)} linha(s) ficaram de fora, além do fim da lista.` : ''}`, dropped > 0 ? 'error' : 'ok');
}

async function withBusy(show, fn) {
  if (show) setMsg('#names-msg', 'Carregando as linhas…');
  try { await fn(); } catch (err) { setMsg('#names-msg', err.message, 'error'); throw err; }
}

// ---- Edição da célula -----------------------------------------------------------

// caretX: posição do clique dentro da célula, para o cursor entrar onde a pessoa clicou
function startEdit(initial, caretX) {
  const row = sheet.rows[sheet.cur.r];
  if (!row) return;
  if (!SHEET_COLS[sheet.cur.c].editable) { setMsg('#names-msg', 'Só a coluna Nome pode ser alterada.', 'error'); return; }
  revealCell(sheet.cur.r, sheet.cur.c);
  sheet.editing = { row };
  editor.style.top = `${sheet.cur.r * SHEET_ROW}px`;
  editor.style.left = `${colLeft(NAME_COL)}px`;
  editor.style.width = `${SHEET_COLS[NAME_COL].width}px`;
  editor.value = initial ?? shownName(row);
  editor.classList.remove('hidden');
  formula.value = editor.value;
  editor.focus({ preventScroll: true });
  const caret = caretX === undefined ? editor.value.length : caretAt(editor.value, caretX);
  editor.setSelectionRange(caret, caret);
}

// Quantos caracteres cabem até a posição x (em px, a partir da borda do texto)
const measure = document.createElement('canvas').getContext('2d');
function caretAt(text, x) {
  measure.font = getComputedStyle(editor).font;
  for (let i = 1; i <= text.length; i++) {
    const before = measure.measureText(text.slice(0, i - 1)).width;
    const after = measure.measureText(text.slice(0, i)).width;
    if (x < (before + after) / 2) return i - 1;
  }
  return text.length;
}

function endEdit(save) {
  const editing = sheet.editing;
  if (!editing) return;
  sheet.editing = null;
  editor.classList.add('hidden');
  if (save) applyNames([{ row: editing.row, name: editor.value }]);
  drawSheet();
}

function afterEdit(key, shift) {
  endEdit(key !== 'Escape');
  scroller.focus({ preventScroll: true });
  if (key === 'Enter') moveTo(sheet.cur.r + (shift ? -1 : 1), sheet.cur.c);
  if (key === 'Tab') moveTo(sheet.cur.r, sheet.cur.c + (shift ? -1 : 1));
  // Seta para cima/baixo: confirma e já abre a linha vizinha, para editar uma lista em sequência
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    moveTo(sheet.cur.r + (key === 'ArrowDown' ? 1 : -1), sheet.cur.c);
    startEdit();
  }
}

editor.addEventListener('keydown', (e) => {
  if (['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    afterEdit(e.key, e.shiftKey);
  } else e.stopPropagation();
});
editor.addEventListener('input', () => { formula.value = editor.value; });
editor.addEventListener('blur', () => endEdit(true));
for (const ev of ['mousedown', 'dblclick', 'paste', 'copy', 'cut']) editor.addEventListener(ev, (e) => e.stopPropagation());

// Barra de fórmulas: outra forma de editar a célula atual
formula.addEventListener('focus', () => { sheet.barEditing = !formula.readOnly; });
formula.addEventListener('keydown', (e) => {
  if (!['Enter', 'Escape'].includes(e.key)) return;
  e.preventDefault();
  const row = sheet.rows[sheet.cur.r];
  if (e.key === 'Enter' && row && !formula.readOnly) applyNames([{ row, name: formula.value }]);
  sheet.barEditing = false;
  scroller.focus({ preventScroll: true });
  if (e.key === 'Enter') moveTo(sheet.cur.r + 1, sheet.cur.c);
  else drawSheet();
});
formula.addEventListener('blur', () => {
  if (!sheet.barEditing) return;
  const row = sheet.rows[sheet.cur.r];
  sheet.barEditing = false;
  if (row && !formula.readOnly) applyNames([{ row, name: formula.value }]);
  drawSheet();
});

// ---- Teclado --------------------------------------------------------------------

scroller.addEventListener('keydown', (e) => {
  if (e.target !== scroller) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const { r, c } = sheet.cur;
  const from = e.shiftKey ? sheet.ext : sheet.cur;
  const go = (nr, nc) => { e.preventDefault(); moveTo(nr, nc, { extend: e.shiftKey }); };
  const pageRows = Math.max(Math.floor(scroller.clientHeight / SHEET_ROW) - 2, 1);
  if (ctrl) {
    if (key === 'a') { e.preventDefault(); sheet.all = true; drawSheet(); return; }
    if (key === 'd') { e.preventDefault(); fillDown().catch(() => {}); return; }
    if (key === 'z') { e.preventDefault(); replay(sheet.undo, sheet.redo, 'before'); return; }
    if (key === 'y') { e.preventDefault(); replay(sheet.redo, sheet.undo, 'after'); return; }
    if (key === 's') { e.preventDefault(); saveNames(); return; }
    if (key === 'home') return go(0, 0);
    if (key === 'end') return go(sheet.total - 1, SHEET_COLS.length - 1);
    if (key === 'arrowup') return go(0, from.c);
    if (key === 'arrowdown') return go(sheet.total - 1, from.c);
    if (key === 'arrowleft') return go(from.r, 0);
    if (key === 'arrowright') return go(from.r, SHEET_COLS.length - 1);
    return;
  }
  switch (e.key) {
    case 'ArrowUp': return go(from.r - 1, from.c);
    case 'ArrowDown': return go(from.r + 1, from.c);
    case 'ArrowLeft': return go(from.r, from.c - 1);
    case 'ArrowRight': return go(from.r, from.c + 1);
    case 'PageUp': return go(from.r - pageRows, from.c);
    case 'PageDown': return go(from.r + pageRows, from.c);
    case 'Home': return go(from.r, 0);
    case 'End': return go(from.r, SHEET_COLS.length - 1);
    case 'Tab': e.preventDefault(); moveTo(r, c + (e.shiftKey ? -1 : 1)); return;
    case 'Enter': e.preventDefault(); moveTo(r + (e.shiftKey ? -1 : 1), c); return;
    case 'F2': e.preventDefault(); startEdit(); return;
    case 'Delete': e.preventDefault(); clearSelection().catch(() => {}); return;
    case 'Backspace': e.preventDefault(); startEdit(''); return;
    default:
  }
  if (e.key.length === 1 && !e.altKey) { e.preventDefault(); startEdit(e.key); return; }
  // Acento (tecla morta) ou teclado com composição: a letra chega depois, já dentro da célula aberta
  if (e.key === 'Dead' || e.key === 'Process') startEdit('');
});

scroller.addEventListener('paste', (e) => {
  if (e.target !== scroller) return;
  e.preventDefault();
  pasteText(e.clipboardData.getData('text/plain')).catch(() => {});
});

// ---- Mouse ----------------------------------------------------------------------

$('#sheet-rows').addEventListener('mousedown', (e) => {
  const num = e.target.closest('[data-num]');
  const cell = e.target.closest('[data-c]');
  if (!num && !cell) return;
  e.preventDefault();
  endEdit(true);
  scroller.focus({ preventScroll: true });
  sheet.all = false;
  if (num) {
    const r = Number(num.dataset.num);
    sheet.cur = e.shiftKey ? { ...sheet.cur, c: 0 } : { r, c: 0 };
    sheet.ext = { r, c: SHEET_COLS.length - 1 };
  } else {
    const target = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
    sheet.ext = target;
    if (!e.shiftKey) sheet.cur = { ...target };
    sheet.dragging = true;
    // Clique simples no Nome edita ali mesmo; se o mouse arrastar, vira seleção
    const box = cell.getBoundingClientRect();
    sheet.clickEdit = !e.shiftKey && SHEET_COLS[target.c].editable ? { ...target, x: e.clientX - box.left - 6 } : null;
  }
  drawSheet();
});
$('#sheet-rows').addEventListener('mouseover', (e) => {
  if (!sheet.dragging || !(e.buttons & 1)) return;
  const cell = e.target.closest('[data-c]');
  if (!cell) return;
  sheet.ext = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
  queueDraw();
});
document.addEventListener('mouseup', () => {
  const click = sheet.clickEdit;
  sheet.clickEdit = null;
  sheet.dragging = false;
  if (click && !sheet.all && sheet.ext.r === click.r && sheet.ext.c === click.c && sheet.cur.r === click.r && sheet.cur.c === click.c) {
    startEdit(undefined, click.x);
  }
});
$('#sheet-rows').addEventListener('dblclick', (e) => {
  const cell = e.target.closest('[data-c]');
  if (!cell) return;
  const row = sheet.rows[Number(cell.dataset.r)];
  if (!row) return;
  sheet.cur = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
  sheet.ext = { ...sheet.cur };
  if (SHEET_COLS[sheet.cur.c].editable) startEdit();
  else goProduct(row.id); // as outras colunas abrem o cadastro completo
});

$('#sheet-head').addEventListener('click', (e) => {
  const key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  sheet.dir = sheet.sort === key && sheet.dir === 'asc' ? 'desc' : 'asc';
  sheet.sort = key;
  drawHead();
  reloadSheet();
});
$('#sheet-head').addEventListener('mousedown', (e) => {
  const handle = e.target.closest('[data-resize]');
  if (!handle) return;
  e.preventDefault();
  const col = SHEET_COLS[Number(handle.dataset.resize)];
  const startX = e.clientX;
  const startWidth = col.width;
  const onMove = (m) => { col.width = Math.max(50, startWidth + m.clientX - startX); drawHead(); };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    sheet.fitted = true;
    try { localStorage.setItem('sheetWidths', JSON.stringify(SHEET_COLS.map((c) => c.width))); } catch { /* preferência não essencial */ }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});
scroller.addEventListener('scroll', queueDraw);

// ---- Gravação -------------------------------------------------------------------

async function saveNames() {
  if (sheet.saving || !sheet.dirty.size) return;
  endEdit(true);
  const entries = [...sheet.dirty.entries()];
  const invalid = entries.filter(([, d]) => invalidName(d.name));
  if (invalid.length) {
    setMsg('#names-msg', `${fmtN(invalid.length)} nome(s) vazio(s) ou com mais de ${SHEET_MAX_NAME} caracteres: corrija antes de salvar.`, 'error');
    drawSheet();
    return;
  }
  sheet.saving = true;
  drawSheet();
  let saved = 0;
  let conflicts = 0;
  let missing = 0;
  try {
    for (let i = 0; i < entries.length; i += SHEET_SAVE_BATCH) {
      const items = entries.slice(i, i + SHEET_SAVE_BATCH).map(([id, d]) => ({ id, name: d.name, original: d.original }));
      const r = await api('POST', '/api/admin/product-names', { items });
      for (const s of r.saved) {
        const row = sheet.byId.get(s.id);
        if (row) row.name = s.name;
        sheet.dirty.delete(s.id);
        saved++;
      }
      // Outra pessoa alterou: a versão daqui fica marcada; salvar de novo confirma a troca
      for (const c of r.conflicts) {
        const d = sheet.dirty.get(c.id);
        if (d) { d.original = c.current; d.conflict = true; }
        const row = sheet.byId.get(c.id);
        if (row) row.name = c.current;
        conflicts++;
      }
      for (const id of r.missing) { sheet.dirty.delete(id); missing++; }
      if (i + SHEET_SAVE_BATCH < entries.length) setMsg('#names-msg', `Salvando… ${fmtN(saved)} de ${fmtN(entries.length)}`);
    }
    if (saved || missing) { sheet.undo = []; sheet.redo = []; }
    const parts = [`${fmtN(saved)} nome(s) salvo(s).`];
    if (conflicts) parts.push(`${fmtN(conflicts)} foi(ram) alterado(s) por outra pessoa enquanto você editava e não foi(ram) gravado(s): confira as células em laranja e salve de novo para confirmar.`);
    if (missing) parts.push(`${fmtN(missing)} produto(s) não existe(m) mais.`);
    setMsg('#names-msg', parts.join(' '), conflicts || missing ? 'error' : 'ok');
  } catch (err) {
    setMsg('#names-msg', `${fmtN(saved)} salvo(s). Os demais continuam na tela: ${err.message}`, 'error');
  } finally {
    sheet.saving = false;
    drawSheet();
  }
}

$('#sheet-save').addEventListener('click', saveNames);
$('#sheet-undo').addEventListener('click', () => { replay(sheet.undo, sheet.redo, 'before'); scroller.focus({ preventScroll: true }); });
$('#sheet-redo').addEventListener('click', () => { replay(sheet.redo, sheet.undo, 'after'); scroller.focus({ preventScroll: true }); });
$('#sheet-discard').addEventListener('click', () => {
  if (!confirm(`Descartar ${fmtN(sheet.dirty.size)} alteração(ões) ainda não salva(s)?`)) return;
  sheet.dirty.clear();
  sheet.undo = [];
  sheet.redo = [];
  setMsg('#names-msg', '');
  drawSheet();
});
$('#sheet-q').addEventListener('input', () => { clearTimeout(sheet.searchTimer); sheet.searchTimer = setTimeout(reloadSheet, 300); });
$('#sheet-filter').addEventListener('change', () => reloadSheet());
window.addEventListener('beforeunload', (e) => { if (sheet.dirty.size) e.preventDefault(); });
window.addEventListener('resize', () => { fitNameColumn(); drawHead(); queueDraw(); });

// A coluna Nome ocupa o espaço que sobra, até o usuário ajustar a largura
function fitNameColumn() {
  if (sheet.fitted || !scroller.clientWidth) return;
  const others = SHEET_COLS.reduce((sum, c, i) => (i === NAME_COL ? sum : sum + c.width), SHEET_NUM_WIDTH);
  SHEET_COLS[NAME_COL].width = Math.max(320, scroller.clientWidth - others);
}

window.onNamesView = async () => {
  if (!sheet.opened) {
    sheet.opened = true;
    try {
      const widths = JSON.parse(localStorage.getItem('sheetWidths') || 'null');
      if (Array.isArray(widths) && widths.length === SHEET_COLS.length) { widths.forEach((w, i) => { SHEET_COLS[i].width = Number(w) || SHEET_COLS[i].width; }); sheet.fitted = true; }
    } catch { /* sem armazenamento: larguras padrão */ }
  }
  fitNameColumn();
  drawHead();
  await reloadSheet({ keepPlace: true });
  revealCell(sheet.cur.r, sheet.cur.c); // em tela estreita, a coluna Nome começa fora da vista
  scroller.focus({ preventScroll: true });
};

// O login pode terminar antes deste arquivo carregar: nesse caso a rota já passou por aqui sem abrir a tela
if (state.user && !$('#names').classList.contains('hidden')) window.onNamesView();
