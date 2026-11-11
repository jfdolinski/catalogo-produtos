// Atualização > Importar XML: envia NFC-e (.xml ou .zip), mostra a prévia e grava na confirmação.
// Usa $, api, esc e fmtN de app.js, e setMsg de update.js.
const xmlImp = { job: null, view: 'products', timer: null };
const XML_BUSY = ['reading', 'planning', 'applying'];
const XML_IGNORED = {
  not_nfce: 'não são NFC-e (modelo 65)',
  homologation: 'de homologação (teste)',
  not_sale: 'não são venda normal',
  not_authorized: 'sem autorização da Sefaz',
  canceled: 'canceladas por evento no mesmo envio',
  already_imported: 'já importadas antes',
  repeated: 'repetidas neste envio',
  other_document: 'outros documentos fiscais',
  invalid: 'XML inválido ou incompleto',
  not_xml: 'não são XML, ou maiores que 5 MB',
};
const xmlOptions = () => ({
  create_products: $('#xml-create').checked,
  replace_tax: $('#xml-replace-tax').checked,
  replace_registry: $('#xml-replace-registry').checked,
  use_simples: $('#xml-simples').checked,
});
const xmlValue = (c, side) => {
  const v = c[side];
  if (c.field === 'is_medicine') return side === 'to' ? 'Sim' : 'Não';
  return v === '' || v === null || v === undefined ? (side === 'to' ? '<em>herda</em>' : '<span class="muted">vazio</span>') : esc(v);
};
const xmlChanges = (changes) => changes.map((c) => `<div class="small">${esc(c.label)}: ${xmlValue(c, 'from')} → <strong>${xmlValue(c, 'to')}</strong></div>`).join('') || '<span class="muted small">Só inclui o código</span>';

function renderXmlRows(p) {
  const rows = {
    products: () => p.products.map((r) => `<tr><td>${r.create ? '<span class="imp-chip create">novo</span>' : '<span class="imp-chip update">atualizar</span>'}</td>
      <td>${esc(r.name)}${r.codes.length ? `<div class="muted small">Código novo: ${r.codes.map(esc).join(', ')}</div>` : ''}</td><td>${xmlChanges(r.changes)}</td></tr>`),
    rules: () => p.rules.map((r) => `<tr><td><strong>${esc(r.uf)}</strong></td>
      <td>${esc(r.ncm)} ${esc(r.description)}${r.class_name ? `<div class="muted small">${esc(r.class_name)}</div>` : ''}<div class="muted small">${fmtN(r.products)} produto(s) neste NCM seguem esta regra</div></td><td>${xmlChanges(r.changes)}</td></tr>`),
    exceptions: () => p.exceptions.map((r) => `<tr><td><strong>${esc(r.uf)}</strong></td><td>${esc(r.name)}</td><td>${xmlChanges(r.changes)}</td></tr>`),
  }[xmlImp.view]();
  $('#xml-head').innerHTML = { products: '<th>Ação</th><th>Produto</th><th>Alterações</th>', rules: '<th>Estado</th><th>NCM</th><th>Alterações</th>', exceptions: '<th>Estado</th><th>Produto</th><th>Alterações</th>' }[xmlImp.view];
  $('#xml-rows').innerHTML = rows.join('') || '<tr><td colspan="3" class="muted small">Nada a alterar aqui.</td></tr>';
  const total = { products: p.summary.products_created + p.summary.products_updated, rules: p.summary.rules, exceptions: p.summary.exceptions }[xmlImp.view];
  $('#xml-more').textContent = total > p.shown_limit ? `Mostrando os primeiros ${fmtN(p.shown_limit)} de ${fmtN(total)}.` : '';
}

function renderXmlPreview(p) {
  const s = p.summary;
  $('#xml-title').textContent = `${fmtN(p.notes)} nota(s) válidas em ${fmtN(p.files)} arquivo(s), com ${fmtN(p.items)} item(ns)`;
  const chip = (cls, text) => `<span class="imp-chip ${cls}">${text}</span>`;
  $('#xml-summary').innerHTML = [
    chip('create', `${fmtN(s.products_created)} produto(s) novo(s)`),
    chip('update', `${fmtN(s.products_updated)} produto(s) atualizado(s)`),
    chip('update', `${fmtN(s.rules)} regra(s) de NCM`),
    chip('update', `${fmtN(s.exceptions)} exceção(ões) por estado`),
  ].join('');
  $('#xml-ufs').innerHTML = p.ufs.map((u) => `<tr><td><strong>${esc(u.uf)}</strong></td><td class="num">${fmtN(u.notes)}</td><td class="num">${fmtN(u.items)}</td>
    <td class="num">${fmtN(u.reform_items)}</td><td class="num">${fmtN(u.emitters)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted small">Nenhuma nota válida.</td></tr>';
  const notes = [
    p.reform_items ? '' : 'Nenhum item trouxe IBS, CBS ou IS: os campos da reforma não mudam.',
    p.no_gtin && `${fmtN(p.no_gtin)} item(ns) sem GTIN válido ficaram de fora, porque o catálogo localiza o produto pelo código de barras.`,
    s.simples_ignored && `ICMS, PIS e COFINS de emitente do Simples não foram usados em ${fmtN(s.simples_ignored)} produto(s) por estado.`,
    s.kept_different && `${fmtN(s.kept_different)} valor(es) diferente(s) foram mantidos como estão no cadastro, conforme as opções acima.`,
    s.conflicts && `${fmtN(s.conflicts)} campo(s) vieram diferentes entre emitentes ou estados: valeu a maioria e, no empate, a nota mais recente.`,
    s.barcode_conflicts && `${fmtN(s.barcode_conflicts)} item(ns) trazem dois códigos de barras de produtos diferentes do catálogo: valeu o primeiro.`,
    p.invalid_values && `${fmtN(p.invalid_values)} valor(es) fiscal(is) fora do formato foram ignorados.`,
    ...Object.entries(p.ignored).filter(([, n]) => n).map(([k, n]) => `${fmtN(n)} ignorado(s): ${XML_IGNORED[k]}.`),
    ...p.source_errors,
  ].filter(Boolean);
  $('#xml-notes').innerHTML = notes.map((t) => `<li>${esc(t)}</li>`).join('');
  $('#xml-apply').disabled = !(s.products_created + s.products_updated + s.rules + s.exceptions + p.notes);
  renderXmlRows(p);
}

function renderXmlJob(j) {
  xmlImp.job = j;
  const busy = XML_BUSY.includes(j.status);
  $('#xml-busy').classList.toggle('hidden', !busy);
  $('#xml-send').classList.toggle('hidden', busy || j.status === 'ready');
  $('#xml-preview').classList.toggle('hidden', j.status !== 'ready');
  $('#xml-result').classList.toggle('hidden', j.status !== 'done');
  if (busy) {
    const prog = j.progress || {};
    $('#xml-busy').textContent = { reading: `Lendo os arquivos… ${fmtN(prog.done)} lido(s)`, planning: 'Comparando com o cadastro…', applying: `Gravando… ${prog.total ? `${fmtN(prog.done)} de ${fmtN(prog.total)}` : ''}` }[j.status];
  }
  if (j.status === 'ready') {
    for (const [id, key] of [['#xml-create', 'create_products'], ['#xml-replace-tax', 'replace_tax'], ['#xml-replace-registry', 'replace_registry'], ['#xml-simples', 'use_simples']]) $(id).checked = j.preview.options[key];
    renderXmlPreview(j.preview);
  }
  if (j.status === 'done') {
    const r = j.result;
    $('#xml-result').innerHTML = `<h2>Importação gravada</h2>
      <p>${fmtN(r.products_created)} produto(s) novo(s), ${fmtN(r.products_updated)} atualizado(s), ${fmtN(r.barcodes)} código(s) de barras incluído(s),
      ${fmtN(r.rules)} regra(s) de NCM e ${fmtN(r.exceptions)} exceção(ões) por estado.</p>
      <button type="button" id="xml-again">Importar mais notas</button>`;
    $('#xml-again').addEventListener('click', xmlReset);
  }
  if (j.status === 'error') setMsg('#xml-msg', `Não foi possível concluir: ${j.error}`, 'error');
  clearTimeout(xmlImp.timer);
  if (busy) xmlImp.timer = setTimeout(loadXmlImport, 1000);
}

async function loadXmlImport() {
  try { renderXmlJob(await api('GET', '/api/admin/xml-import')); } catch (err) { setMsg('#xml-msg', err.message, 'error'); }
}
window.loadXmlImport = loadXmlImport;

async function xmlReset() {
  try {
    renderXmlJob(await api('DELETE', '/api/admin/xml-import'));
    setMsg('#xml-msg', '');
  } catch (err) { setMsg('#xml-msg', err.message, 'error'); }
}

async function xmlSend(files) {
  const list = [...files].filter((f) => /\.(xml|zip)$/i.test(f.name));
  if (!list.length) { setMsg('#xml-msg', 'Escolha arquivos .xml ou .zip.', 'error'); return; }
  const data = new FormData();
  list.forEach((f) => data.append('files', f));
  setMsg('#xml-msg', '');
  $('#xml-send').classList.add('hidden');
  $('#xml-busy').classList.remove('hidden');
  $('#xml-busy').textContent = `Enviando ${fmtN(list.length)} arquivo(s)…`;
  try {
    renderXmlJob(await api('POST', '/api/admin/xml-import/start', data));
  } catch (err) {
    $('#xml-busy').classList.add('hidden');
    $('#xml-send').classList.remove('hidden');
    setMsg('#xml-msg', err.message, 'error');
  }
}

$('#xml-file').addEventListener('change', (e) => { xmlSend(e.target.files); e.target.value = ''; });
const xmlDrop = $('#xml-drop');
xmlDrop.addEventListener('dragover', (e) => { e.preventDefault(); xmlDrop.classList.add('over'); });
xmlDrop.addEventListener('dragleave', () => xmlDrop.classList.remove('over'));
xmlDrop.addEventListener('drop', (e) => { e.preventDefault(); xmlDrop.classList.remove('over'); xmlSend(e.dataTransfer.files); });

for (const id of ['#xml-create', '#xml-replace-tax', '#xml-replace-registry', '#xml-simples']) {
  $(id).addEventListener('change', async () => {
    try { renderXmlJob(await api('POST', '/api/admin/xml-import/plan', xmlOptions())); } catch (err) { setMsg('#xml-msg', err.message, 'error'); }
  });
}
$('#xml-view').addEventListener('change', () => {
  xmlImp.view = $('#xml-view').value;
  if (xmlImp.job?.preview) renderXmlRows(xmlImp.job.preview);
});
$('#xml-cancel').addEventListener('click', xmlReset);
$('#xml-apply').addEventListener('click', async () => {
  try { renderXmlJob(await api('POST', '/api/admin/xml-import/apply', { id: xmlImp.job.id })); } catch (err) { setMsg('#xml-msg', err.message, 'error'); }
});
