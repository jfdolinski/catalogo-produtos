// NCM, classificações tributárias, regras por estado e vínculo com o produto (aba Tributação e edição em massa).
// Usa $, api, esc, fmtN, can, form, goProducts e fmtDay de app.js, e setMsg de update.js.
const NCM_UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const TAX_LABELS = [
  ['cest', 'CEST'], ['cfop', 'CFOP'], ['cst_icms', 'CST/CSOSN do ICMS'], ['icms_rate', 'ICMS', '%'], ['icms_reduction', 'Redução da base do ICMS', '%'],
  ['fcp_rate', 'FCP', '%'], ['mva', 'MVA', '%'], ['icms_st_rate', 'ICMS-ST', '%'], ['cst_ipi', 'CST do IPI'], ['ipi_rate', 'IPI', '%'],
  ['cst_pis', 'CST do PIS'], ['pis_rate', 'PIS', '%'], ['cst_cofins', 'CST da COFINS'], ['cofins_rate', 'COFINS', '%'],
  ['cst_ibs_cbs', 'CST do IBS/CBS'], ['c_class_trib', 'cClassTrib'], ['ibs_uf_rate', 'IBS estadual', '%'], ['ibs_uf_reduction', 'Redução do IBS estadual', '%'],
  ['ibs_mun_rate', 'IBS municipal', '%'], ['ibs_mun_reduction', 'Redução do IBS municipal', '%'], ['cbs_rate', 'CBS', '%'], ['cbs_reduction', 'Redução da CBS', '%'],
  ['cst_is', 'CST do IS'], ['c_class_trib_is', 'cClassTrib do IS'], ['is_rate', 'IS', '%'], ['is_specific', 'IS específico por unidade'],
];
const pct = (v) => (v === '' || v === undefined || v === null ? '—' : `${String(v).replace('.', ',')}%`);
const dash = (v) => (v ? esc(v) : '—');

// =================================================================== Classificações (compartilhadas com o produto)
const taxClasses = { items: [] };

window.loadTaxClasses = async () => {
  try { taxClasses.items = await api('GET', '/api/admin/tax-classes'); } catch { return; }
  document.querySelectorAll('.tax-class-select').forEach((sel) => {
    const value = sel.value;
    sel.innerHTML = '<option value="">— sem classificação —</option>' + taxClasses.items
      .filter((c) => c.active || String(c.id) === value)
      .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    sel.value = value;
  });
  // O produto aberto pode ter chegado antes da lista
  if (state.current && form.elements.tax_class_id.value === '') form.elements.tax_class_id.value = state.current.tax_class_id ?? '';
};

function renderClasses() {
  $('#class-rows').innerHTML = taxClasses.items.length ? taxClasses.items.map((c) => `<tr class="${c.active ? '' : 'muted'}">
      <td>${dash(c.code)}</td><td>${esc(c.name)}${c.active ? '' : ' <span class="small">(inativa)</span>'}</td>
      <td>${dash(c.cst_ibs_cbs)}</td><td>${dash(c.c_class_trib)}</td>
      <td class="num">${fmtN(c.products)}</td><td class="num">${fmtN(c.rules)}</td>
      <td><button type="button" data-class="${c.id}">Editar</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="muted small">Nenhuma classificação. Crie as que você usa, como "Lista positiva" ou "Monofásico".</td></tr>';
  $('#class-rows').querySelectorAll('[data-class]').forEach((b) => b.addEventListener('click', () => openClass(taxClasses.items.find((c) => c.id === Number(b.dataset.class)))));
}

let currentClass = null;
function openClass(c) {
  currentClass = c || null;
  const f = $('#class-form');
  f.reset();
  $('#class-title').textContent = c ? `Classificação ${c.name}` : 'Nova classificação';
  if (c) {
    for (const k of ['name', 'code', ...REFORM_KEYS, 'notes']) f.elements[k].value = c[k];
    f.elements.active.checked = c.active;
  }
  $('#class-delete').classList.toggle('hidden', !c);
  setMsg('#class-msg', '');
  $('#class-dialog').showModal();
}
$('#class-new').addEventListener('click', () => openClass());

$('#class-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target.elements;
  const body = { active: f.active.checked };
  for (const k of ['name', 'code', ...REFORM_KEYS, 'notes']) body[k] = f[k].value;
  try {
    if (currentClass) await api('PUT', `/api/admin/tax-classes/${currentClass.id}`, body);
    else await api('POST', '/api/admin/tax-classes', body);
    $('#class-dialog').close();
    await loadTaxClasses();
    renderClasses();
  } catch (err) { setMsg('#class-msg', err.message, 'error'); }
});

$('#class-delete').addEventListener('click', async () => {
  if (!confirm(`Excluir a classificação ${currentClass.name}?`)) return;
  try {
    await api('DELETE', `/api/admin/tax-classes/${currentClass.id}`);
    $('#class-dialog').close();
    await loadTaxClasses();
    renderClasses();
  } catch (err) { setMsg('#class-msg', err.message, 'error'); }
});

// =================================================================== Tela NCM
const ncmList = { items: [], total: 0, page: 1, current: null, timer: null };
const ncmForm = $('#ncm-form');
const NCM_TEXT = ['code', 'description', 'cest', 'cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', ...REFORM_KEYS, 'notes'];

window.onNcmView = async () => {
  await loadTaxClasses();
  renderClasses();
  loadNcm();
};

document.querySelectorAll('.ncm-tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.ncm-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-npane]').forEach((p) => p.classList.toggle('hidden', p.dataset.npane !== b.dataset.ntab));
}));

async function loadNcm({ more = false } = {}) {
  ncmList.page = more ? ncmList.page + 1 : 1;
  const d = await api('GET', `/api/admin/ncm?q=${encodeURIComponent($('#ncm-q').value.trim())}&limit=100&page=${ncmList.page}`);
  ncmList.items = more ? [...ncmList.items, ...d.items] : d.items;
  ncmList.total = d.total;
  $('#ncm-count').textContent = `Mostrando ${fmtN(ncmList.items.length)} de ${fmtN(d.total)}`;
  renderNcmList();
  $('#ncm-more').classList.toggle('hidden', ncmList.items.length >= d.total);
  const links = [
    d.products_no_ncm && [`${fmtN(d.products_no_ncm)} produto(s) sem NCM`, 'no_ncm'],
    d.products_unregistered && [`${fmtN(d.products_unregistered)} produto(s) com NCM não cadastrado`, 'ncm_unregistered'],
  ].filter(Boolean);
  $('#ncm-links').innerHTML = links.map(([t, flt]) => (can('produtos') ? `<a href="#/produtos" data-flt="${flt}">${t}</a>` : `<span class="muted">${t}</span>`)).join('');
  $('#ncm-links').querySelectorAll('[data-flt]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); goProducts(a.dataset.flt); }));
}

function renderNcmList() {
  $('#ncm-list').innerHTML = ncmList.items.length ? ncmList.items.map((n) => `
    <li data-id="${n.id}" class="${ncmList.current?.id === n.id ? 'selected' : ''}">
      <div class="co-name">${esc(n.code.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3'))}${n.active ? '' : ' <span class="muted small">(inativo)</span>'}</div>
      <div class="small">${esc(n.description)}</div>
      <div class="muted small">${fmtN(n.rules)} regra(s) · ${fmtN(n.products)} produto(s)</div>
    </li>`).join('') : `<li class="muted small">${$('#ncm-q').value.trim() ? 'Nada encontrado.' : 'Nenhum NCM cadastrado.'}</li>`;
  $('#ncm-list').querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => openNcm(Number(li.dataset.id))));
}

$('#ncm-q').addEventListener('input', () => { clearTimeout(ncmList.timer); ncmList.timer = setTimeout(loadNcm, 250); });
$('#ncm-more-btn').addEventListener('click', () => loadNcm({ more: true }));

function showNcm(n) {
  ncmList.current = n;
  ncmForm.reset();
  if (n) {
    for (const k of NCM_TEXT) ncmForm.elements[k].value = n[k];
    ncmForm.elements.active.checked = n.active;
  }
  $('#ncm-title').textContent = n ? `NCM ${n.code}` : 'Novo NCM';
  $('#ncm-meta').textContent = n ? `${fmtN(n.products)} produto(s) usam este NCM · alterado em ${fmtDay(n.updated_at)}` : '';
  $('#ncm-delete').classList.toggle('hidden', !n);
  $('#ncm-empty').classList.add('hidden');
  ncmForm.classList.remove('hidden');
  $('#ncm-rules-block').classList.toggle('hidden', !n);
  setMsg('#ncm-msg', '');
  if (n) renderRules(n.rule_list);
  renderNcmList();
}

async function openNcm(id) { showNcm(await api('GET', `/api/admin/ncm/${id}`)); }
$('#ncm-new').addEventListener('click', () => { showNcm(null); ncmForm.elements.code.focus(); });

ncmForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { active: ncmForm.elements.active.checked };
  for (const k of NCM_TEXT) body[k] = ncmForm.elements[k].value;
  try {
    const n = ncmList.current ? await api('PUT', `/api/admin/ncm/${ncmList.current.id}`, body) : await api('POST', '/api/admin/ncm', body);
    showNcm(n);
    setMsg('#ncm-msg', 'NCM salvo.');
    loadNcm();
  } catch (err) { setMsg('#ncm-msg', err.message, 'error'); }
});

$('#ncm-delete').addEventListener('click', async () => {
  const n = ncmList.current;
  if (!n || !confirm(`Excluir o NCM ${n.code} e todas as suas regras?`)) return;
  try {
    await api('DELETE', `/api/admin/ncm/${n.id}`);
    ncmList.current = null;
    ncmForm.classList.add('hidden');
    $('#ncm-rules-block').classList.add('hidden');
    $('#ncm-empty').classList.remove('hidden');
    loadNcm();
  } catch (err) { setMsg('#ncm-msg', err.message, 'error'); }
});

// ---- Regras
const RULE_TEXT = ['cfop', 'cst_icms', 'icms_rate', 'icms_reduction', 'fcp_rate', 'mva', 'icms_st_rate', 'cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', ...REFORM_KEYS, 'notes'];
const ruleForm = $('#rule-form');
let currentRule = null;

function renderRules(rules) {
  ncmList.current.rule_list = rules;
  $('#rule-rows').innerHTML = rules.length ? rules.map((r) => {
    const others = [['IPI', r.ipi_rate], ['PIS', r.pis_rate], ['COFINS', r.cofins_rate], ['IBS UF', r.ibs_uf_rate], ['IBS mun.', r.ibs_mun_rate], ['CBS', r.cbs_rate], ['IS', r.is_rate]].filter(([, v]) => v).map(([k, v]) => `${k} ${pct(v)}`);
    if (r.c_class_trib) others.push(`cClassTrib ${esc(r.c_class_trib)}`);
    return `<tr>
      <td><strong>${r.uf ? esc(r.uf) : 'Todos'}</strong></td><td>${r.class_id ? esc(r.class_name) : '<span class="muted">Todas</span>'}</td>
      <td>${dash(r.cfop)}</td><td>${dash(r.cst_icms)}</td>
      <td class="num">${pct(r.icms_rate)}</td><td class="num">${pct(r.icms_reduction)}</td><td class="num">${pct(r.fcp_rate)}</td>
      <td class="num">${pct(r.mva)}</td><td class="num">${pct(r.icms_st_rate)}</td>
      <td class="small">${others.join(' · ') || '—'}</td>
      <td><button type="button" data-rule="${r.id}">Editar</button></td></tr>`;
  }).join('') : '<tr><td colspan="11" class="muted small">Nenhuma regra. Comece por uma regra para todos os estados e crie as dos estados que forem diferentes.</td></tr>';
  $('#rule-rows').querySelectorAll('[data-rule]').forEach((b) => b.addEventListener('click', () => openRule(rules.find((r) => r.id === Number(b.dataset.rule)))));
}

$('#rule-ufs').innerHTML = NCM_UFS.map((u) => `<label><input type="checkbox" value="${u}"> ${u}</label>`).join('');
const syncRuleUfs = () => {
  const all = $('#rule-all-ufs').checked;
  $('#rule-ufs').querySelectorAll('input').forEach((i) => { i.disabled = all; if (all) i.checked = false; });
  $('#rule-mark-all').classList.toggle('hidden', all);
};
$('#rule-all-ufs').addEventListener('change', syncRuleUfs);
$('#rule-mark-all').addEventListener('click', () => $('#rule-ufs').querySelectorAll('input').forEach((i) => { i.checked = true; }));

function openRule(r) {
  currentRule = r || null;
  ruleForm.reset();
  const sel = $('#rule-class');
  sel.innerHTML = '<option value="">Todas as classificações</option>' + taxClasses.items
    .filter((c) => c.active || c.id === r?.class_id).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = r?.class_id || '';
  $('#rule-title').textContent = r ? 'Editar regra' : `Nova regra do NCM ${ncmList.current.code}`;
  // Ao editar, o estado fica fixo; para trocar, exclua e crie outra
  $('#rule-ufs-box').classList.toggle('hidden', !!r);
  $('#rule-uf-fixed').classList.toggle('hidden', !r);
  $('#rule-uf-fixed').innerHTML = r ? `Estado: <strong>${r.uf || 'Todos os estados'}</strong>` : '';
  $('#rule-delete').classList.toggle('hidden', !r);
  if (r) for (const k of RULE_TEXT) ruleForm.elements[k].value = r[k];
  ruleForm.querySelector('details').open = !!r && ['cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', ...REFORM_KEYS].some((k) => r[k]);
  syncRuleUfs();
  setMsg('#rule-msg', '');
  $('#rule-dialog').showModal();
}
$('#rule-new').addEventListener('click', () => openRule());

ruleForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const body = { class_id: $('#rule-class').value || null };
  for (const k of RULE_TEXT) body[k] = ruleForm.elements[k].value;
  try {
    let r;
    if (currentRule) r = await api('PUT', `/api/admin/ncm/rules/${currentRule.id}`, body);
    else {
      body.ufs = $('#rule-all-ufs').checked ? [''] : [...$('#rule-ufs').querySelectorAll('input:checked')].map((i) => i.value);
      r = await api('POST', `/api/admin/ncm/${ncmList.current.id}/rules`, body);
    }
    $('#rule-dialog').close();
    renderRules(r.rule_list);
    loadNcm();
  } catch (err) { setMsg('#rule-msg', err.message, 'error'); }
});

$('#rule-delete').addEventListener('click', async () => {
  if (!confirm('Excluir esta regra?')) return;
  try {
    const r = await api('DELETE', `/api/admin/ncm/rules/${currentRule.id}`);
    $('#rule-dialog').close();
    renderRules(r.rule_list);
    loadNcm();
  } catch (err) { setMsg('#rule-msg', err.message, 'error'); }
});

// =================================================================== Produto: aba Tributação e edição em massa
const OVERRIDES = ['cest', 'cfop', 'cst_icms', 'icms_rate', 'cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', ...REFORM_KEYS];
let taxSeq = 0;
let taxTimer = null;

$('#p-tax-uf').innerHTML = '<option value="">Regra geral</option>' + NCM_UFS.map((u) => `<option>${u}</option>`).join('');
try { $('#p-tax-uf').value = localStorage.getItem('taxUf') || ''; } catch { /* sem armazenamento: começa na regra geral */ }

// Abre a exceção automaticamente quando o produto tem algum valor próprio
window.syncTaxOverride = () => {
  const n = OVERRIDES.filter((k) => form.elements[k].value.trim()).length;
  $('#p-override-count').textContent = n ? `(${n} campo(s))` : '';
  if (n) $('#p-tax-override').open = true;
  else if (!document.activeElement?.closest?.('#p-tax-override')) $('#p-tax-override').open = false;
};

window.renderTaxPreview = async () => {
  const seq = ++taxSeq;
  const overrides = Object.fromEntries(OVERRIDES.map((k) => [k, form.elements[k].value.trim()]));
  const ncm = form.elements.ncm.value.trim();
  let r;
  try {
    r = await api('POST', '/api/admin/tax/resolve', { ncm, tax_class_id: form.elements.tax_class_id.value || null, uf: $('#p-tax-uf').value, overrides, product_id: state.current?.id ?? null });
  } catch (err) {
    if (seq === taxSeq) $('#p-tax-result').innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
    return;
  }
  if (seq !== taxSeq) return; // resposta de uma edição antiga
  $('#p-ncm-desc').textContent = r.ncm?.description || '';
  const warn = !ncm ? 'Produto sem NCM: escolha um NCM para receber a tributação.'
    : !r.ncm?.registered ? `O NCM ${r.ncm?.code || ncm} não está cadastrado: cadastre-o na tela NCM para configurar a tributação.`
    : !r.ncm.active ? 'Este NCM está inativo.' : '';
  const rows = TAX_LABELS.filter(([k]) => r.values[k] !== undefined);
  $('#p-tax-result').innerHTML = (warn ? `<p class="tax-warn">${esc(warn)}</p>` : '')
    + (rows.length ? `<table class="dash-table tax-result"><thead><tr><th>Campo</th><th>Valor</th><th>Vem de</th></tr></thead><tbody>
        ${rows.map(([k, label, unit]) => `<tr><td>${label}</td><td><strong>${unit ? pct(r.values[k]) : esc(r.values[k])}</strong></td><td>${esc(r.sources[k])}</td></tr>`).join('')}
      </tbody></table>` : (r.ncm?.registered ? '<p class="muted small">Nenhum valor configurado para este NCM neste estado.</p>' : ''))
    + (r.notes.length ? `<p class="muted small">${r.notes.map(esc).join(' · ')}</p>` : '');
  renderStateExceptions(r.state_exceptions);
};

function renderStateExceptions(list) {
  $('#p-tax-states').classList.toggle('hidden', !list.length);
  $('#p-tax-state-list').innerHTML = list.map((e) => `<div class="state-exception"><strong>${esc(e.uf)}</strong>
    <span class="small">${e.fields.map((f) => `${esc(f.label)}: ${esc(f.value)}`).join(' · ')}</span>
    <button type="button" data-remove-uf="${esc(e.uf)}">Remover</button></div>`).join('');
}
$('#p-tax-state-list').addEventListener('click', async (e) => {
  const uf = e.target.closest('[data-remove-uf]')?.dataset.removeUf;
  if (!uf || !state.current || !confirm(`Remover a exceção deste produto em ${uf}? Ele volta a seguir o NCM e as regras.`)) return;
  try {
    await api('DELETE', `/api/admin/products/${state.current.id}/tax-uf/${uf}`);
    renderTaxPreview();
  } catch (err) { $('#p-tax-result').insertAdjacentHTML('afterbegin', `<p class="msg error">${esc(err.message)}</p>`); }
});

const queueTaxPreview = () => { clearTimeout(taxTimer); taxTimer = setTimeout(renderTaxPreview, 300); };
for (const k of ['ncm', 'tax_class_id', ...OVERRIDES]) {
  form.elements[k].addEventListener('input', () => { queueTaxPreview(); if (OVERRIDES.includes(k)) syncTaxOverride(); });
}
$('#p-tax-uf').addEventListener('change', () => {
  try { localStorage.setItem('taxUf', $('#p-tax-uf').value); } catch { /* preferência não essencial */ }
  renderTaxPreview();
});

// Sugestões de NCM (produto e edição em massa): código e descrição
let ncmOptTimer = null;
async function fillNcmOptions(input) {
  const q = input.value.trim();
  if (q.length < 2) return;
  let d;
  try { d = await api('GET', `/api/admin/ncm?q=${encodeURIComponent(q)}&active=1&limit=20`); } catch { return; }
  $('#ncm-options').innerHTML = d.items.map((n) => `<option value="${n.code}">${esc(n.description)}</option>`).join('');
}
for (const el of [form.elements.ncm, $('#bulk-form').elements.ncm]) {
  el.addEventListener('input', () => { clearTimeout(ncmOptTimer); ncmOptTimer = setTimeout(() => fillNcmOptions(el), 200); });
}
