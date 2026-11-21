// Tela Dicionário: regras de correção (trecho -> texto novo) com prévia antes de aplicar nos produtos atuais.
// Usa $, api, esc, fmtN e fmtDate de app.js, e setMsg de update.js.
const dict = { rules: [], fields: {}, preview: null, testTimer: null };
const dictForm = $('#dict-form');

// Destaca o trecho (sem diferenciar maiúsculas) para a prévia mostrar onde mudou
function markAll(text, part) {
  if (!part) return esc(text);
  const low = text.toLocaleLowerCase('pt-BR');
  const p = part.toLocaleLowerCase('pt-BR');
  let out = '';
  let i = 0;
  for (let at = low.indexOf(p); at >= 0; at = low.indexOf(p, i)) {
    out += `${esc(text.slice(i, at))}<mark>${esc(text.slice(at, at + part.length))}</mark>`;
    i = at + part.length;
  }
  return out + esc(text.slice(i));
}

const ruleBody = () => ({
  id: dictForm.elements.id.value ? Number(dictForm.elements.id.value) : undefined,
  field: dictForm.elements.field.value,
  find: dictForm.elements.find.value.trim(),
  replace: dictForm.elements.replace.value.trim(),
});

async function loadDictionary() {
  try {
    const r = await api('GET', '/api/admin/dictionary');
    dict.rules = r.items;
    dict.fields = r.fields;
    drawRules();
  } catch (err) { setMsg('#dict-msg', err.message, 'error'); }
}

function drawRules() {
  $('#dict-rows').innerHTML = dict.rules.length ? dict.rules.map((r) => `
    <tr class="${r.active ? '' : 'muted'}" data-id="${r.id}">
      <td>${esc(dict.fields[r.field] || r.field)}</td>
      <td><code>${esc(r.find)}</code></td>
      <td>${r.replace ? esc(r.replace) : '<span class="muted">(tira o trecho)</span>'}</td>
      <td class="small">${r.applied_at ? `${fmtN(r.applied_count)} produto(s) em ${fmtDate(r.applied_at)}` : '<span class="muted">só daqui para frente</span>'}</td>
      <td><input type="checkbox" data-act="toggle" ${r.active ? 'checked' : ''} aria-label="Regra ativa"></td>
      <td><div class="dict-actions">
        <button type="button" data-act="edit">Editar</button>
        <button type="button" data-act="reapply" ${r.active ? '' : 'disabled'}>Aplicar nos atuais</button>
        <button type="button" data-act="delete" class="link">Excluir</button>
      </div></td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="muted small">Nenhuma regra ainda. Cadastre a primeira acima (ex.: Procurar "Comp", Trocar por "Comprimidos").</td></tr>';
}

async function showPreview(body) {
  setMsg('#dict-msg', 'Procurando os produtos que mudariam…');
  const p = await api('POST', '/api/admin/dictionary/preview', body);
  dict.preview = { body, result: p };
  setMsg('#dict-msg', '');
  $('#dict-preview').classList.remove('hidden');
  const extra = p.total > p.items.length ? ` (mostrando os ${fmtN(p.items.length)} primeiros)` : '';
  $('#dict-preview-summary').innerHTML = p.total
    ? `<strong>${fmtN(p.total)} produto(s)</strong> mudariam${extra}. Confira antes de aplicar: a troca vale em qualquer trecho do texto.`
    : `Nenhum produto atual muda com esta regra${p.matches ? ` (${fmtN(p.matches)} contêm o trecho, mas já estão como a regra quer)` : ''}. Ela vale para o que for cadastrado daqui para frente.`;
  $('#dict-save-apply').textContent = body.id ? `Salvar e aplicar em ${fmtN(p.total)}` : `Salvar regra e aplicar em ${fmtN(p.total)} produto(s)`;
  $('#dict-save-apply').disabled = !p.total;
  $('#dict-save-only').disabled = false;
  $('#dict-save-only').textContent = body.id ? 'Só salvar a alteração' : 'Só salvar a regra (daqui para frente)';
  $('#dict-preview-rows').innerHTML = p.items.map((it) => `
    <tr><td class="small"><a href="#" data-product="${it.id}">#${it.id}</a></td>
      <td>${markAll(it.before, body.find)}</td>
      <td class="after">${body.replace ? markAll(it.after, body.replace) : esc(it.after)}</td></tr>`).join('');
}

async function saveRule(apply) {
  const { body } = dict.preview || {};
  if (!body) return;
  const buttons = ['#dict-save-apply', '#dict-save-only'].map((s) => $(s));
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const rule = body.id
      ? await api('PUT', `/api/admin/dictionary/${body.id}`, body)
      : await api('POST', '/api/admin/dictionary', body);
    let msg = body.id ? 'Regra alterada.' : 'Regra salva.';
    if (apply) {
      setMsg('#dict-msg', `Aplicando em ${fmtN(dict.preview.result.total)} produto(s)…`);
      const r = await api('POST', `/api/admin/dictionary/${rule.id}/apply`);
      msg += ` ${fmtN(r.changed)} produto(s) corrigido(s).`;
      loadCategories(); // sugestões de marca, fabricante e categoria
    } else msg += ' Vale para o que for cadastrado ou alterado daqui para frente.';
    resetForm();
    setMsg('#dict-msg', msg, 'ok');
    loadDictionary();
  } catch (err) {
    setMsg('#dict-msg', err.message, 'error');
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function resetForm() {
  dictForm.reset();
  dictForm.elements.id.value = '';
  $('#dict-cancel').classList.add('hidden');
  $('#dict-preview').classList.add('hidden');
  dict.preview = null;
}

dictForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = ruleBody();
  if (!body.find) { setMsg('#dict-msg', 'Informe o trecho a procurar.', 'error'); return; }
  try { await showPreview(body); } catch (err) { setMsg('#dict-msg', err.message, 'error'); }
});
$('#dict-preview-rows').addEventListener('click', (e) => {
  const a = e.target.closest('[data-product]');
  if (!a) return;
  e.preventDefault();
  goProduct(Number(a.dataset.product)); // abre o cadastro completo
});
$('#dict-save-apply').addEventListener('click', () => saveRule(true));
$('#dict-save-only').addEventListener('click', () => saveRule(false));
$('#dict-preview-close').addEventListener('click', () => { $('#dict-preview').classList.add('hidden'); dict.preview = null; });
$('#dict-cancel').addEventListener('click', () => { resetForm(); setMsg('#dict-msg', ''); });
// Mudou a regra depois da prévia: a prévia antiga não vale mais
dictForm.addEventListener('input', () => { if (dict.preview) { $('#dict-preview').classList.add('hidden'); dict.preview = null; } });

$('#dict-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('tr').dataset.id);
  const rule = dict.rules.find((r) => r.id === id);
  try {
    if (btn.dataset.act === 'edit') {
      dictForm.elements.id.value = rule.id;
      dictForm.elements.field.value = rule.field;
      dictForm.elements.find.value = rule.find;
      dictForm.elements.replace.value = rule.replace;
      $('#dict-cancel').classList.remove('hidden');
      setMsg('#dict-msg', `Editando a regra "${rule.find}". Clique em Ver prévia para conferir e salvar.`);
      dictForm.elements.find.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (btn.dataset.act === 'reapply') {
      dictForm.elements.id.value = rule.id;
      dictForm.elements.field.value = rule.field;
      dictForm.elements.find.value = rule.find;
      dictForm.elements.replace.value = rule.replace;
      $('#dict-cancel').classList.remove('hidden');
      await showPreview(ruleBody());
    }
    if (btn.dataset.act === 'delete') {
      if (!confirm(`Excluir a regra "${rule.find}" → "${rule.replace}"? Os produtos já corrigidos continuam como estão.`)) return;
      await api('DELETE', `/api/admin/dictionary/${id}`);
      setMsg('#dict-msg', 'Regra excluída.', 'ok');
      loadDictionary();
    }
  } catch (err) { setMsg('#dict-msg', err.message, 'error'); }
});
$('#dict-rows').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'toggle') return;
  const id = Number(e.target.closest('tr').dataset.id);
  try {
    await api('PUT', `/api/admin/dictionary/${id}`, { active: e.target.checked });
    setMsg('#dict-msg', e.target.checked ? 'Regra ativada.' : 'Regra desativada: não vale mais para o que for cadastrado.', 'ok');
    loadDictionary();
  } catch (err) { setMsg('#dict-msg', err.message, 'error'); e.target.checked = !e.target.checked; }
});

async function runTest() {
  const text = $('#dict-test-text').value;
  if (!text.trim()) { $('#dict-test-result').textContent = ''; return; }
  try {
    const r = await api('POST', '/api/admin/dictionary/test', { field: $('#dict-test-field').value, text });
    $('#dict-test-result').innerHTML = `Fica: <strong>${esc(r.after)}</strong>`;
  } catch (err) { $('#dict-test-result').textContent = err.message; }
}
$('#dict-test-text').addEventListener('input', () => { clearTimeout(dict.testTimer); dict.testTimer = setTimeout(runTest, 300); });
$('#dict-test-field').addEventListener('change', runTest);

window.onDictionaryView = () => { setMsg('#dict-msg', ''); loadDictionary(); };
if (state.user && !$('#dictionary').classList.contains('hidden')) window.onDictionaryView();
