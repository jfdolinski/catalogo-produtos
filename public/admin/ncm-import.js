// Tela NCM, aba "Importar planilha": cadastro de NCM e vínculo dos produtos, sempre com prévia antes de gravar.
// Usa $, api, esc, fmtN, setMsg e as funções de ncm.js (loadNcm, loadTaxClasses, renderClasses).
const ti = { kind: 'ncm', rows: null, plan: null, summary: null };
const TI_LABELS = { create: 'Novo', update: 'Atualizar', unchanged: 'Sem mudança', skip: 'Ignorado', not_found: 'Produto não encontrado', error: 'Erro' };
const TI_CHIP = { create: 'create', update: 'update', unchanged: '', skip: 'skip', not_found: 'skip', error: 'error' };
const TI_PROBLEMS = ['error', 'not_found', 'skip'];

function downloadCsv(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function resetTiPreview() {
  $('#ti-preview').classList.add('hidden');
  setMsg('#ti-msg', '');
}

$('#ti-kind').addEventListener('change', () => {
  ti.kind = $('#ti-kind').value;
  document.querySelectorAll('[data-ti]').forEach((el) => el.classList.toggle('hidden', el.dataset.ti !== ti.kind));
  resetTiPreview();
});

// A prévia mostra o resultado com as opções escolhidas: mudou a opção, precisa de nova prévia
for (const sel of ['#ti-unregistered', '#ti-create-classes']) {
  $(sel).addEventListener('change', () => {
    if ($('#ti-preview').classList.contains('hidden')) return;
    $('#ti-preview').classList.add('hidden');
    setMsg('#ti-msg', 'A opção mudou: envie o arquivo de novo para ver a nova prévia.', 'info');
  });
}

async function previewTaxFile(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  if (ti.kind === 'link') {
    fd.append('create_classes', String($('#ti-create-classes').checked));
    fd.append('link_unregistered', String($('#ti-unregistered').checked));
  }
  setMsg('#ti-msg', `Lendo ${file.name}…`, 'info');
  $('#ti-preview').classList.add('hidden');
  try {
    const r = await api('POST', `/api/admin/ncm/${ti.kind === 'ncm' ? 'import' : 'link'}/preview`, fd);
    Object.assign(ti, { rows: r.rows, plan: r.plan, summary: r.summary });
    $('#ti-title').textContent = `${r.file}: ${fmtN(r.summary.total)} linha(s)`;
    $('#ti-update-box').classList.toggle('hidden', ti.kind !== 'ncm');
    const actions = Object.keys(TI_LABELS).filter((a) => r.summary[a]);
    $('#ti-filter').innerHTML = '<option value="">Todas as linhas</option>' + actions.map((a) => `<option value="${a}">${TI_LABELS[a]} (${fmtN(r.summary[a])})</option>`).join('');
    $('#ti-head').innerHTML = ti.kind === 'ncm'
      ? '<tr><th>Linha</th><th>Ação</th><th>NCM</th><th>Descrição</th><th>Observação</th></tr>'
      : '<tr><th>Linha</th><th>Ação</th><th>Código</th><th>Produto</th><th>NCM</th><th>Classificação</th><th>Origem</th><th>Observação</th></tr>';
    renderTiPreview();
    $('#ti-preview').classList.remove('hidden');
    setMsg('#ti-msg', '');
  } catch (err) { setMsg('#ti-msg', err.message, 'error'); }
}

function renderTiPreview() {
  const S = ti.summary;
  $('#ti-summary').innerHTML = Object.keys(TI_LABELS).filter((a) => S[a])
    .map((a) => `<span class="imp-chip ${TI_CHIP[a]}">${TI_LABELS[a]}: ${fmtN(S[a])}</span>`).join(' ');
  const filter = $('#ti-filter').value;
  const list = filter ? ti.plan.filter((p) => p.action === filter) : ti.plan;
  const chip = (p) => `<span class="imp-chip ${TI_CHIP[p.action]}">${TI_LABELS[p.action]}</span>`;
  const obs = (p) => esc(p.error || p.warning || (p.new_class ? `cria a classificação ${p.new_class}` : ''));
  $('#ti-rows').innerHTML = list.slice(0, 300).map((p) => (ti.kind === 'ncm'
    ? `<tr><td>${p.line}</td><td>${chip(p)}</td><td>${esc(p.code)}</td><td>${esc(p.description)}</td><td class="small">${obs(p)}</td></tr>`
    : `<tr><td>${p.line}</td><td>${chip(p)}</td><td>${esc(p.ref)}</td><td>${esc(p.name)}</td><td>${esc(p.ncm)}</td><td>${esc(p.tax_class)}</td><td>${esc(p.tax_origin)}</td><td class="small">${obs(p)}</td></tr>`)).join('');
  $('#ti-more').textContent = list.length > 300 ? `Mostrando as 300 primeiras de ${fmtN(list.length)} linhas.` : '';
  $('#ti-apply').disabled = !S.create && !S.update;
  $('#ti-problems').classList.toggle('hidden', !TI_PROBLEMS.some((a) => S[a]));
}

$('#ti-filter').addEventListener('change', renderTiPreview);
$('#ti-file').addEventListener('change', (e) => { previewTaxFile(e.target.files[0]); e.target.value = ''; });
const tiDrop = $('#ti-drop');
tiDrop.addEventListener('dragover', (e) => { e.preventDefault(); tiDrop.classList.add('over'); });
tiDrop.addEventListener('dragleave', () => tiDrop.classList.remove('over'));
tiDrop.addEventListener('drop', (e) => { e.preventDefault(); tiDrop.classList.remove('over'); previewTaxFile(e.dataTransfer.files[0]); });
$('#ti-cancel').addEventListener('click', resetTiPreview);

$('#ti-problems').addEventListener('click', () => {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ti.plan.filter((p) => TI_PROBLEMS.includes(p.action))
    .map((p) => [p.line, TI_LABELS[p.action], ti.kind === 'ncm' ? p.code : p.ref, p.error || ''].map(cell).join(';'));
  downloadCsv(`problemas-${ti.kind}.csv`, ['linha;situacao;codigo;motivo', ...lines].join('\r\n'));
});

$('#ti-apply').addEventListener('click', async () => {
  const btn = $('#ti-apply');
  btn.disabled = true;
  setMsg('#ti-msg', 'Gravando…', 'info');
  try {
    let r;
    if (ti.kind === 'ncm') {
      r = await api('POST', '/api/admin/ncm/import/apply', { rows: ti.rows, update_existing: $('#ti-update').checked });
    } else {
      r = await api('POST', '/api/admin/ncm/link/apply', { rows: ti.rows, create_classes: $('#ti-create-classes').checked, link_unregistered: $('#ti-unregistered').checked });
    }
    const S = r.summary;
    const parts = ti.kind === 'ncm'
      ? [`${fmtN(S.create)} novo(s)`, `${fmtN(S.update)} atualizado(s)`]
      : [`${fmtN(S.update)} produto(s) vinculado(s)`];
    parts.push(`${fmtN(S.unchanged)} sem mudança`);
    if (S.not_found) parts.push(`${fmtN(S.not_found)} produto(s) não encontrado(s)`);
    if (S.skip) parts.push(`${fmtN(S.skip)} ignorada(s)`);
    if (S.error) parts.push(`${fmtN(S.error)} com erro`);
    if (r.classes_created?.length) parts.push(`classificações criadas: ${r.classes_created.join(', ')}`);
    $('#ti-preview').classList.add('hidden');
    setMsg('#ti-msg', `Importação concluída: ${parts.join(', ')}.`);
    loadNcm();
    await loadTaxClasses();
    renderClasses();
  } catch (err) {
    setMsg('#ti-msg', err.message, 'error');
    btn.disabled = false;
  }
});

$('#ti-model-ncm').addEventListener('click', (e) => {
  e.preventDefault();
  downloadCsv('modelo-ncm.csv', 'ncm;descricao;cest;cst_ipi;ipi;cst_pis;pis;cst_cofins;cofins;observacoes\r\n30049069;Outros medicamentos;1300100;53;0;01;2,1;01;9,9;\r\n');
});
$('#ti-model-link').addEventListener('click', (e) => {
  e.preventDefault();
  downloadCsv('modelo-vinculo.csv', 'codigo_barras;ncm;classificacao;origem\r\n7891234567895;30049069;Lista positiva;0\r\n');
});
