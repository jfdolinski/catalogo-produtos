const $ = (s, el = document) => el.querySelector(s);

// Campos da reforma tributária: os mesmos no NCM, na classificação, na regra e na exceção do produto
const REFORM_INPUTS = [
  ['cst_ibs_cbs', 'CST do IBS/CBS', '3 dígitos'], ['c_class_trib', 'cClassTrib', '6 dígitos'],
  ['ibs_uf_rate', 'IBS estadual (%)'], ['ibs_uf_reduction', 'Redução do IBS estadual (%)'],
  ['ibs_mun_rate', 'IBS municipal (%)'], ['ibs_mun_reduction', 'Redução do IBS municipal (%)'],
  ['cbs_rate', 'CBS (%)'], ['cbs_reduction', 'Redução da CBS (%)'],
  ['cst_is', 'CST do IS', '3 dígitos'], ['c_class_trib_is', 'cClassTrib do IS', '6 dígitos'],
  ['is_rate', 'IS (%)'], ['is_specific', 'IS específico (R$ por unidade)'],
];
const REFORM_KEYS = REFORM_INPUTS.map(([k]) => k);
document.querySelectorAll('[data-reform-fields]').forEach((box) => {
  box.innerHTML = REFORM_INPUTS.map(([k, label, hint]) => `<label>${label}<input name="${k}" inputmode="${hint ? 'numeric' : 'decimal'}"${hint ? ` placeholder="${hint}"` : ''}></label>`).join('');
});

const state = { token: localStorage.getItem('adminToken') || '', current: null, searchTimer: null, filter: '', merge: null };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const googleImagesUrl = (code) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(code)}`;
// Aceita ISO ('...Z') ou o formato do SQLite ('AAAA-MM-DD HH:MM:SS', UTC)
const toDate = (s) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
const fmtDate = (s) => (s ? toDate(s).toLocaleString('pt-BR') : '');
const fmtDay = (s) => (s ? toDate(s).toLocaleDateString('pt-BR') : '');

// "cadastrado em X · alterado em Y" (omite a alteração se for no mesmo instante do cadastro)
function datesText(d) {
  if (!d?.created_at) return '';
  const changed = d.updated_at && d.updated_at !== d.created_at;
  return `cadastrado em ${fmtDay(d.created_at)}` + (changed ? ` · alterado em ${fmtDate(d.updated_at)}` : '');
}

// ---------------------------------------------------------------- API
async function api(method, url, body) {
  const opts = { method, headers: { Authorization: `Bearer ${state.token}` } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && state.user) { logout(); throw new Error('Sessão expirada'); }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- Login e permissões
// Permissão do usuário logado (administrador tem todas)
const can = (perm) => !!state.user && (state.user.is_admin || [perm].flat().some((p) => state.user.permissions.includes(p)));

async function tryLogin(token, errorText = 'Sessão expirada; entre de novo') {
  state.token = token;
  try {
    const r = await api('GET', '/api/admin/check');
    state.user = r.user;
    localStorage.setItem('adminToken', token);
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#user-name').textContent = r.user.name;
    document.querySelectorAll('[data-perm]').forEach((el) => el.classList.toggle('hidden', !can(el.dataset.perm.split(','))));
    $('#change-password').classList.toggle('hidden', r.user.master);
    if (r.user.master) $('#open-app-link').classList.add('hidden');
    applyRoute();
    if (can('produtos') || can('atualizacao')) { loadList(); loadCategories(); window.loadTaxClasses?.(); }
  } catch {
    showLogin(errorText);
  }
}

let loginMode = 'user';
function setLoginMode(mode) {
  loginMode = mode;
  $('#login-user-fields').classList.toggle('hidden', mode !== 'user');
  $('#login-token-fields').classList.toggle('hidden', mode !== 'token');
  $('#login-switch').textContent = mode === 'user' ? 'Entrar com o token de administração' : 'Entrar com login e senha';
  (mode === 'user' ? $('#login-user') : $('#token')).focus();
}

async function showLogin(error = '') {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-error').textContent = error;
  try {
    const s = await fetch('/api/auth/status').then((r) => r.json());
    $('#login-first').classList.toggle('hidden', s.has_users);
    setLoginMode(s.has_users ? 'user' : 'token');
  } catch { setLoginMode('user'); }
}

function logout() {
  if (state.token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
  localStorage.removeItem('adminToken');
  state.token = '';
  state.user = null;
  showLogin();
}

$('#login-switch').addEventListener('click', () => setLoginMode(loginMode === 'user' ? 'token' : 'user'));

// ---- Cadastre-se: e-mail, senha e CNPJ; a conta fica aguardando a aprovação de um administrador
function showSignup(which) {
  $('#login-form').classList.toggle('hidden', which !== 'login');
  $('#signup-form').classList.toggle('hidden', which !== 'form');
  $('#signup-done').classList.toggle('hidden', which !== 'done');
  $('#signup-error').textContent = '';
  if (which === 'form') $('#signup-email').focus();
}
const cnpjMask = (v) => {
  const d = v.replace(/\D/g, '').slice(0, 14);
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
};
$('#signup-open').addEventListener('click', () => showSignup('form'));
$('#signup-back').addEventListener('click', () => showSignup('login'));
$('#signup-done-back').addEventListener('click', () => { showSignup('login'); $('#login-pass').focus(); });
$('#signup-cnpj').addEventListener('input', (e) => { e.target.value = cnpjMask(e.target.value); });
$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#signup-email').value.trim();
  const password = $('#signup-pass').value;
  const err = (m, el) => { $('#signup-error').textContent = m; el?.focus(); };
  if (!/^\S+@\S+\.\S+$/.test(email)) return err('Informe um e-mail válido.', $('#signup-email'));
  if (password.length < 8) return err('A senha deve ter ao menos 8 caracteres.', $('#signup-pass'));
  if (password !== $('#signup-pass2').value) return err('As senhas não conferem.', $('#signup-pass2'));
  if ($('#signup-cnpj').value.replace(/\D/g, '').length !== 14) return err('O CNPJ tem 14 números.', $('#signup-cnpj'));
  const btn = $('#signup-submit');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, cnpj: $('#signup-cnpj').value }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `Erro ${res.status}`);
    $('#signup-done-text').textContent = `${d.message} Empresa: ${d.company.name.startsWith('CNPJ ') ? d.company.cnpj_formatted : `${d.company.name} (${d.company.cnpj_formatted})`}. Para entrar, use o e-mail ${d.email}.`;
    $('#login-user').value = d.email;
    $('#signup-form').reset();
    showSignup('done');
  } catch (ex) {
    err(ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar cadastro';
  }
});
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  if (loginMode === 'token') return tryLogin($('#token').value.trim(), 'Token inválido');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: $('#login-user').value.trim(), password: $('#login-pass').value }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `Erro ${res.status}`);
    $('#login-pass').value = '';
    tryLogin(d.token);
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', logout);

$('#change-password').addEventListener('click', () => {
  $('#password-form').reset();
  $('#password-msg').textContent = '';
  $('#password-dialog').showModal();
});
$('#password-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target.elements;
  if (f.password.value !== f.password2.value) { $('#password-msg').textContent = 'As senhas não conferem'; $('#password-msg').className = 'msg error'; return; }
  try {
    await api('PUT', '/api/admin/me/password', { password: f.password.value });
    $('#password-dialog').close();
    alert('Senha alterada.');
  } catch (err) { $('#password-msg').textContent = err.message; $('#password-msg').className = 'msg error'; }
});

// ---------------------------------------------------------------- Aplicativo do celular (vínculo por QR code)
const appLink = { timer: null };

function stopAppTimer() { clearInterval(appLink.timer); appLink.timer = null; }

async function loadAppDevices() {
  const box = $('#app-devices');
  try {
    const r = await api('GET', '/api/admin/me/devices');
    box.innerHTML = r.items.length ? `<table class="dash-table"><tbody>${r.items.map((d) => `
      <tr><td><strong>${esc(d.name)}</strong><div class="muted">vinculado em ${fmtDay(d.created_at)} · usado em ${fmtDate(d.last_seen)}${d.app_version ? ` · versão ${esc(d.app_version)}` : ''}</div></td>
      <td style="text-align:right"><button type="button" class="link" data-unlink="${d.id}">Desvincular</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Nenhum celular vinculado.</p>';
    box.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Desvincular este celular? Ele precisará ler um QR code novo para voltar a funcionar.')) return;
      try { await api('DELETE', `/api/admin/me/devices/${b.dataset.unlink}`); loadAppDevices(); }
      catch (err) { setAppMsg(err.message, 'error'); }
    }));
    const dl = $('#app-download');
    dl.classList.toggle('hidden', !r.app);
    if (r.app) dl.innerHTML = `<p><a class="button" href="${esc(r.app.url)}" download>⬇ Baixar o aplicativo (Android, versão ${esc(r.app.version)})</a></p>`;
  } catch (err) { box.innerHTML = `<p class="msg error">${esc(err.message)}</p>`; }
}

function setAppMsg(text, kind = '') { $('#app-msg').textContent = text; $('#app-msg').className = `msg ${kind}`; }

async function newAppCode() {
  stopAppTimer();
  setAppMsg('');
  try {
    const r = await api('POST', '/api/admin/me/app-link');
    $('#app-qr').innerHTML = r.qr_svg;
    $('#app-code').textContent = r.code.replace(/(.{5})/, '$1 ');
    $('#app-server').textContent = `Endereço: ${r.server}`;
    $('#app-new-code').textContent = 'Gerar outro';
    const end = Date.now() + r.minutes * 60000;
    const tick = () => {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      $('#app-expire').textContent = left ? `Vale por ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} e uma vez só.` : 'Código vencido. Gere outro.';
      $('#app-qr').classList.toggle('expired', !left);
      if (!left) stopAppTimer();
      // Quando o celular usa o código, a lista de vinculados muda: confere de vez em quando
      if (left && left % 5 === 0) loadAppDevices();
    };
    tick();
    appLink.timer = setInterval(tick, 1000);
  } catch (err) { setAppMsg(err.message, 'error'); }
}

$('#open-app-link').addEventListener('click', () => {
  $('#app-qr').innerHTML = '';
  $('#app-code').textContent = '';
  $('#app-server').textContent = '';
  $('#app-expire').textContent = '';
  $('#app-new-code').textContent = 'Gerar QR code';
  setAppMsg('');
  $('#app-devices').innerHTML = '<p class="muted">Carregando…</p>';
  $('#app-dialog').showModal();
  loadAppDevices();
  newAppCode();
});
$('#app-new-code').addEventListener('click', newAppCode);
$('#app-close').addEventListener('click', () => $('#app-dialog').close());
$('#app-dialog').addEventListener('close', stopAppTimer);

// ---------------------------------------------------------------- Lista (carregamento progressivo)
const PAGE_SIZE = 100;
// items: produtos já carregados; seq: descarta respostas antigas quando a busca/filtro muda no meio
const list = { items: [], total: 0, loading: false, seq: 0 };

function listUrl(page) {
  const q = $('#search').value.trim();
  const filterParam = state.filter ? `&${state.filter}=1` : '';
  return `/api/admin/products?limit=${PAGE_SIZE}&page=${page}&q=${encodeURIComponent(q)}${filterParam}`;
}

async function loadSummary() {
  const sum = await api('GET', '/api/admin/summary');
  for (const k of ['pending', 'overdue']) {
    $(`#${k}-count`).textContent = sum[k];
    $(`#${k}-count`).classList.toggle('zero', sum[k] === 0);
  }
}

// Recarrega a lista. reset=true (busca/filtro mudou) volta à 1ª página;
// senão recarrega a mesma quantidade de páginas já abertas, sem perder a posição.
async function loadList({ reset = false } = {}) {
  const seq = ++list.seq;
  const pages = reset ? 1 : Math.max(1, Math.ceil(list.items.length / PAGE_SIZE));
  list.loading = true;
  try {
    const [results] = await Promise.all([
      Promise.all(Array.from({ length: pages }, (_, i) => api('GET', listUrl(i + 1)))),
      loadSummary(),
    ]);
    if (seq !== list.seq) return;
    list.items = results.flatMap((r) => r.items);
    list.total = results[0].total;
    if (reset) $('.sidebar').scrollTop = 0;
    renderList();
  } finally {
    if (seq === list.seq) list.loading = false;
  }
}

async function loadMore() {
  if (list.loading || list.items.length >= list.total) return;
  const seq = list.seq;
  list.loading = true;
  try {
    const data = await api('GET', listUrl(Math.floor(list.items.length / PAGE_SIZE) + 1));
    if (seq !== list.seq) return;
    const known = new Set(list.items.map((p) => p.id));
    list.items.push(...data.items.filter((p) => !known.has(p.id)));
    list.total = data.total;
    renderList();
  } finally {
    if (seq === list.seq) list.loading = false;
  }
  // O observador só avisa quando a visibilidade muda; se o fim continua à vista, segue carregando
  requestAnimationFrame(loadMoreIfNearEnd);
}

function loadMoreIfNearEnd() {
  const more = $('#list-more');
  if (more.classList.contains('hidden')) return;
  const sidebarBottom = $('.sidebar').getBoundingClientRect().bottom;
  if (more.getBoundingClientRect().top - sidebarBottom < 300) loadMore();
}

function renderList() {
  updateBulkBar();
  $('#list-count').textContent = list.items.length < list.total
    ? `Mostrando ${list.items.length} de ${list.total} produto(s)`
    : `${list.total} produto(s)`;
  const more = $('#list-more');
  more.classList.toggle('hidden', list.items.length >= list.total);
  $('#list-more-btn').textContent = `Carregar mais (${list.total - list.items.length} restantes)`;
  const ul = $('#product-list');
  ul.innerHTML = '';
  for (const p of list.items) {
    const li = document.createElement('li');
    const order = state.merge ? state.merge.items.findIndex((x) => x.id === p.id) : -1;
    const checked = state.bulk && (state.bulk.all || state.bulk.ids.has(p.id));
    const selecting = state.merge || state.bulk;
    li.className = [
      state.current?.id === p.id && !selecting ? 'selected' : '',
      p.active ? '' : 'inactive',
      selecting ? 'selectable' : '',
      order >= 0 || checked ? 'merge-selected' : '',
    ].join(' ');
    li.innerHTML = `
      ${state.merge ? `<span class="merge-order">${order >= 0 ? order + 1 : ''}</span>` : ''}
      ${state.bulk ? `<span class="merge-order check">${checked ? '✓' : ''}</span>` : ''}
      <div class="thumb">${p.main_image ? `<img src="${p.main_image}" alt="">` : ''}</div>
      <div><div class="name"></div><div class="muted small"></div></div>
      <div class="tags">
        ${p.pending ? '<span class="tag">pendente</span>' : ''}
        ${p.review.data.overdue || p.review.images.overdue ? '<span class="tag danger-tag">vencido</span>' : ''}
      </div>`;
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.small').textContent =
      [p.sku, p.barcodes[0]?.code, `${p.images.filter((i) => !i.placeholder).length} img`].filter(Boolean).join(' · ');
    li.addEventListener('click', () => {
      if (state.merge) toggleMerge(p);
      else if (state.bulk) toggleBulk(p);
      else openProduct(p.id);
    });
    ul.appendChild(li);
  }
}

// Carrega a próxima página ao chegar perto do fim da lista
$('#list-more-btn').addEventListener('click', loadMore);
$('.sidebar').addEventListener('scroll', loadMoreIfNearEnd, { passive: true });
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMore();
}, { root: $('.sidebar'), rootMargin: '300px' }).observe($('#list-more'));

async function loadCategories() {
  // Sugestões dos campos de texto (cadastro, edição em massa, filtros da planilha), pela rota do painel:
  // a pública pode exigir a chave da empresa
  const lists = { categories: 'category', brands: 'brand', manufacturers: 'manufacturer' };
  await Promise.all(Object.entries(lists).map(async ([id, field]) => {
    const values = await api('GET', `/api/admin/field-values/${field}?limit=1000`).catch(() => []);
    $(`#${id}`).innerHTML = values.map((v) => `<option value="${esc(v.value)}">`).join('');
  }));
}
// Filtros da lista: os três primeiros têm aba; os demais vêm dos cards do dashboard e aparecem como etiqueta
const FILTER_LABELS = {
  '': 'Todos', pending: 'Pendentes', overdue: 'Vencidos',
  due_today: 'Vencendo hoje', due_week: 'Vencendo em 7 dias', created_today: 'Novos hoje',
  updated_today: 'Atualizados hoje', no_image: 'Sem foto real', inactive: 'Inativos',
  no_ncm: 'Sem NCM', ncm_unregistered: 'NCM não cadastrado',
};

function setFilter(name) {
  state.filter = name;
  let hasTab = false;
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.filter === name;
    hasTab ||= on;
    b.classList.toggle('active', on);
  });
  $('#filter-chip').classList.toggle('hidden', hasTab);
  $('#filter-name').textContent = FILTER_LABELS[name] || name;
  loadList({ reset: true });
}

document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => setFilter(btn.dataset.filter)));
$('#filter-clear').addEventListener('click', () => setFilter(''));
$('#search').addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadList({ reset: true }), 250);
});

// ---------------------------------------------------------------- Editor
const form = $('#product-form');

function msg(text, kind = 'ok') {
  const el = $('#form-msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
  if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}

function addBarcodeRow(b = {}) {
  const row = $('#barcode-row').content.firstElementChild.cloneNode(true);
  const input = $('.bc-code', row);
  const google = $('.bc-google', row);
  const syncGoogle = () => {
    const code = input.value.trim();
    google.classList.toggle('hidden', !code);
    google.href = googleImagesUrl(code);
  };
  input.addEventListener('input', syncGoogle);
  input.value = b.code || '';
  syncGoogle();
  $('.bc-dates', row).textContent = datesText(b);
  $('.bc-type', row).value = b.code ? b.type : '';
  $('.bc-note', row).value = b.note || '';
  $('.bc-remove', row).addEventListener('click', () => row.remove());
  $('#barcode-rows').appendChild(row);
  return row;
}
$('#add-barcode').addEventListener('click', () => $('.bc-code', addBarcodeRow()).focus());
$('#barcode-rows').addEventListener('input', () => updateTabCounts());
$('#barcode-rows').addEventListener('click', (e) => { if (e.target.closest('.bc-remove')) updateTabCounts(); });

function renderPending(p) {
  $('#pending-banner').classList.toggle('hidden', !p?.pending);
  if (!p?.pending) return;
  const reqs = (p.requests || []).filter((r) => r.status === 'pendente');
  $('#pending-info').textContent = reqs.map((r) =>
    `Código ${r.code} consultado ${r.request_count}x · primeira: ${fmtDate(r.first_requested_at)} · última: ${fmtDate(r.last_requested_at)}` +
    (r.last_source ? ` · origem: ${r.last_source}` : '')).join(' | ');
}

$('#resolve').addEventListener('click', async () => {
  try {
    const p = keepHistory(await api('POST', `/api/admin/products/${state.current.id}/resolve`));
    state.current = p;
    renderPending(p);
    renderRecordDates(p);
    msg('Removido da lista de pendentes.');
    loadList();
  } catch (err) { msg(err.message, 'error'); }
});

// Situação dos prazos de atualização (dados e imagens)
function reviewHtml(label, r) {
  const when = r.updated_at ? fmtDate(r.updated_at) : '—';
  let status;
  if (!r.due_at) status = '<span class="muted">sem prazo</span>';
  else if (r.overdue) status = `<strong class="overdue">vencido desde ${fmtDay(r.due_at)}</strong>`;
  else status = `prazo até ${fmtDay(r.due_at)}`;
  return `<div><strong>${label}</strong> em ${when}</div><div class="small">${status}</div>`;
}

function renderRecordDates(p) {
  $('#record-meta').textContent = p
    ? `Cadastrado em ${fmtDate(p.created_at)} · Última atualização do registro em ${fmtDate(p.updated_at)}`
    : '';
  $('#review-data').classList.toggle('hidden', !p);
  document.querySelectorAll('.fd[data-field]').forEach((el) => {
    el.textContent = p ? datesText(p.field_dates[el.dataset.field]) : '';
  });
  if (!p) return;
  const d = $('#review-data');
  d.className = `review-item ${p.review.data.overdue ? 'is-overdue' : ''}`;
  d.innerHTML = reviewHtml('Dados atualizados', p.review.data) + '<div class="small muted">Salvar o cadastro renova o prazo.</div>';
  const i = $('#review-images');
  i.className = `review-item ${p.review.images.overdue ? 'is-overdue' : ''}`;
  i.innerHTML = reviewHtml('Imagens atualizadas', p.review.images) +
    '<button type="button" id="confirm-images" class="small-btn">Confirmar imagens atuais</button>';
  $('#confirm-images').addEventListener('click', async () => {
    try {
      refreshImages(await api('POST', `/api/admin/products/${p.id}/images/confirm`));
      msg('Imagens confirmadas; prazo renovado.');
      loadList();
    } catch (err) { msg(err.message, 'error'); }
  });
}

// Respostas de alteração não trazem o histórico de consultas; mantém o já carregado
function keepHistory(p) {
  if (p && state.current?.id === p.id) {
    p.requests ??= state.current.requests;
    p.merges ??= state.current.merges;
  }
  return p;
}

// Campos de texto das abas (nome, dados gerais, tributação e medicamento)
const PRODUCT_TEXT_FIELDS = ['name', 'sku', 'brand', 'category', 'unit', 'description', 'manufacturer', 'gross_weight', 'net_weight', 'height', 'width', 'depth', 'pack_qty',
  'ncm', 'cest', 'cfop', 'tax_origin', 'cst_icms', 'icms_rate', 'cst_ipi', 'ipi_rate', 'cst_pis', 'pis_rate', 'cst_cofins', 'cofins_rate', 'tax_notes', ...REFORM_KEYS,
  'anvisa_registry', 'med_type', 'med_stripe', 'med_controlled', 'med_form', 'med_presentation', 'med_therapeutic_class', 'med_notes'];

// Abas do cadastro: a escolhida continua aberta ao passar para o próximo produto
let productTab = 'images';
function showProductTab(tab) {
  productTab = tab;
  document.querySelectorAll('.prod-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.ptab === tab));
  document.querySelectorAll('.prod-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (tab === 'tax') window.renderTaxPreview?.();
}
document.querySelectorAll('.prod-tabs button').forEach((b) => b.addEventListener('click', () => showProductTab(b.dataset.ptab)));

function updateTabCounts() {
  const images = (state.current?.images || []).filter((i) => !i.placeholder).length;
  const codes = [...$('#barcode-rows').children].filter((r) => $('.bc-code', r).value.trim()).length;
  $('#ptab-images-count').textContent = images || '';
  $('#ptab-barcodes-count').textContent = codes || '';
  $('#ptab-medicine-count').textContent = form.elements.is_medicine.checked ? (window.activeCount?.() || '✓') : '';
}

// Alteração só de imagens: atualiza a aba sem apagar o que foi digitado e não salvo nas outras abas
function refreshImages(p) {
  state.current = keepHistory(p);
  renderImages(p);
  renderRecordDates(p);
  renderLinks(p);
  updateTabCounts();
}

function fillForm(p) {
  keepHistory(p);
  state.current = p;
  renderPending(p);
  renderMerges(p);
  renderRecordDates(p);
  $('#settings-form').classList.add('hidden');
  $('#empty').classList.add('hidden');
  form.classList.remove('hidden');
  $('#form-msg').textContent = '';
  $('#form-title').textContent = p ? `#${p.id} · ${p.name}` : 'Novo produto';
  for (const f of PRODUCT_TEXT_FIELDS) form.elements[f].value = p?.[f] ?? '';
  form.elements.active.checked = p ? p.active : true;
  form.elements.is_medicine.checked = !!p?.is_medicine;
  form.elements.tax_class_id.value = p?.tax_class_id ?? '';
  window.syncTaxOverride?.();
  window.setActives?.(p?.actives || []);
  $('#barcode-rows').innerHTML = '';
  (p?.barcodes.length ? p.barcodes : [{}]).forEach(addBarcodeRow);
  $('#delete-product').classList.toggle('hidden', !p);
  $('#images-block').classList.toggle('hidden', !p);
  $('#images-new').classList.toggle('hidden', !!p);
  $('#links-block').classList.toggle('hidden', !p);
  $('#links-new').classList.toggle('hidden', !!p);
  if (p) { renderImages(p); renderLinks(p); }
  // Produto novo ainda não aceita imagens: abre nos códigos de barras
  showProductTab(!p && productTab === 'images' ? 'barcodes' : productTab);
  updateTabCounts();
  document.querySelectorAll('#product-list li').forEach((li) => li.classList.remove('selected'));
}

async function openProduct(id) {
  fillForm(await api('GET', `/api/admin/products/${id}`));
  renderList();
}

$('#new-product').addEventListener('click', () => { fillForm(null); form.elements.name.focus(); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.elements.name.value.trim()) { msg('Informe o nome do produto.', 'error'); form.elements.name.focus(); return; }
  const body = {
    ...Object.fromEntries(PRODUCT_TEXT_FIELDS.map((f) => [f, form.elements[f].value])),
    active: form.elements.active.checked,
    is_medicine: form.elements.is_medicine.checked,
    tax_class_id: form.elements.tax_class_id.value || null,
    dcb: window.getActives?.() || [],
    barcodes: [...$('#barcode-rows').children]
      .map((r) => ({ code: $('.bc-code', r).value.trim(), type: $('.bc-type', r).value.trim(), note: $('.bc-note', r).value.trim() }))
      .filter((b) => b.code),
  };
  try {
    const p = state.current
      ? await api('PUT', `/api/admin/products/${state.current.id}`, body)
      : await api('POST', '/api/admin/products', body);
    const isNew = !state.current;
    fillForm(p);
    msg(isNew ? 'Produto criado. Agora adicione as imagens.' : 'Salvo.');
    loadList();
    loadCategories();
  } catch (err) {
    msg(err.message, 'error');
  }
});

$('#delete-product').addEventListener('click', async () => {
  const p = state.current;
  if (!p || !confirm(`Excluir "${p.name}" com todas as imagens? Isso não pode ser desfeito.`)) return;
  await api('DELETE', `/api/admin/products/${p.id}`);
  state.current = null;
  form.classList.add('hidden');
  $('#empty').classList.remove('hidden');
  loadList();
});

// ---------------------------------------------------------------- Imagens
function renderImages(p) {
  const box = $('#images');
  box.innerHTML = '';
  p.images.forEach((im, idx) => {
    const fig = document.createElement('figure');
    fig.className = idx === 0 ? 'main' : '';
    fig.innerHTML = `
      <a href="${im.url}" target="_blank"><img src="${im.url}" alt=""></a>
      <div class="fd img-date">${im.placeholder ? 'imagem provisória' : `${im.ai_generated ? 'gerada por IA' : 'enviada'} em ${fmtDate(im.created_at)}`}</div>
      <figcaption>
        ${im.ai_generated ? '<span class="badge ai-badge" title="Ilustração gerada por IA, não é foto real">IA</span>' : ''}
        ${im.placeholder ? '<span class="badge muted-badge">Imagem padrão</span>' : idx === 0 ? '<span class="badge">Principal</span>' : '<button type="button" data-act="main" title="Tornar principal">★</button>'}
        <button type="button" data-act="left" title="Mover para a esquerda" ${idx === 0 ? 'disabled' : ''}>◀</button>
        <button type="button" data-act="right" title="Mover para a direita" ${idx === p.images.length - 1 ? 'disabled' : ''}>▶</button>
        <button type="button" data-act="del" class="danger" title="Excluir">✕</button>
      </figcaption>`;
    // A imagem padrão não é do produto: não dá para mover nem excluir
    if (im.placeholder) fig.querySelectorAll('[data-act]').forEach((b) => b.remove());
    fig.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act) imageAction(act, idx);
    });
    box.appendChild(fig);
  });
}

async function imageAction(act, idx) {
  const p = state.current;
  try {
    if (act === 'del') {
      if (!confirm('Excluir esta imagem?')) return;
      refreshImages(await api('DELETE', `/api/admin/images/${p.images[idx].id}`));
    } else {
      const ids = p.images.map((i) => i.id);
      const [moved] = ids.splice(idx, 1);
      const to = act === 'main' ? 0 : act === 'left' ? idx - 1 : idx + 1;
      ids.splice(to, 0, moved);
      refreshImages(await api('PUT', `/api/admin/products/${p.id}/images/order`, { ids }));
    }
    loadList();
  } catch (err) { msg(err.message, 'error'); }
}

async function uploadFiles(files) {
  if (!state.current || !files.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append('images', f));
  msg(`Enviando ${files.length} imagem(ns)...`, 'info');
  try {
    refreshImages(await api('POST', `/api/admin/products/${state.current.id}/images`, fd));
    msg('Imagens enviadas.');
    loadList();
  } catch (err) { msg(err.message, 'error'); }
}

$('#file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
const dz = $('#dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); uploadFiles(e.dataTransfer.files); });

// ---------------------------------------------------------------- Links
function renderLinks(p) {
  const rows = [
    ['Página do produto', p.links.page],
    ['JSON do produto', p.links.api],
    ...p.barcodes.flatMap((b) => [
      [`JSON por código ${b.code}`, b.links.product],
      [`Imagem principal por código ${b.code}`, b.links.main_image],
    ]),
    ...p.images.map((im) => [`Imagem ${im.position}`, im.url]),
  ];
  const box = $('#links');
  box.innerHTML = '';
  for (const [label, url] of rows) {
    const div = document.createElement('div');
    div.className = 'link-row';
    div.innerHTML = `<span class="label"></span><a target="_blank"></a><button type="button">Copiar</button>`;
    div.querySelector('.label').textContent = label;
    const a = div.querySelector('a');
    a.href = url;
    a.textContent = url;
    div.querySelector('button').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(url);
      e.target.textContent = 'Copiado!';
      setTimeout(() => (e.target.textContent = 'Copiar'), 1200);
    });
    box.appendChild(div);
  }
}

// ---------------------------------------------------------------- Mesclagem
function setMergeMode(on) {
  if (on) setBulkMode(false);
  state.merge = on ? { items: [] } : null;
  $('#merge-bar').classList.toggle('hidden', !on);
  $('.list-modes').classList.toggle('hidden', on);
  updateMergeBar();
  renderList();
}

// ---------------------------------------------------------------- Edição em massa
// bulk.ids: selecionados um a um; bulk.all: todos do filtro atual (enviado como filtro ao servidor)
function currentFilterQuery() {
  const q = $('#search').value.trim();
  return { ...(q ? { q } : {}), ...(state.filter ? { [state.filter]: 1 } : {}) };
}

function setBulkMode(on) {
  if (on) setMergeMode(false);
  state.bulk = on ? { ids: new Set(), all: false } : null;
  $('#bulk-bar').classList.toggle('hidden', !on);
  $('.list-modes').classList.toggle('hidden', on);
  updateBulkBar();
  renderList();
}

function bulkCount() {
  return state.bulk ? (state.bulk.all ? list.total : state.bulk.ids.size) : 0;
}

function updateBulkBar() {
  if (!state.bulk) return;
  const n = bulkCount();
  $('#bulk-count').textContent = state.bulk.all ? `Todos os ${fmtN(n)} do filtro` : `${fmtN(n)} selecionado(s)`;
  $('#bulk-go').disabled = n === 0;
  $('#bulk-all').textContent = state.bulk.all ? 'Desmarcar todos' : `Selecionar todos os ${fmtN(list.total)} do filtro atual`;
}

function toggleBulk(p) {
  if (state.bulk.all) { // sai do "todos" e passa a selecionar individualmente os carregados, menos este
    state.bulk.all = false;
    state.bulk.ids = new Set(list.items.map((x) => x.id).filter((id) => id !== p.id));
  } else if (state.bulk.ids.has(p.id)) state.bulk.ids.delete(p.id);
  else state.bulk.ids.add(p.id);
  updateBulkBar();
  renderList();
}

$('#bulk-mode').addEventListener('click', () => setBulkMode(true));
$('#bulk-cancel').addEventListener('click', () => setBulkMode(false));
$('#bulk-all').addEventListener('click', () => {
  state.bulk.all = !state.bulk.all;
  state.bulk.ids.clear();
  updateBulkBar();
  renderList();
});

const bulkForm = $('#bulk-form');
bulkForm.querySelectorAll('[data-enable]').forEach((cb) => cb.addEventListener('change', () => {
  const input = bulkForm.elements[cb.dataset.enable];
  input.disabled = !cb.checked;
  if (cb.checked) input.focus();
}));

$('#bulk-go').addEventListener('click', () => {
  bulkForm.reset();
  bulkForm.querySelectorAll('[data-enable]').forEach((cb) => { bulkForm.elements[cb.dataset.enable].disabled = true; });
  const filterName = FILTER_LABELS[state.filter] || 'Todos';
  const q = $('#search').value.trim();
  $('#bulk-target').textContent = state.bulk.all
    ? `Aplicar a todos os ${fmtN(list.total)} produtos do filtro "${filterName}"${q ? ` com a busca "${q}"` : ''}.`
    : `Aplicar a ${fmtN(state.bulk.ids.size)} produto(s) selecionado(s).`;
  $('#bulk-dialog').showModal();
});

$('#bulk-dialog').addEventListener('close', async () => {
  if ($('#bulk-dialog').returnValue !== 'ok') return;
  const set = {};
  bulkForm.querySelectorAll('[data-enable]').forEach((cb) => { if (cb.checked) set[cb.dataset.enable] = bulkForm.elements[cb.dataset.enable].value; });
  if (bulkForm.elements.active.value !== '') set.active = bulkForm.elements.active.value === '1';
  const body = {
    set,
    actions: { resolve: bulkForm.elements.resolve.checked, confirm_images: bulkForm.elements.confirm_images.checked },
    ...(state.bulk.all ? { filter: currentFilterQuery() } : { ids: [...state.bulk.ids] }),
  };
  try {
    const r = await api('POST', '/api/admin/bulk', body);
    const parts = [`${fmtN(r.products)} produto(s) processado(s)`];
    if (Object.keys(set).length) parts.push(`${fmtN(r.changed)} alterado(s)`);
    if (body.actions.resolve) parts.push(`${fmtN(r.resolved)} saíram dos pendentes`);
    if (body.actions.confirm_images) parts.push(`${fmtN(r.images_confirmed)} imagens confirmadas (${fmtN(r.images_skipped)} ignorados)`);
    alert(parts.join(' · '));
    setBulkMode(false);
    loadList();
    loadCategories();
  } catch (err) { alert(err.message); }
});

function updateMergeBar() {
  const n = state.merge?.items.length || 0;
  $('#merge-go').textContent = `Mesclar (${n})`;
  $('#merge-go').disabled = n < 2;
}

function toggleMerge(p) {
  const sel = state.merge.items;
  const i = sel.findIndex((x) => x.id === p.id);
  if (i >= 0) sel.splice(i, 1); else sel.push(p);
  updateMergeBar();
  renderList();
}

$('#merge-mode').addEventListener('click', () => setMergeMode(true));
$('#merge-cancel').addEventListener('click', () => setMergeMode(false));

$('#merge-go').addEventListener('click', () => {
  const [target, ...sources] = state.merge.items;
  const realImgs = (p) => p.images.filter((i) => !i.placeholder).length;
  $('#merge-summary').innerHTML = `
    <div class="merge-target">
      <div class="small muted">Principal (mantém todos os dados)</div>
      <strong>#${target.id} · ${esc(target.name)}</strong>
      <div class="small">${target.barcodes.length} código(s) · ${realImgs(target)} imagem(ns)</div>
    </div>
    ${sources.map((s) => `
      <div class="merge-source">
        <div class="small muted">Agregar e remover</div>
        <strong>#${s.id} · ${esc(s.name)}</strong>
        <div class="small">+ ${s.barcodes.length} código(s)${s.barcodes.length ? `: ${s.barcodes.map((b) => esc(b.code)).join(', ')}` : ''}
          · + ${realImgs(s)} imagem(ns)${s.images.some((i) => i.placeholder) ? ' (imagem padrão é descartada se houver foto real)' : ''}</div>
      </div>`).join('')}`;
  $('#merge-dialog').showModal();
});

$('#merge-dialog').addEventListener('close', async () => {
  if ($('#merge-dialog').returnValue !== 'ok') return;
  const ids = state.merge.items.map((p) => p.id);
  try {
    const r = await api('POST', '/api/admin/merge', { ids });
    setMergeMode(false);
    fillForm(r.product);
    msg(`${r.merged.length} cadastro(s) mesclado(s) neste item.`);
    loadList();
  } catch (err) {
    alert(err.message);
  }
});

function renderMerges(p) {
  const list = p?.merges || [];
  $('#merges-block').classList.toggle('hidden', !list.length);
  $('#merges').innerHTML = list.map((m) => `
    <li><strong>#${m.source_id} · ${esc(m.name)}</strong>
      <span class="muted small">em ${fmtDate(m.merged_at)}${m.barcodes.length ? ` · códigos: ${m.barcodes.map(esc).join(', ')}` : ''}</span></li>`).join('');
}

// ---------------------------------------------------------------- Parâmetros
const settingsForm = $('#settings-form');

function settingsMsg(text, kind = 'ok') {
  const el = $('#settings-msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
}

$('#open-settings').addEventListener('click', async () => {
  if (location.hash !== '#/produtos') location.hash = '#/produtos';
  const s = await api('GET', '/api/admin/settings');
  for (const [k, v] of Object.entries(s)) if (settingsForm.elements[k]?.type === 'number') settingsForm.elements[k].value = v;
  $('#exigir_chave').checked = !!s.exigir_chave;
  $('#ia_provedor').value = s.ia_provedor || '';
  $('#ia_modelo').value = s.ia_modelo || '';
  $('#ia-default-models').textContent = Object.values(s.ia_provedores || {}).map((p) => `${p.name}: ${p.defaultModel}`).join(' · ');
  renderIaStatus(s.ia_token_set);
  settingsForm.dataset.exigir = String(s.exigir_chave);
  renderCosmosStatus(s.cosmos_token_set);
  renderCnpjaStatus(s.cnpja_token_set);
  $('#default-images').innerHTML = Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `
    <label class="default-image"><input type="radio" name="imagem_padrao" value="${n}" ${s.imagem_padrao === n ? 'checked' : ''}>
      <img src="/padrao/${n}.png" alt="Opção ${n}" loading="lazy"><span class="small">Opção ${n}</span></label>`).join('');
  state.current = null;
  form.classList.add('hidden');
  $('#empty').classList.add('hidden');
  settingsForm.classList.remove('hidden');
  settingsMsg('');
  renderList();
});

$('#close-settings').addEventListener('click', () => {
  settingsForm.classList.add('hidden');
  $('#empty').classList.remove('hidden');
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of settingsForm.querySelectorAll('input[type=number][name]')) body[el.name] = Number(el.value);
  body.exigir_chave = $('#exigir_chave').checked ? 1 : 0;
  body.imagem_padrao = Number(settingsForm.elements.imagem_padrao.value);
  const token = $('#cosmos_token').value.trim();
  if (token) body.cosmos_token = token; // vazio = mantém o atual
  const cnpjaToken = $('#cnpja_token').value.trim();
  if (cnpjaToken) body.cnpja_token = cnpjaToken;
  body.ia_provedor = $('#ia_provedor').value;
  body.ia_modelo = $('#ia_modelo').value.trim();
  const iaToken = $('#ia_token').value.trim();
  if (iaToken) body.ia_token = iaToken;
  if (body.exigir_chave && settingsForm.dataset.exigir !== '1' && !confirm('Com a chave obrigatória, sistemas que consultam a API sem a chave de uma empresa ativa deixam de receber os dados. Confirmar?')) return;
  try {
    const s = await api('PUT', '/api/admin/settings', body);
    $('#cosmos_token').value = '';
    $('#cnpja_token').value = '';
    $('#ia_token').value = '';
    renderIaStatus(s.ia_token_set);
    settingsForm.dataset.exigir = String(s.exigir_chave);
    renderCosmosStatus(s.cosmos_token_set);
    renderCnpjaStatus(s.cnpja_token_set);
    settingsMsg('Parâmetros salvos.');
    loadList();
  } catch (err) { settingsMsg(err.message, 'error'); }
});

function renderCosmosStatus(isSet) {
  $('#cosmos-status').textContent = isSet ? '✔ Token configurado (cole outro para trocar).' : 'Nenhum token configurado.';
  $('#cosmos-remove').classList.toggle('hidden', !isSet);
}

function renderIaStatus(isSet) {
  $('#ia-status').textContent = isSet ? '✔ Chave configurada.' : 'Nenhuma chave configurada.';
  $('#ia-remove').classList.toggle('hidden', !isSet);
}

$('#ia-remove').addEventListener('click', async () => {
  if (!confirm('Remover a chave da API de IA?')) return;
  const s = await api('PUT', '/api/admin/settings', { ia_token: '' });
  renderIaStatus(s.ia_token_set);
  settingsMsg('Chave removida.');
});

function renderCnpjaStatus(isSet) {
  $('#cnpja-status').textContent = isSet ? '✔ Token configurado.' : 'Nenhum token configurado.';
  $('#cnpja-remove').classList.toggle('hidden', !isSet);
}

$('#cnpja-remove').addEventListener('click', async () => {
  if (!confirm('Remover o token do CNPJá?')) return;
  const s = await api('PUT', '/api/admin/settings', { cnpja_token: '' });
  renderCnpjaStatus(s.cnpja_token_set);
  settingsMsg('Token removido.');
});

$('#cosmos-remove').addEventListener('click', async () => {
  if (!confirm('Remover o token da Cosmos?')) return;
  const s = await api('PUT', '/api/admin/settings', { cosmos_token: '' });
  renderCosmosStatus(s.cosmos_token_set);
  settingsMsg('Token removido.');
});

// ---------------------------------------------------------------- Navegação (Dashboard / Produtos)
let dashTimer = null;

// Telas: rota -> permissão exigida; telas de página inteira (sem a lista de produtos) têm a seção indicada
const VIEWS = {
  dashboard: { perm: 'dashboard' },
  // A fila de atualização abre o cadastro completo, e os parâmetros abrem no lugar do editor
  produtos: { perm: ['produtos', 'atualizacao', 'parametros'] },
  atualizar: { perm: 'atualizacao' },
  nomes: { perm: 'produtos', page: '#names', open: () => window.onNamesView?.() },
  valores: { perm: 'produtos', page: '#values', open: () => window.onValuesView?.() },
  dicionario: { perm: 'produtos', page: '#dictionary', open: () => window.onDictionaryView?.() },
  ncm: { perm: 'ncm', page: '#ncm', open: () => window.onNcmView?.() },
  dcb: { perm: 'dcb', page: '#dcb', open: () => window.onDcbView?.() },
  empresas: { perm: 'empresas', page: '#companies', open: () => window.onCompaniesView?.() },
  cobranca: { perm: 'cobranca', page: '#billing', open: () => window.onBillingView?.() },
  usuarios: { perm: 'usuarios', page: '#users', open: () => window.onUsersView?.() },
};

function applyRoute() {
  if (!state.user) return;
  const asked = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'dashboard';
  let view = VIEWS[asked] && can(VIEWS[asked].perm) ? asked : Object.keys(VIEWS).find((v) => can(VIEWS[v].perm));
  const page = view ? VIEWS[view].page : '#no-access';
  $('#app').classList.toggle('view-dashboard', view === 'dashboard');
  $('#app').classList.toggle('view-update', view === 'atualizar');
  $('#app').classList.toggle('view-page', !!page);
  document.querySelectorAll('#app > .page').forEach((s) => s.classList.toggle('hidden', `#${s.id}` !== page));
  document.querySelectorAll('.views a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  clearInterval(dashTimer);
  if (view === 'dashboard') {
    loadDashboard();
    dashTimer = setInterval(() => { if (!document.hidden) loadDashboard(); }, 60000);
  }
  if (view === 'atualizar') window.onUpdateView?.();
  VIEWS[view]?.open?.();
}
window.addEventListener('hashchange', applyRoute);

function goProducts(filter) {
  location.hash = '#/produtos';
  if (filter !== undefined) setFilter(filter);
}

async function goProduct(id) {
  location.hash = '#/produtos';
  await openProduct(id);
}

// ---------------------------------------------------------------- Dashboard
const fmtN = (n) => Number(n || 0).toLocaleString('pt-BR');

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const min = Math.round((Date.now() - new Date(isoStr)) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.round(min / 60)} h`;
  return fmtDay(isoStr);
}

// Conexões: o período fica guardado enquanto a página estiver aberta; ao recarregar volta para 7 dias
const SOURCE_COLUMNS = [
  { key: 'source', label: 'Conexão', firstDir: 'asc' },
  { key: 'hits', label: 'Consultas', num: true, firstDir: 'desc' },
  { key: 'today', label: 'Hoje', num: true, firstDir: 'desc' },
  { key: 'created', label: 'Auto-cad.', num: true, firstDir: 'desc' },
  { key: 'last_at', label: 'Última', firstDir: 'desc' },
];
const dashSources = { items: [], sort: { key: 'hits', dir: 'desc' } };
let dashRequest = 0;

function dashboardQuery() {
  const preset = $('#dash-period').value;
  if (preset !== 'custom') return `dias=${preset}`;
  const params = new URLSearchParams();
  if ($('#dash-from').value) params.set('de', $('#dash-from').value);
  if ($('#dash-to').value) params.set('ate', $('#dash-to').value);
  return params.toString() || 'dias=0';
}

function dashboardPeriodLabel() {
  const preset = $('#dash-period').value;
  if (preset === '1') return 'hoje';
  if (preset === '0') return 'no total';
  return preset === 'custom' ? 'no período' : `em ${preset} dias`;
}

function compareSources(a, b, { key, dir }) {
  const order = key === 'source' ? a.source.localeCompare(b.source, 'pt-BR', { sensitivity: 'base' })
    : key === 'last_at' ? new Date(a.last_at) - new Date(b.last_at)
      : a[key] - b[key];
  return (dir === 'asc' ? order : -order) || a.source.localeCompare(b.source, 'pt-BR');
}

function renderDashSources() {
  const { items, sort } = dashSources;
  if (!items.length) {
    $('#dash-sources').innerHTML = '<p class="muted small">Nenhuma consulta registrada neste período.</p>';
    return;
  }
  const max = Math.max(1, ...items.map((s) => s.hits));
  const rows = [...items].sort((a, b) => compareSources(a, b, sort));
  const head = SOURCE_COLUMNS.map((c) => {
    const active = sort.key === c.key;
    const aria = active ? ` aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th class="sortable ${c.num ? 'num' : ''}"${aria}><button type="button" data-sort="${c.key}">${c.label}${active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
  }).join('');
  $('#dash-sources').innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
    <thead><tr>${head}</tr></thead>
    <tbody>${rows.map((s) => `<tr>
      <td><div class="src-name" title="${esc(s.source)}">${esc(s.source)}</div>
        <div class="bar"><span style="width:${(s.hits / max) * 100}%"></span></div></td>
      <td class="num">${fmtN(s.hits)}</td><td class="num">${fmtN(s.today)}</td><td class="num">${fmtN(s.created)}</td>
      <td class="muted small">${timeAgo(s.last_at)}</td></tr>`).join('')}</tbody></table></div>`;
}

function validDashPeriod() {
  const invalid = $('#dash-period').value === 'custom' && $('#dash-from').value && $('#dash-to').value
    && $('#dash-from').value > $('#dash-to').value;
  $('#dash-period-error').hidden = !invalid;
  $('#dash-period-error').textContent = invalid ? 'A data inicial não pode ser depois da final.' : '';
  return !invalid;
}

async function loadDashboard() {
  if (!validDashPeriod()) return;
  const request = ++dashRequest;
  const periodLabel = dashboardPeriodLabel();
  let d;
  try { d = await api('GET', `/api/admin/dashboard?${dashboardQuery()}`); } catch { return; }
  if (request !== dashRequest) return; // o período mudou enquanto esta resposta vinha
  const P = d.products;
  const L = d.lookups;
  const top = L.top_source;
  const cards = [
    { label: 'Produtos cadastrados', value: fmtN(P.total), sub: `${fmtN(P.active)} ativos · ${fmtN(P.inactive)} inativos`, filter: '' },
    { label: 'Cadastros pendentes', value: fmtN(P.pending), sub: `${fmtN(d.pending_requests)} consultas aguardando atualização`, filter: 'pending', tone: P.pending && 'warn' },
    { label: 'Registros vencidos', value: fmtN(P.overdue), sub: `dados: ${fmtN(P.overdue_data)} · imagens: ${fmtN(P.overdue_images)}`, filter: 'overdue', tone: P.overdue && 'danger' },
    { label: 'Vencendo hoje', value: fmtN(P.due_today), sub: `${fmtN(P.due_week)} nos próximos 7 dias`, filter: 'due_today', tone: P.due_today && 'warn' },
    { label: 'Novos hoje', value: fmtN(P.created_today), sub: 'cadastros criados hoje', filter: 'created_today' },
    { label: 'Atualizados hoje', value: fmtN(P.updated_today), sub: 'cadastros existentes alterados hoje', filter: 'updated_today' },
    { label: 'Conexão mais utilizada', value: top ? esc(top.source) : '—', text: true,
      sub: top ? `${fmtN(top.hits)} consultas ${periodLabel}${periodLabel === 'hoje' ? '' : ` · ${fmtN(top.today)} hoje`}` : 'nenhuma consulta neste período' },
    { label: 'Consultas hoje', value: fmtN(L.today), sub: `${fmtN(L.sources_today)} conexão(ões) hoje · ${fmtN(L.total)} no total` },
    { label: 'Sem foto real', value: fmtN(P.no_image), sub: `${fmtN(d.images.total)} imagens reais no acervo`, filter: 'no_image', tone: P.no_image && 'warn' },
    { label: 'Códigos de barras', value: fmtN(d.barcodes.total), sub: `${d.barcodes.per_product.toLocaleString('pt-BR')} por produto` },
    { label: 'Inativos', value: fmtN(P.inactive), sub: 'fora do catálogo público', filter: 'inactive' },
    { label: 'Mesclagens', value: fmtN(d.merges), sub: 'cadastros unificados' },
  ];
  $('#dash-cards').innerHTML = cards.map((c, i) => {
    const tag = c.filter !== undefined ? 'button' : 'div';
    return `<${tag} class="card ${c.tone || ''} ${c.filter !== undefined ? 'clickable' : ''}" data-i="${i}" ${tag === 'button' ? 'type="button"' : ''}>
      <div class="card-label">${c.label}</div>
      <div class="card-value ${c.text ? 'is-text' : ''}" title="${c.text ? c.value : ''}">${c.value}</div>
      <div class="card-sub">${c.sub}</div>
    </${tag}>`;
  }).join('');
  $('#dash-cards').querySelectorAll('.card.clickable').forEach((el) => {
    el.addEventListener('click', () => goProducts(cards[el.dataset.i].filter));
  });

  if ($('#dash-period').value !== 'custom') {
    $('#dash-from').value = L.period.from || '';
    $('#dash-to').value = L.period.to || '';
  }
  dashSources.items = L.sources;
  renderDashSources();

  $('#dash-pending').innerHTML = d.top_pending.length ? `<ul class="dash-list">${d.top_pending.map((r) => `
    <li data-id="${r.product_id}"><div><code>${esc(r.code)}</code>
      <div class="muted small">${esc(r.last_source || 'origem desconhecida')} · ${timeAgo(r.last_requested_at)}</div></div>
      <span class="num">${fmtN(r.request_count)}×</span></li>`).join('')}</ul>`
    : '<p class="muted small">Nenhum cadastro pendente. 🎉</p>';

  $('#dash-recent').innerHTML = `<ul class="dash-list">${d.recent_updates.map((r) => `
    <li data-id="${r.id}"><div><div class="ellipsis">${esc(r.name)}</div>
      <div class="muted small">${r.updated_at === r.created_at ? 'cadastrado' : 'atualizado'} ${timeAgo(r.updated_at)}</div></div>
      <span class="muted small">#${r.id}</span></li>`).join('')}</ul>`;

  document.querySelectorAll('#dashboard .dash-list li[data-id]').forEach((li) => {
    li.addEventListener('click', () => goProduct(Number(li.dataset.id)));
  });
  $('#dash-updated').textContent = `Atualizado em ${fmtDate(d.generated_at)} · atualiza sozinho a cada minuto`;
}

$('#dash-refresh').addEventListener('click', loadDashboard);
$('#dash-period').addEventListener('change', loadDashboard);
for (const input of [$('#dash-from'), $('#dash-to')]) {
  input.addEventListener('change', () => {
    $('#dash-period').value = 'custom';
    loadDashboard();
  });
}
$('#dash-sources').addEventListener('click', (e) => {
  const key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  const { sort } = dashSources;
  if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
  else Object.assign(sort, { key, dir: SOURCE_COLUMNS.find((c) => c.key === key).firstDir });
  renderDashSources();
  $(`#dash-sources [data-sort="${key}"]`).focus();
});

// ---------------------------------------------------------------- Início
if (state.token) tryLogin(state.token); else showLogin();
