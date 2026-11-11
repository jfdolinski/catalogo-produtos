// Lista DCB: escolha de vários princípios ativos na aba Medicamento, cadastro e importação por arquivo.
// Usa $, api, esc, fmtN e can de app.js, e setMsg de update.js.

// =================================================================== Aba Medicamento
const actives = { list: [], timer: null, seq: 0, options: [], highlight: -1 };

window.setActives = (list) => {
  actives.list = list.map((a) => ({ id: a.id, name: a.name, code: a.code, cas: a.cas, concentration: a.concentration || '' }));
  renderActives();
  syncMedicine();
  closeDcbOptions();
  $('#dcb-search').value = '';
};
window.getActives = () => actives.list.map(({ id, concentration }) => ({ id, concentration }));
window.activeCount = () => actives.list.length;

function syncMedicine() {
  $('#med-fields').classList.toggle('hidden', !$('#is-medicine').checked);
}
$('#is-medicine').addEventListener('change', () => { syncMedicine(); updateTabCounts(); });

function renderActives() {
  const has = actives.list.length > 0;
  $('#actives-table').classList.toggle('hidden', !has);
  $('#actives-empty').classList.toggle('hidden', has);
  $('#actives-rows').innerHTML = actives.list.map((a, i) => `<tr>
    <td><strong>${esc(a.name)}</strong>${a.code || a.cas ? `<div class="muted small">${esc([a.code && `DCB ${a.code}`, a.cas && `CAS ${a.cas}`].filter(Boolean).join(' · '))}</div>` : ''}</td>
    <td><input data-conc="${i}" value="${esc(a.concentration)}" placeholder="ex.: 500 mg" aria-label="Concentração de ${esc(a.name)}"></td>
    <td><button type="button" class="icon" data-rm="${i}" title="Remover" aria-label="Remover ${esc(a.name)}">✕</button></td></tr>`).join('');
  $('#actives-rows').querySelectorAll('[data-conc]').forEach((el) => el.addEventListener('input', () => { actives.list[el.dataset.conc].concentration = el.value; }));
  $('#actives-rows').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
    actives.list.splice(Number(b.dataset.rm), 1);
    renderActives();
    updateTabCounts();
  }));
}

function closeDcbOptions() {
  $('#dcb-options').classList.add('hidden');
  actives.options = [];
  actives.highlight = -1;
}

async function searchDcbOptions() {
  const q = $('#dcb-search').value.trim();
  if (q.length < 2) return closeDcbOptions();
  const seq = ++actives.seq;
  let r;
  try { r = await api('GET', `/api/admin/dcb?q=${encodeURIComponent(q)}&active=1&limit=15`); } catch { return; }
  if (seq !== actives.seq) return; // resposta de uma busca antiga
  actives.options = r.items.filter((d) => !actives.list.some((a) => a.id === d.id));
  actives.highlight = actives.options.length ? 0 : -1;
  renderDcbOptions(q, r.total);
}

function renderDcbOptions(q, total) {
  const box = $('#dcb-options');
  box.classList.remove('hidden');
  box.innerHTML = actives.options.length
    ? actives.options.map((d, i) => `<li data-i="${i}" class="${i === actives.highlight ? 'active' : ''}"><strong>${esc(d.name)}</strong>
        <span class="muted small">${esc([d.code && `DCB ${d.code}`, d.cas && `CAS ${d.cas}`].filter(Boolean).join(' · '))}</span></li>`).join('')
    : `<li class="muted small none">${total ? 'Já adicionado.' : `Nada encontrado para "${esc(q)}".${can('dcb') ? ' Cadastre ou importe na tela DCB.' : ''}`}</li>`;
  box.querySelectorAll('li[data-i]').forEach((li) => {
    // mousedown: acontece antes de o campo perder o foco e fechar a lista
    li.addEventListener('mousedown', (e) => { e.preventDefault(); addActive(actives.options[li.dataset.i]); });
  });
}

function addActive(d) {
  actives.list.push({ id: d.id, name: d.name, code: d.code, cas: d.cas, concentration: '' });
  renderActives();
  updateTabCounts();
  $('#dcb-search').value = '';
  closeDcbOptions();
  $('#dcb-search').focus();
}

$('#dcb-search').addEventListener('input', () => {
  clearTimeout(actives.timer);
  actives.timer = setTimeout(searchDcbOptions, 200);
});
$('#dcb-search').addEventListener('blur', () => setTimeout(closeDcbOptions, 100));
$('#dcb-search').addEventListener('keydown', (e) => {
  const n = actives.options.length;
  if (e.key === 'Enter') { // não envia o formulário do produto
    e.preventDefault();
    if (n && actives.highlight >= 0) addActive(actives.options[actives.highlight]);
  } else if (e.key === 'Escape') closeDcbOptions();
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
    e.preventDefault();
    actives.highlight = (actives.highlight + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    $('#dcb-options').querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('active', i === actives.highlight);
      if (i === actives.highlight) li.scrollIntoView({ block: 'nearest' });
    });
  }
});

// =================================================================== Tela DCB
const DCB_PAGE = 100;
const dcbList = { items: [], total: 0, page: 1, timer: null, current: null };

window.onDcbView = () => loadDcb();

async function loadDcb({ more = false } = {}) {
  dcbList.page = more ? dcbList.page + 1 : 1;
  const q = encodeURIComponent($('#dcb-q').value.trim());
  const d = await api('GET', `/api/admin/dcb?q=${q}&active=${$('#dcb-status').value}&limit=${DCB_PAGE}&page=${dcbList.page}`);
  dcbList.items = more ? [...dcbList.items, ...d.items] : d.items;
  dcbList.total = d.total;
  $('#dcb-count').textContent = `Mostrando ${fmtN(dcbList.items.length)} de ${fmtN(d.total)}`;
  $('#dcb-rows').innerHTML = dcbList.items.length ? dcbList.items.map((x) => `<tr class="${x.active ? '' : 'muted'}">
      <td>${esc(x.code) || '—'}</td>
      <td>${esc(x.name)}${x.active ? '' : ' <span class="small">(inativa)</span>'}</td>
      <td>${esc(x.cas) || '—'}</td>
      <td class="num">${fmtN(x.products)}</td>
      <td><button type="button" data-dcb="${x.id}">Editar</button></td></tr>`).join('')
    : `<tr><td colspan="5" class="muted small">${$('#dcb-q').value.trim() ? 'Nada encontrado.' : 'Lista vazia. Importe o arquivo da DCB ou cadastre manualmente.'}</td></tr>`;
  $('#dcb-rows').querySelectorAll('[data-dcb]').forEach((b) => b.addEventListener('click', () => openDcb(dcbList.items.find((x) => x.id === Number(b.dataset.dcb)))));
  $('#dcb-more').classList.toggle('hidden', dcbList.items.length >= d.total);
}

$('#dcb-q').addEventListener('input', () => { clearTimeout(dcbList.timer); dcbList.timer = setTimeout(loadDcb, 250); });
$('#dcb-status').addEventListener('change', () => loadDcb());
$('#dcb-more-btn').addEventListener('click', () => loadDcb({ more: true }));

function openDcb(x) {
  dcbList.current = x || null;
  const f = $('#dcb-form');
  f.reset();
  $('#dcb-dialog-title').textContent = x ? `DCB ${x.name}` : 'Nova DCB';
  if (x) {
    f.elements.name.value = x.name;
    f.elements.code.value = x.code;
    f.elements.cas.value = x.cas;
    f.elements.active.checked = x.active;
  }
  $('#dcb-delete').classList.toggle('hidden', !x);
  setMsg('#dcb-msg', '');
  $('#dcb-dialog').showModal();
}
$('#dcb-new').addEventListener('click', () => openDcb());

$('#dcb-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target.elements;
  const body = { name: f.name.value, code: f.code.value, cas: f.cas.value, active: f.active.checked };
  try {
    if (dcbList.current) await api('PUT', `/api/admin/dcb/${dcbList.current.id}`, body);
    else await api('POST', '/api/admin/dcb', body);
    $('#dcb-dialog').close();
    loadDcb();
  } catch (err) { setMsg('#dcb-msg', err.message, 'error'); }
});

$('#dcb-delete').addEventListener('click', async () => {
  if (!confirm(`Excluir a DCB ${dcbList.current.name}?`)) return;
  try {
    await api('DELETE', `/api/admin/dcb/${dcbList.current.id}`);
    $('#dcb-dialog').close();
    loadDcb();
  } catch (err) { setMsg('#dcb-msg', err.message, 'error'); }
});

// ---- Importação por arquivo: prévia antes de gravar
const dcbImp = { rows: null, plan: null, summary: null };
const DCB_ACTIONS = { create: 'Nova', update: 'Atualizar', unchanged: 'Sem mudança', error: 'Erro' };
const DCB_CHIP = { create: 'create', update: 'update', unchanged: '', error: 'error' };

async function previewDcbFile(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  setMsg('#dcb-imp-msg', `Lendo ${file.name}…`, 'info');
  $('#dcb-preview').classList.add('hidden');
  try {
    const r = await api('POST', '/api/admin/dcb/import/preview', fd);
    Object.assign(dcbImp, { rows: r.rows, plan: r.plan, summary: r.summary });
    $('#dcb-imp-title').textContent = `${r.file}: ${fmtN(r.summary.total)} linha(s)`;
    $('#dcb-imp-filter').value = '';
    renderDcbPreview();
    $('#dcb-preview').classList.remove('hidden');
    setMsg('#dcb-imp-msg', r.columns.code ? '' : 'O arquivo não tem coluna de número: as DCBs serão localizadas pelo nome.', 'info');
  } catch (err) { setMsg('#dcb-imp-msg', err.message, 'error'); }
}

function renderDcbPreview() {
  const S = dcbImp.summary;
  $('#dcb-imp-summary').innerHTML = ['create', 'update', 'unchanged', 'error'].map((a) =>
    `<span class="imp-chip ${DCB_CHIP[a]}">${DCB_ACTIONS[a]}: ${fmtN(S[a])}</span>`).join(' ');
  const filter = $('#dcb-imp-filter').value;
  const list = filter ? dcbImp.plan.filter((p) => p.action === filter) : dcbImp.plan;
  $('#dcb-imp-rows').innerHTML = list.slice(0, 300).map((p) => `<tr>
    <td>${p.line}</td><td><span class="imp-chip ${DCB_CHIP[p.action]}">${DCB_ACTIONS[p.action]}</span></td>
    <td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.cas)}</td>
    <td class="small">${esc(p.error || p.warning || (p.before ? `antes: ${[p.before.name, p.before.code, p.before.cas].filter(Boolean).join(' · ')}` : ''))}</td></tr>`).join('');
  $('#dcb-imp-more').textContent = list.length > 300 ? `Mostrando as 300 primeiras de ${fmtN(list.length)} linhas.` : '';
  $('#dcb-imp-apply').disabled = !S.create && !S.update;
}

$('#dcb-imp-filter').addEventListener('change', renderDcbPreview);
$('#dcb-file').addEventListener('change', (e) => { previewDcbFile(e.target.files[0]); e.target.value = ''; });
const dcbDrop = $('#dcb-drop');
dcbDrop.addEventListener('dragover', (e) => { e.preventDefault(); dcbDrop.classList.add('over'); });
dcbDrop.addEventListener('dragleave', () => dcbDrop.classList.remove('over'));
dcbDrop.addEventListener('drop', (e) => { e.preventDefault(); dcbDrop.classList.remove('over'); previewDcbFile(e.dataTransfer.files[0]); });

$('#dcb-imp-cancel').addEventListener('click', () => {
  $('#dcb-preview').classList.add('hidden');
  setMsg('#dcb-imp-msg', '');
});

$('#dcb-imp-apply').addEventListener('click', async () => {
  const btn = $('#dcb-imp-apply');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/admin/dcb/import/apply', { rows: dcbImp.rows, update_existing: $('#dcb-imp-update').checked });
    $('#dcb-preview').classList.add('hidden');
    const S = r.summary;
    setMsg('#dcb-imp-msg', `Importação concluída: ${fmtN(S.create)} nova(s), ${fmtN(S.update)} atualizada(s), ${fmtN(S.unchanged)} sem mudança` +
      (S.error ? `, ${fmtN(S.error)} linha(s) com erro não importada(s).` : '.'));
    loadDcb();
  } catch (err) { setMsg('#dcb-imp-msg', err.message, 'error'); }
  btn.disabled = false;
});

$('#dcb-model').addEventListener('click', (e) => {
  e.preventDefault();
  const csv = '﻿numero_dcb;dcb;cas\r\n00001;NOME DO PRINCIPIO ATIVO;50-78-2\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'modelo-dcb.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});
