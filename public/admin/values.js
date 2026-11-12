// Tela Marcas e categorias: lista os valores de marca, fabricante e categoria com a quantidade de produtos,
// e renomeia (ou junta) um valor em todos os produtos de uma vez.
// Usa $, api, esc, fmtN e loadCategories de app.js, e setMsg de update.js.
const VALUE_LABELS = { brand: ['marca', 'Sem marca'], manufacturer: ['fabricante', 'Sem fabricante'], category: ['categoria', 'Sem categoria'] };
const VALUES_LIMIT = 1000;
const values = { field: 'brand', items: [], empty: 0, seq: 0, timer: null };

async function loadValues() {
  const seq = ++values.seq;
  const q = $('#values-q').value.trim();
  $('#values-info').textContent = 'Carregando…';
  try {
    const r = await api('GET', `/api/admin/field-values/${values.field}?limit=${VALUES_LIMIT}&empty=1${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    if (seq !== values.seq) return;
    values.items = r.items;
    values.empty = r.empty;
    drawValues();
  } catch (err) {
    if (seq === values.seq) { $('#values-info').textContent = ''; setMsg('#values-msg', err.message, 'error'); }
  }
}

// Abre a planilha Nomes já filtrada por este valor (lá dá para corrigir produto a produto)
function namesFilterHref(value) {
  return `#/nomes?${new URLSearchParams({ [values.field]: value ?? '__vazio__' })}`;
}

function drawValues() {
  const [label, emptyLabel] = VALUE_LABELS[values.field];
  const q = $('#values-q').value.trim();
  const total = values.items.reduce((sum, v) => sum + v.products, 0);
  $('#values-info').textContent = `${fmtN(values.items.length)} ${label}(s)${values.items.length >= VALUES_LIMIT ? ` (os ${fmtN(VALUES_LIMIT)} mais usados; busque para achar outros)` : ''} · ${fmtN(total)} produto(s)`;
  const rows = values.items.map((v, i) => `
    <tr data-i="${i}">
      <td><span class="v-text">${esc(v.value)}</span></td>
      <td class="num">${fmtN(v.products)}</td>
      <td><div class="values-actions">
        <button type="button" data-act="rename">Renomear</button>
        <a href="${namesFilterHref(v.value)}">Ver produtos</a>
      </div></td>
    </tr>`).join('');
  const empty = !q && values.empty ? `
    <tr class="muted"><td>${emptyLabel}</td><td class="num">${fmtN(values.empty)}</td>
      <td><a href="${namesFilterHref(null)}">Ver produtos</a></td></tr>` : '';
  $('#values-rows').innerHTML = rows + empty || `<tr><td colspan="3" class="muted">Nenhum valor encontrado.</td></tr>`;
}

function startRename(tr) {
  const v = values.items[Number(tr.dataset.i)];
  const list = { brand: 'brands', manufacturer: 'manufacturers', category: 'categories' }[values.field];
  tr.querySelector('td').innerHTML = `<input class="v-new" value="${esc(v.value)}" list="${list}" aria-label="Novo valor para ${esc(v.value)}" maxlength="120">`;
  tr.querySelector('.values-actions').innerHTML = '<button type="button" class="primary" data-act="save">Salvar</button><button type="button" data-act="cancel">Cancelar</button>';
  const input = tr.querySelector('.v-new');
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveRename(tr); }
    if (e.key === 'Escape') drawValues();
  });
}

async function saveRename(tr) {
  const v = values.items[Number(tr.dataset.i)];
  const [label] = VALUE_LABELS[values.field];
  const to = tr.querySelector('.v-new').value.replace(/\s+/g, ' ').trim();
  if (to === v.value) return drawValues();
  const existing = values.items.find((x) => x.value === to);
  const question = !to
    ? `Tirar a ${label} "${v.value}" de ${fmtN(v.products)} produto(s)? Eles ficam sem ${label}.`
    : existing
      ? `"${to}" já existe em ${fmtN(existing.products)} produto(s). Juntar: os ${fmtN(v.products)} produto(s) de "${v.value}" passam a usar "${to}"?`
      : `Renomear "${v.value}" para "${to}" em ${fmtN(v.products)} produto(s)?`;
  if (!confirm(question)) return;
  tr.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
  setMsg('#values-msg', `Atualizando ${fmtN(v.products)} produto(s)…`);
  try {
    const r = await api('POST', `/api/admin/field-values/${values.field}/rename`, { from: v.value, to });
    setMsg('#values-msg', `${fmtN(r.products)} produto(s) atualizado(s)${r.merged_into_existing ? `, juntados a "${to}"` : ''}.`, 'ok');
    loadCategories(); // sugestões dos campos
  } catch (err) {
    setMsg('#values-msg', err.message, 'error');
  }
  loadValues();
}

$('#values-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  if (btn.dataset.act === 'rename') startRename(tr);
  if (btn.dataset.act === 'save') saveRename(tr);
  if (btn.dataset.act === 'cancel') drawValues();
});
document.querySelectorAll('[data-vfield]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-vfield]').forEach((x) => x.classList.toggle('active', x === b));
  values.field = b.dataset.vfield;
  setMsg('#values-msg', '');
  loadValues();
}));
$('#values-q').addEventListener('input', () => { clearTimeout(values.timer); values.timer = setTimeout(loadValues, 250); });

window.onValuesView = () => { setMsg('#values-msg', ''); loadValues(); };
if (state.user && !$('#values').classList.contains('hidden')) window.onValuesView();
