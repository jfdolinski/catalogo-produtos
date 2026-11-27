// Aba "Atualização": fila de revisão, importação de planilha e busca automática em lote.
// Usa os utilitários globais de app.js ($, api, esc, fmtN, fmtDate, googleImagesUrl, goProduct...).

const AUTO_NAME_PREFIX = 'PRODUTO NÃO CADASTRADO';
const upd = { tab: 'queue', autoTimer: null };

window.onUpdateView = () => {
  if (upd.tab === 'auto') loadAutofill();
  loadAiStatus();
};

// Geração de imagem por IA: só aparece configurada em Parâmetros
async function loadAiStatus() {
  try { upd.ai = await api('GET', '/api/admin/ai/status'); } catch { upd.ai = { ready: false }; }
  $('#q-ai-box').classList.toggle('hidden', !upd.ai.ready);
  $('#q-ai').title = upd.ai.ready ? `${upd.ai.provider_name} · ${upd.ai.model}` : '';
}

document.querySelectorAll('.upd-tabs button').forEach((b) => b.addEventListener('click', () => {
  upd.tab = b.dataset.tab;
  document.querySelectorAll('.upd-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.upd-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== upd.tab));
  if (upd.tab === 'auto') loadAutofill();
  if (upd.tab === 'xml') loadXmlImport();
}));

const isUpdateVisible = () => $('#app').classList.contains('view-update');

function setMsg(sel, text, kind = 'ok') {
  const el = $(sel);
  el.textContent = text;
  el.className = `msg ${kind}`;
}

// ============================================================ Fila de atualização
const queue = { ids: [], index: 0, product: null, lookup: null };
const qForm = $('#q-form');

$('#q-start').addEventListener('click', async () => {
  const source = $('#q-source').value;
  const params = new URLSearchParams(source ? { [source]: 1 } : {});
  if (source === 'pending' || source === 'provisional') params.set('order', 'requests');
  const { ids } = await api('GET', `/api/admin/product-ids?${params}`);
  queue.ids = ids;
  queue.index = 0;
  if (!ids.length) {
    $('#q-item').classList.add('hidden');
    $('#q-empty').classList.remove('hidden');
    $('#q-empty').textContent = 'Nenhum item nesta seleção. 🎉';
    $('#q-progress').textContent = '';
    return;
  }
  loadQueueItem();
});

async function loadQueueItem() {
  const id = queue.ids[queue.index];
  $('#q-progress').textContent = `Item ${fmtN(queue.index + 1)} de ${fmtN(queue.ids.length)}`;
  $('#q-prev').disabled = queue.index === 0;
  setMsg('#q-msg', '');
  let p;
  try { p = await api('GET', `/api/admin/products/${id}`); }
  catch { // excluído ou mesclado enquanto a fila estava aberta
    queue.ids.splice(queue.index, 1);
    if (queue.index >= queue.ids.length) return finishQueue();
    return loadQueueItem();
  }
  queue.product = p;
  $('#q-empty').classList.add('hidden');
  $('#q-item').classList.remove('hidden');
  renderQueueItem(p);
  queue.lookup = null;
  $('#q-suggest').innerHTML = '';
  const code = p.barcodes.find((b) => /^\d{8,14}$/.test(b.code))?.code;
  if ($('#q-auto-lookup').checked && code) lookupSuggestions(code);
  else if (code) $('#q-suggest').innerHTML = `<button type="button" class="link small" id="q-lookup">🔎 Buscar dados externos para ${esc(code)}</button>`;
  $('#q-lookup')?.addEventListener('click', () => lookupSuggestions(code));
  const nameInput = qForm.elements.name;
  (nameInput.value ? qForm.elements.description : nameInput).focus();
}

function renderQueueItem(p) {
  const auto = p.name.startsWith(AUTO_NAME_PREFIX);
  $('#q-title').textContent = auto ? 'Produto ainda sem nome' : p.name;
  $('#q-codes').innerHTML = p.barcodes.map((b) => `
    <span class="q-code"><code>${esc(b.code)}</code> <small class="muted">${esc(b.type)}</small>
      <a href="${googleImagesUrl(b.code)}" target="_blank" rel="noopener" class="bc-google">🔍 Google</a>
      <a href="${menorPrecoUrl(b.code)}" target="_blank" rel="noopener" class="bc-google" title="Abre o Menor Preço (Nota Paraná) com este código, na sua cidade">💲 Preço</a></span>`).join('') || '<span class="muted">sem código de barras</span>';
  const req = (p.requests || []).filter((r) => r.status === 'pendente');
  $('#q-badges').innerHTML = [
    p.pending ? `<span class="tag">pendente · ${fmtN(req.reduce((a, r) => a + r.request_count, 0))} consulta(s)</span>` : '',
    p.review.data.overdue || p.review.images.overdue ? '<span class="tag danger-tag">vencido</span>' : '',
  ].join(' ');
  const note = $('#q-autofill-note');
  note.classList.toggle('hidden', !p.autofill);
  if (p.autofill) {
    const labels = { name: 'nome', brand: 'marca', category: 'categoria', description: 'descrição', unit: 'unidade', images: 'foto' };
    note.textContent = `Preenchido automaticamente por ${p.autofill.source} em ${fmtDate(p.autofill.filled_at)}`
      + (p.autofill.fields.length ? ` (${p.autofill.fields.map((f) => labels[f] || f).join(', ')})` : '') + ' — confira antes de salvar.';
  }
  qForm.elements.name.value = auto ? '' : p.name;
  qForm.elements.name.placeholder = auto ? p.name : '';
  for (const f of ['brand', 'category', 'unit', 'sku', 'description']) qForm.elements[f].value = p[f] ?? '';
  renderQueueImages(p);
}

function renderQueueImages(p) {
  $('#q-images').innerHTML = p.images.length
    ? p.images.map((im, i) => `
      <figure class="${i === 0 ? 'main' : ''}">
        <img src="${im.url}" alt="">
        ${im.ai_generated ? '<span class="badge ai-badge ai-corner" title="Ilustração gerada por IA, não é foto real">IA</span>' : ''}
        ${im.placeholder ? '<span class="badge muted-badge">padrão</span>' : `<button type="button" class="icon danger" data-del="${im.id}" title="Excluir">✕</button>`}
      </figure>`).join('')
    : '<div class="muted small">Sem imagens</div>';
  $('#q-images').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Excluir esta imagem?')) return;
    queue.product = { ...queue.product, ...(await api('DELETE', `/api/admin/images/${b.dataset.del}`)) };
    renderQueueImages(queue.product);
  }));
}

// Bases públicas são consultadas (com cache no servidor); a Cosmos só aparece se já houver resposta
// guardada para o código — senão vira um botão, porque cada consulta gasta a franquia diária.
async function lookupSuggestions(code) {
  const box = $('#q-suggest');
  box.innerHTML = `<p class="muted small">Buscando ${esc(code)} nas bases externas…</p>`;
  let r;
  try { r = await api('GET', `/api/admin/lookup/${encodeURIComponent(code)}?cosmos=cache`); }
  catch (err) { box.innerHTML = `<p class="msg error">${esc(err.message)}</p>`; return; }
  if (queue.product?.barcodes.every((b) => b.code !== code)) return; // usuário já passou para outro item
  queue.lookup = { code, results: r.results };
  renderSuggestions();
}

async function lookupCosmos(btn) {
  const { code } = queue.lookup;
  btn.disabled = true;
  btn.textContent = 'Consultando a Cosmos…';
  let r;
  try { r = await api('GET', `/api/admin/lookup/${encodeURIComponent(code)}?cosmos=only`); }
  catch (err) { setMsg('#q-msg', err.message, 'error'); btn.disabled = false; return; }
  if (queue.lookup?.code !== code) return;
  queue.lookup.results = [...r.results, ...queue.lookup.results.filter((x) => x.source !== 'cosmos')];
  renderSuggestions();
}

function renderSuggestions() {
  const box = $('#q-suggest');
  const { results } = queue.lookup;
  const found = results.filter((x) => x.name);
  const cosmosPending = results.find((x) => x.source === 'cosmos' && x.skipped);
  const misses = results.filter((x) => !x.name && !x.skipped).map((x) => `${x.source_name}: ${x.error || 'não encontrado'}`);
  const cached = (s) => (s.cached_at ? ` <span title="Resposta guardada; não consultou de novo">· salvo em ${fmtDay(s.cached_at)}</span>` : '');
  box.innerHTML = (found.length ? found.map((s, i) => `
    <div class="sugg">
      ${s.images[0] ? `<img src="${esc(s.images[0])}" alt="" referrerpolicy="no-referrer">` : '<div class="sugg-noimg">sem foto</div>'}
      <div class="sugg-body">
        <div class="small muted">${esc(s.source_name)}${cached(s)}</div>
        <strong>${esc(s.name)}</strong>
        <div class="small">${[s.brand, s.category].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="sugg-actions">
          <button type="button" data-use="${i}">Usar dados</button>
          ${s.images[0] ? `<button type="button" data-img="${i}">Usar foto</button>` : ''}
        </div>
      </div>
    </div>`).join('') : `<p class="muted small">Nenhuma base ${cosmosPending ? 'pública' : 'externa'} conhece este código. Use a busca do Google ao lado do código.</p>`)
    + (cosmosPending ? '<p><button type="button" id="q-cosmos">🔎 Consultar na Cosmos</button> <span class="muted small">usa 1 consulta da franquia diária; a resposta fica guardada</span></p>' : '')
    + (misses.length ? `<p class="muted small">${misses.map(esc).join(' · ')}</p>` : '');
  $('#q-cosmos')?.addEventListener('click', (e) => lookupCosmos(e.currentTarget));
  box.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
    const s = found[b.dataset.use];
    for (const f of ['name', 'brand', 'category', 'unit', 'description']) if (s[f]) qForm.elements[f].value = s[f];
    setMsg('#q-msg', `Dados de ${s.source_name} preenchidos; revise e salve.`, 'info');
  }));
  box.querySelectorAll('[data-img]').forEach((b) => b.addEventListener('click', () => addQueueImageUrl(found[b.dataset.img].images[0], b)));
}

async function addQueueImageUrl(url, btn) {
  if (!url) return;
  if (btn) btn.disabled = true;
  setMsg('#q-msg', 'Baixando imagem…', 'info');
  try {
    const r = await api('POST', `/api/admin/products/${queue.product.id}/images/from-url`, { url });
    queue.product = { ...queue.product, ...r.product };
    renderQueueImages(queue.product);
    setMsg('#q-msg', 'Imagem adicionada.');
  } catch (err) {
    setMsg('#q-msg', err.message, 'error');
    if (btn) btn.disabled = false;
  }
}

async function generateQueueAiImage() {
  const btn = $('#q-ai');
  const p = queue.product;
  if (!p) return;
  const body = {};
  for (const f of ['name', 'brand', 'category', 'unit', 'description']) body[f] = qForm.elements[f].value.trim();
  btn.disabled = true;
  btn.textContent = 'Gerando… (pode levar até 1 minuto)';
  setMsg('#q-msg', 'Gerando imagem por IA…', 'info');
  try {
    const r = await api('POST', `/api/admin/products/${p.id}/images/ai`, body);
    if (queue.product?.id !== p.id) return; // usuário já passou para outro item
    queue.product = { ...queue.product, ...r.product };
    renderQueueImages(queue.product);
    setMsg('#q-msg', `Imagem gerada por ${upd.ai.provider_name} para "${r.used.name}"${r.used.source ? ` (identificado por ${r.used.source})` : ''}. Confira e exclua se não ficou boa.`);
  } catch (err) {
    setMsg('#q-msg', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Gerar imagem por IA';
  }
}
$('#q-ai').addEventListener('click', generateQueueAiImage);

async function uploadQueueFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length || !queue.product) return;
  const fd = new FormData();
  imgs.forEach((f, i) => fd.append('images', f, f.name || `colada-${i + 1}.png`));
  setMsg('#q-msg', `Enviando ${imgs.length} imagem(ns)…`, 'info');
  try {
    queue.product = { ...queue.product, ...(await api('POST', `/api/admin/products/${queue.product.id}/images`, fd)) };
    renderQueueImages(queue.product);
    setMsg('#q-msg', 'Imagem enviada.');
  } catch (err) { setMsg('#q-msg', err.message, 'error'); }
}

$('#q-url-add').addEventListener('click', () => {
  const url = $('#q-url').value.trim();
  if (url) addQueueImageUrl(url).then(() => { $('#q-url').value = ''; });
});
$('#q-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#q-url-add').click(); } });
$('#q-file').addEventListener('change', (e) => { uploadQueueFiles(e.target.files); e.target.value = ''; });
const qDrop = $('#q-drop');
qDrop.addEventListener('dragover', (e) => { e.preventDefault(); qDrop.classList.add('over'); });
qDrop.addEventListener('dragleave', () => qDrop.classList.remove('over'));
qDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  qDrop.classList.remove('over');
  if (e.dataTransfer.files.length) uploadQueueFiles(e.dataTransfer.files);
  else {
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (/^https?:\/\//.test(url)) addQueueImageUrl(url.trim());
  }
});

// Ctrl+V com imagem copiada (ou URL de imagem fora de um campo de texto)
window.addEventListener('paste', (e) => {
  if (!isUpdateVisible() || upd.tab !== 'queue' || !queue.product || $('#q-item').classList.contains('hidden')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); uploadQueueFiles(files); return; }
  const text = e.clipboardData?.getData('text') || '';
  const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!inField && /^https?:\/\/\S+$/.test(text.trim())) { e.preventDefault(); addQueueImageUrl(text.trim()); }
});

async function saveQueueItem() {
  const p = queue.product;
  const name = qForm.elements.name.value.trim();
  if (!name) { setMsg('#q-msg', 'Informe o nome do produto.', 'error'); qForm.elements.name.focus(); return false; }
  const body = { name };
  for (const f of ['brand', 'category', 'unit', 'sku', 'description']) body[f] = qForm.elements[f].value;
  try {
    await api('PUT', `/api/admin/products/${p.id}`, body);
    if (p.pending) await api('POST', `/api/admin/products/${p.id}/resolve`);
    return true;
  } catch (err) { setMsg('#q-msg', err.message, 'error'); return false; }
}

function nextQueueItem() {
  if (queue.index + 1 >= queue.ids.length) return finishQueue();
  queue.index++;
  loadQueueItem();
}

function finishQueue() {
  queue.product = null;
  $('#q-item').classList.add('hidden');
  $('#q-empty').classList.remove('hidden');
  $('#q-empty').textContent = 'Fim da fila. ✔';
  $('#q-progress').textContent = '';
}

$('#q-save').addEventListener('click', async () => { if (await saveQueueItem()) nextQueueItem(); });
$('#q-skip').addEventListener('click', nextQueueItem);
$('#q-prev').addEventListener('click', () => { if (queue.index > 0) { queue.index--; loadQueueItem(); } });
$('#q-open').addEventListener('click', () => goProduct(queue.product.id));
qForm.addEventListener('submit', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isUpdateVisible() && upd.tab === 'queue' && queue.product) {
    e.preventDefault();
    $('#q-save').click();
  }
});

// ============================================================ Importar planilha
const imp = { file: null, data: null };
const ACTION_LABELS = { create: 'Criar', update: 'Atualizar', unchanged: 'Sem mudança', skip: 'Ignorada', error: 'Erro' };
const FIELD_NAMES = { sku: 'SKU', name: 'Nome', description: 'Descrição', brand: 'Marca', category: 'Categoria', unit: 'Unidade', active: 'Ativo' };

function importOptions() {
  return {
    create_missing: $('#imp-create').checked,
    resolve_pending: $('#imp-resolve').checked,
    download_images: $('#imp-images').checked,
    overwrite_empty: $('#imp-empty').checked,
    only_unnamed: $('#imp-unnamed').checked,
  };
}

async function previewImport() {
  if (!imp.file) return;
  const fd = new FormData();
  fd.append('file', imp.file);
  for (const [k, v] of Object.entries(importOptions())) fd.append(k, v);
  setMsg('#imp-msg', `Lendo ${imp.file.name}…`, 'info');
  $('#imp-result').classList.add('hidden');
  try {
    imp.data = await api('POST', '/api/admin/import/preview', fd);
    setMsg('#imp-msg', '');
    renderImportPreview();
  } catch (err) {
    imp.data = null;
    $('#imp-preview').classList.add('hidden');
    setMsg('#imp-msg', err.message, 'error');
  }
}

function renderImportPreview() {
  const d = imp.data;
  $('#imp-preview').classList.remove('hidden');
  $('#imp-title').textContent = `${d.file} — ${fmtN(d.rows.length)} linha(s)`;
  $('#imp-summary').innerHTML = Object.entries(ACTION_LABELS)
    .filter(([a]) => d.summary[a])
    .map(([a, label]) => `<span class="imp-chip ${a}">${label}: ${fmtN(d.summary[a])}</span>`).join('')
    + `<span class="muted small">Colunas: ${d.columns.map((c) => esc(c.label)).join(', ')}</span>`;
  $('#imp-unknown').textContent = d.unknown_columns.length ? `Colunas ignoradas (nome não reconhecido): ${d.unknown_columns.join(', ')}` : '';
  const applicable = (d.summary.create || 0) + (d.summary.update || 0);
  $('#imp-apply').disabled = !applicable;
  $('#imp-apply').textContent = `Aplicar importação (${fmtN(applicable)})`;
  renderImportRows();
}

function renderImportRows() {
  const filter = $('#imp-filter').value;
  const rows = imp.data.plan.filter((p) => !filter || p.action === filter);
  const shown = rows.slice(0, 500);
  const val = (v) => (v === null || v === undefined || v === '' ? '<span class="muted">vazio</span>' : esc(v === 1 ? 'sim' : v === 0 ? 'não' : v));
  $('#imp-rows').innerHTML = shown.map((p) => {
    const changes = Object.entries(p.changes).map(([f, c]) => p.action === 'create'
      ? `<div><b>${FIELD_NAMES[f] || f}:</b> ${val(c.to)}</div>`
      : `<div><b>${FIELD_NAMES[f] || f}:</b> ${val(c.from)} → ${val(c.to)}</div>`).join('');
    const extra = [
      p.add_barcodes.length ? `<div><b>+ códigos:</b> ${p.add_barcodes.map(esc).join(', ')}</div>` : '',
      p.images.length ? `<div><b>+ imagens:</b> ${p.images.length} URL(s)</div>` : '',
      p.error ? `<div class="msg error">${esc(p.error)}</div>` : '',
      ...(p.warnings || []).map((w) => `<div class="muted">${esc(w)}</div>`),
    ].join('');
    return `<tr>
      <td class="num">${p.line}</td>
      <td><span class="imp-chip ${p.action}">${ACTION_LABELS[p.action]}</span></td>
      <td>${p.product_id ? `<a href="#" data-pid="${p.product_id}">#${p.product_id}</a> ` : ''}${esc(p.name || p.current_name || '')}</td>
      <td class="small">${changes || extra ? changes + extra : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  $('#imp-rows').querySelectorAll('[data-pid]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); goProduct(Number(a.dataset.pid)); }));
  $('#imp-more').textContent = rows.length > shown.length ? `Mostrando ${shown.length} de ${fmtN(rows.length)} linhas.` : '';
}

$('#imp-filter').addEventListener('change', renderImportRows);
['#imp-create', '#imp-resolve', '#imp-images', '#imp-empty', '#imp-unnamed'].forEach((s) => $(s).addEventListener('change', previewImport));

function chooseImportFile(file) {
  if (!file) return;
  imp.file = file;
  previewImport();
}
$('#imp-file').addEventListener('change', (e) => { chooseImportFile(e.target.files[0]); e.target.value = ''; });
const impDrop = $('#imp-drop');
impDrop.addEventListener('dragover', (e) => { e.preventDefault(); impDrop.classList.add('over'); });
impDrop.addEventListener('dragleave', () => impDrop.classList.remove('over'));
impDrop.addEventListener('drop', (e) => { e.preventDefault(); impDrop.classList.remove('over'); chooseImportFile(e.dataTransfer.files[0]); });

$('#imp-cancel').addEventListener('click', () => {
  imp.file = null;
  imp.data = null;
  $('#imp-preview').classList.add('hidden');
  setMsg('#imp-msg', '');
});

$('#imp-apply').addEventListener('click', async () => {
  const d = imp.data;
  const n = (d.summary.create || 0) + (d.summary.update || 0);
  if (!confirm(`Aplicar a importação? ${fmtN(d.summary.create || 0)} produto(s) serão criados e ${fmtN(d.summary.update || 0)} atualizados.`)) return;
  $('#imp-apply').disabled = true;
  setMsg('#imp-msg', `Importando ${fmtN(n)} linha(s)${importOptions().download_images ? ' e baixando imagens' : ''}… isso pode levar alguns minutos.`, 'info');
  try {
    const r = await api('POST', '/api/admin/import/apply', { rows: d.rows, options: importOptions() });
    const s = r.summary;
    $('#imp-preview').classList.add('hidden');
    setMsg('#imp-msg', '');
    $('#imp-result').classList.remove('hidden');
    $('#imp-result').innerHTML = `
      <h2>Importação concluída</h2>
      <div class="imp-summary">
        <span class="imp-chip create">Criados: ${fmtN(s.created)}</span>
        <span class="imp-chip update">Atualizados: ${fmtN(s.updated)}</span>
        <span class="imp-chip unchanged">Sem mudança: ${fmtN(s.unchanged)}</span>
        ${s.skipped ? `<span class="imp-chip skip">Ignorados: ${fmtN(s.skipped)}</span>` : ''}
        ${s.errors ? `<span class="imp-chip error">Com erro: ${fmtN(s.errors)}</span>` : ''}
      </div>
      <p>${fmtN(s.resolved)} item(ns) saíram dos pendentes · ${fmtN(s.images)} imagem(ns) baixada(s)${s.image_errors ? ` · ${fmtN(s.image_errors)} falha(s) de imagem` : ''}</p>
      ${r.image_errors.length ? `<details><summary>Falhas de imagem</summary><ul class="small">${r.image_errors.map((e) => `<li>linha ${e.line}: ${esc(e.url)} — ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}
      ${r.errors.length ? `<details><summary>Linhas com erro</summary><ul class="small">${r.errors.map((e) => `<li>linha ${e.line}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}`;
    imp.file = null;
    imp.data = null;
    loadList();
    loadCategories();
  } catch (err) {
    setMsg('#imp-msg', err.message, 'error');
    $('#imp-apply').disabled = false;
  }
});

$('#imp-model').addEventListener('click', (e) => {
  e.preventDefault();
  const csv = '﻿codigo_barras;sku;nome;descricao;marca;categoria;unidade;ativo;imagem_url\r\n'
    + '7891000315507;CAF-500;Café Torrado 500g;Café torrado e moído;Marca Exemplo;Mercearia;UN;sim;https://exemplo.com/foto1.jpg|https://exemplo.com/foto2.jpg\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'modelo-importacao.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ============================================================ Busca automática em lote
const TARGET_LABELS = { pending: 'Pendentes', provisional: 'Sem nome', no_image: 'Sem foto real', overdue: 'Vencidos' };

async function loadAutofill() {
  let s;
  try { s = await api('GET', '/api/admin/autofill'); } catch { return; }
  renderAutofill(s);
  clearTimeout(upd.autoTimer);
  if (s.running && isUpdateVisible() && upd.tab === 'auto') upd.autoTimer = setTimeout(loadAutofill, 2000);
}

function renderAutofill(s) {
  upd.cosmosSet = s.cosmos_token_set ?? upd.cosmosSet;
  $('#auto-sources').innerHTML = `${upd.cosmosSet ? 'Cosmos (Bluesoft) — opcional, marque abaixo' : '<span class="muted">Cosmos (sem token — configure em ⚙ Parâmetros)</span>'}, Open Food Facts, Open Beauty Facts, Open Products Facts. As respostas ficam guardadas por código.`;
  $('#auto-start').classList.toggle('hidden', s.running);
  $('#auto-stop').classList.toggle('hidden', !s.running);
  ['#auto-target', '#auto-limit', '#auto-skip'].forEach((sel) => { $(sel).disabled = s.running; });
  $('#auto-cosmos').disabled = s.running || !upd.cosmosSet;
  if (!upd.cosmosSet) $('#auto-cosmos').checked = false;
  $('#auto-ai').disabled = s.running || !s.ai_ready;
  if (!s.ai_ready) $('#auto-ai').checked = false;
  $('#auto-ai').parentElement.title = s.ai_ready ? 'Quando nenhuma base tiver foto, gera uma ilustração por IA a partir do produto identificado. Itens sem nome identificado são pulados.'
    : 'Configure o provedor e a chave de IA em ⚙ Parâmetros';
  if (!s.started_at) { $('#auto-status').innerHTML = '<p class="muted small">Nenhuma execução desde que o servidor foi iniciado.</p>'; return; }
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
  $('#auto-status').innerHTML = `
    <div class="progress"><span style="width:${pct}%"></span></div>
    <div class="auto-counts">
      <span><b>${fmtN(s.done)}</b> de ${fmtN(s.total)} (${TARGET_LABELS[s.target] || s.target}${s.use_cosmos ? ', com Cosmos' : ''}${s.use_ai ? ', com IA' : ''})</span>
      <span>Encontrados: <b>${fmtN(s.found)}</b></span>
      <span>Preenchidos: <b>${fmtN(s.applied)}</b></span>
      <span>Não encontrados: <b>${fmtN(s.not_found)}</b></span>
      ${s.errors ? `<span>Falhas de consulta: <b>${fmtN(s.errors)}</b></span>` : ''}
      ${s.use_ai ? `<span>Imagens por IA: <b>${fmtN(s.ai_generated)}</b>${s.ai_errors ? ` (${fmtN(s.ai_errors)} falha(s))` : ''}</span>` : ''}
    </div>
    <div class="small muted">${s.running ? 'Em andamento… pode sair desta tela, continua no servidor.' : esc(s.message)} ·
      início ${fmtDate(s.started_at)}${s.finished_at ? ` · fim ${fmtDate(s.finished_at)}` : ''}</div>`;
  $('#auto-log').innerHTML = s.last.length ? `<table class="dash-table">
    <thead><tr><th>Código</th><th>Produto</th><th>Resultado</th></tr></thead>
    <tbody>${s.last.map((e) => `<tr>
      <td><code>${esc(e.code)}</code></td>
      <td><a href="#" data-pid="${e.id}">${esc(e.name || `#${e.id}`)}</a></td>
      <td class="small">${e.source ? `${esc(e.source)}${e.fields.length ? ` — ${e.fields.join(', ')}` : ' — nada a preencher'}` : e.error ? '<span class="msg error">falha na consulta</span>' : '<span class="muted">não encontrado</span>'}${!e.source && e.ai ? ' · imagem IA' : ''}${e.ai_error ? ` · <span class="msg error" title="${esc(e.ai_error)}">IA falhou</span>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p class="muted small">Nada processado ainda.</p>';
  $('#auto-log').querySelectorAll('[data-pid]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); goProduct(Number(a.dataset.pid)); }));
}

$('#auto-start').addEventListener('click', async () => {
  try {
    const s = await api('POST', '/api/admin/autofill/start', {
      target: $('#auto-target').value,
      limit: Number($('#auto-limit').value) || undefined,
      skip_checked: $('#auto-skip').checked,
      use_cosmos: $('#auto-cosmos').checked,
      use_ai: $('#auto-ai').checked,
    });
    renderAutofill(s);
    if (!s.total) alert('Nenhum item para consultar nesta seleção (todos já foram consultados?).');
    loadAutofill();
  } catch (err) { alert(err.message); }
});

$('#auto-stop').addEventListener('click', async () => {
  await api('POST', '/api/admin/autofill/stop');
  loadAutofill();
});
