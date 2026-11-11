// Empresas (cadastro por CNPJ), cobrança (planos, consumo e faturas) e usuários/permissões.
// Usa $, api, esc, fmtDate, fmtDay e can de app.js, e setMsg de update.js.
const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brlUnit = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 6 });
const intN = (n) => Number(n || 0).toLocaleString('pt-BR');
const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');
const maskCnpj = (s) => onlyDigits(s).slice(0, 14)
  .replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
  .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
const fmtPeriod = (p) => { const [y, m] = p.split('-'); return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); };
const fmtIsoDay = (d) => (d ? d.split('-').reverse().join('/') : '');
const STATUS_LABEL = { ativa: 'Ativa', suspensa: 'Suspensa', cancelada: 'Cancelada' };

// =================================================================== Empresas
const co = { items: [], current: null, plans: [], timer: null };
const coForm = $('#co-form');

window.onCompaniesView = async () => {
  await loadPlansForSelect();
  loadCompanies();
};

async function loadPlansForSelect() {
  try { co.plans = await api('GET', '/api/admin/plans'); } catch { co.plans = []; }
}

function renderPlanOptions(selected) {
  const opts = co.plans.filter((p) => p.active || p.id === selected);
  $('#co-plan').innerHTML = '<option value="">— sem plano (não fatura) —</option>' + opts.map((p) =>
    `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} · ${brl(p.monthly)}/mês${p.included ? ` · ${intN(p.included)} consultas` : ''}</option>`).join('');
}

async function loadCompanies() {
  const q = $('#co-search').value.trim();
  const status = $('#co-status').value;
  const d = await api('GET', `/api/admin/companies?q=${encodeURIComponent(q)}&status=${status}`);
  co.items = d.items;
  renderCompanyList();
}

function renderCompanyList() {
  $('#co-list').innerHTML = co.items.length ? co.items.map((c) => `
    <li data-id="${c.id}" class="${co.current?.id === c.id ? 'selected' : ''}">
      <div class="co-name">${esc(c.nome_fantasia || c.razao_social)}</div>
      <div class="muted small">${esc(c.cnpj_formatted)}${c.municipio ? ` · ${esc(c.municipio)}/${esc(c.uf)}` : ''}</div>
      <div class="small co-tags">
        <span class="st st-${c.status}">${STATUS_LABEL[c.status]}</span>
        ${c.plan ? `<span>${esc(c.plan.name)}</span>` : '<span class="muted">sem plano</span>'}
        <span class="muted">${intN(c.usage_month)} consultas no mês</span>
        ${c.overdue_invoices ? `<span class="st st-suspensa">${c.overdue_invoices} fatura(s) vencida(s)</span>` : ''}
      </div>
    </li>`).join('') : '<li class="muted small">Nenhuma empresa cadastrada.</li>';
  $('#co-list').querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => openCompany(Number(li.dataset.id))));
}

$('#co-search').addEventListener('input', () => { clearTimeout(co.timer); co.timer = setTimeout(loadCompanies, 250); });
$('#co-status').addEventListener('change', loadCompanies);

function fillCompanyForm(c) {
  coForm.reset();
  for (const el of coForm.elements) {
    if (!el.name || c[el.name] === undefined || c[el.name] === null) continue;
    el.value = el.name === 'cnpj' ? maskCnpj(c.cnpj) : c[el.name];
  }
  renderPlanOptions(c.plan?.id ?? c.plan_id ?? null);
}

function newCompany() {
  co.current = null;
  fillCompanyForm({ due_day: 10, status: 'ativa' });
  $('#co-title').textContent = 'Nova empresa';
  $('#co-meta').textContent = '';
  $('#co-delete').classList.add('hidden');
  $('#co-key').innerHTML = '<p class="muted small">A chave de acesso à API pode ser gerada depois de salvar.</p>';
  $('#co-usage').innerHTML = '';
  $('#co-fetch-msg').textContent = 'Digite o CNPJ: os dados são buscados automaticamente.';
  setMsg('#co-msg', '');
  showCompanyForm();
  $('#co-cnpj').focus();
  renderCompanyList();
}

function showCompanyForm() {
  $('#co-empty').classList.add('hidden');
  coForm.classList.remove('hidden');
}

async function openCompany(id) {
  const c = await api('GET', `/api/admin/companies/${id}`);
  co.current = c;
  fillCompanyForm(c);
  $('#co-title').textContent = c.nome_fantasia || c.razao_social;
  $('#co-meta').textContent = `Empresa #${c.id} · cadastrada em ${fmtDay(c.created_at)}` +
    (c.updated_at !== c.created_at ? ` · alterada em ${fmtDate(c.updated_at)}` : '') +
    (c.data_fetched_at ? ` · dados da Receita de ${fmtDay(c.data_fetched_at)} (${c.data_source})` : '');
  $('#co-delete').classList.remove('hidden');
  $('#co-fetch-msg').textContent = '';
  setMsg('#co-msg', '');
  renderCompanyKey(c);
  renderCompanyUsage(c);
  showCompanyForm();
  renderCompanyList();
}

function renderCompanyKey(c, fullKey) {
  const base = location.origin;
  const example = `${base}/api/v1/barcodes/7891234567895?chave=${fullKey || 'SUA_CHAVE'}`;
  $('#co-key').innerHTML = `
    <h4>Chave de acesso à API</h4>
    ${fullKey ? `<div class="key-new"><strong>Copie e entregue ao cliente agora: a chave não será mostrada de novo.</strong>
        <div class="key-box"><code id="co-key-full">${esc(fullKey)}</code> <button type="button" id="co-key-copy">Copiar</button></div></div>`
      : c.has_api_key ? `<p class="small">Chave configurada: <code>${esc(c.api_key_prefix)}…</code></p>`
      : '<p class="small muted">Sem chave. As consultas desta empresa só são contadas (e cobradas) quando ela usa a chave.</p>'}
    <div class="actions">
      <button type="button" id="co-key-gen">${c.has_api_key ? 'Gerar nova chave (a atual deixa de valer)' : 'Gerar chave'}</button>
      ${c.has_api_key ? '<button type="button" id="co-key-revoke" class="danger">Revogar</button>' : ''}
    </div>
    <p class="muted small">Os sistemas do cliente enviam a chave em <code>?chave=</code> ou no header <code>X-Api-Key</code>, por exemplo:<br>
      <code class="wrap">${esc(example)}</code></p>`;
  $('#co-key-gen').addEventListener('click', async () => {
    if (c.has_api_key && !confirm('Gerar uma nova chave? Os sistemas que usam a chave atual deixarão de funcionar até receberem a nova.')) return;
    const r = await api('POST', `/api/admin/companies/${c.id}/api-key`);
    co.current = { ...co.current, ...r.company };
    renderCompanyKey(co.current, r.api_key);
    loadCompanies();
  });
  $('#co-key-revoke')?.addEventListener('click', async () => {
    if (!confirm('Revogar a chave? Os sistemas desta empresa deixam de ser identificados (e, com a chave obrigatória, deixam de acessar).')) return;
    co.current = { ...co.current, ...(await api('DELETE', `/api/admin/companies/${c.id}/api-key`)) };
    renderCompanyKey(co.current);
    loadCompanies();
  });
  $('#co-key-copy')?.addEventListener('click', () => {
    navigator.clipboard.writeText(fullKey).then(() => { $('#co-key-copy').textContent = 'Copiada ✔'; });
  });
}

function renderCompanyUsage(c) {
  const months = c.usage_months || [];
  const invoices = c.invoices || [];
  $('#co-usage').innerHTML = `
    <h4>Consumo e faturas</h4>
    <p class="small">Este mês: <strong>${intN(c.usage_month)}</strong> consultas · hoje: ${intN(c.usage_today)}</p>
    ${months.length ? `<table class="dash-table"><thead><tr><th>Mês</th><th class="num">Consultas</th><th>Fatura</th></tr></thead><tbody>
      ${months.map((m) => {
        const inv = invoices.find((i) => i.period === m.period);
        return `<tr><td>${fmtPeriod(m.period)}</td><td class="num">${intN(m.hits)}</td>
          <td>${inv ? `${invoiceChip(inv)} ${brl(inv.total)}` : '<span class="muted small">—</span>'}</td></tr>`;
      }).join('')}</tbody></table>` : '<p class="muted small">Nenhum consumo registrado.</p>'}`;
}

let cnpjTimer = null;
$('#co-cnpj').addEventListener('input', (e) => {
  const pos = e.target.value.length;
  e.target.value = maskCnpj(e.target.value);
  clearTimeout(cnpjTimer);
  // Busca automática ao completar os 14 dígitos (só no cadastro novo ou se o CNPJ mudou)
  if (onlyDigits(e.target.value).length === 14 && onlyDigits(e.target.value) !== co.current?.cnpj && pos) {
    cnpjTimer = setTimeout(fetchCnpj, 300);
  }
});
$('#co-fetch').addEventListener('click', fetchCnpj);

// Dígitos verificadores do CNPJ (mesma regra do servidor)
function validCnpj(c) {
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (len) => {
    let sum = 0; let w = len - 7;
    for (let i = 0; i < len; i++) { sum += Number(c[i]) * w--; if (w < 2) w = 9; }
    const r = sum % 11; return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

async function fetchCnpj() {
  const c = onlyDigits($('#co-cnpj').value);
  const msg = $('#co-fetch-msg');
  if (!validCnpj(c)) { msg.textContent = 'CNPJ inválido: confira os dígitos.'; msg.className = 'small error'; return; }
  msg.className = 'muted small';
  msg.textContent = 'Consultando a Receita Federal…';
  $('#co-fetch').disabled = true;
  try {
    const r = await api('GET', `/api/admin/cnpj/${c}`);
    if (r.existing && r.existing.id !== co.current?.id) {
      msg.innerHTML = `Este CNPJ já está cadastrado: <a href="#" id="co-go-existing">${esc(r.existing.razao_social)} (#${r.existing.id})</a>.`;
      $('#co-go-existing').addEventListener('click', (e) => { e.preventDefault(); openCompany(r.existing.id); });
      return;
    }
    const d = r.data;
    const set = (name, v) => { if (coForm.elements[name] && v !== undefined && v !== null && v !== '') coForm.elements[name].value = v; };
    for (const k of ['razao_social', 'nome_fantasia', 'situacao', 'abertura', 'natureza_juridica', 'porte', 'cnae',
      'logradouro', 'numero', 'complemento', 'bairro', 'municipio', 'uf', 'cep', 'telefone', 'email']) set(k, d[k]);
    // Inscrição estadual (só vem com o token CNPJá): prefere a da UF do endereço e ativa
    const ie = d.inscricoes.find((i) => i.uf === d.uf && i.ativa) || d.inscricoes.find((i) => i.ativa) || d.inscricoes[0];
    if (ie) { set('inscricao_estadual', ie.numero); set('ie_situacao', [ie.situacao, ie.uf].filter(Boolean).join(' · ')); }
    coForm.dataset.source = r.source_name;
    coForm.dataset.fetched = '1';
    msg.className = 'small ok';
    msg.textContent = `Dados preenchidos por ${r.source_name}. ` + (ie ? 'Inscrição estadual encontrada.'
      : 'A inscrição estadual não vem nas bases gratuitas: confira no Sintegra do estado e preencha.');
    if (d.situacao && d.situacao !== 'ATIVA') { msg.className = 'small error'; msg.textContent += ` Atenção: situação na Receita "${d.situacao}".`; }
    if (!co.current && !coForm.elements.contato_email.value && d.email) coForm.elements.contato_email.value = d.email;
  } catch (err) {
    msg.className = 'small error';
    msg.textContent = `${err.message}. Você pode preencher os dados à mão.`;
  } finally {
    $('#co-fetch').disabled = false;
  }
}

$('#co-new').addEventListener('click', newCompany);

coForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of coForm.elements) if (el.name) body[el.name] = el.value;
  body.cnpj = onlyDigits(body.cnpj);
  body.plan_id = body.plan_id ? Number(body.plan_id) : null;
  body.due_day = Number(body.due_day);
  if (coForm.dataset.fetched === '1') { body.data_source = coForm.dataset.source; body.data_fetched = true; }
  try {
    const saved = co.current
      ? await api('PUT', `/api/admin/companies/${co.current.id}`, body)
      : await api('POST', '/api/admin/companies', body);
    delete coForm.dataset.fetched;
    await openCompany(saved.id);
    setMsg('#co-msg', 'Empresa salva.');
    loadCompanies();
  } catch (err) { setMsg('#co-msg', err.message, 'error'); }
});

$('#co-delete').addEventListener('click', async () => {
  if (!co.current || !confirm(`Excluir a empresa ${co.current.razao_social}?`)) return;
  try {
    await api('DELETE', `/api/admin/companies/${co.current.id}`);
    co.current = null;
    coForm.classList.add('hidden');
    $('#co-empty').classList.remove('hidden');
    loadCompanies();
  } catch (err) { setMsg('#co-msg', err.message, 'error'); }
});

// =================================================================== Cobrança
const bi = { data: null, plans: [] };
const thisMonth = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

window.onBillingView = () => {
  if (!$('#bi-period').value) $('#bi-period').value = thisMonth();
  loadBilling();
  loadPlans();
};

$('#bi-period').addEventListener('change', loadBilling);

function invoiceChip(inv) {
  if (inv.status === 'paga') return '<span class="st st-ativa">paga</span>';
  if (inv.status === 'cancelada') return '<span class="st st-cancelada">cancelada</span>';
  return inv.overdue ? '<span class="st st-suspensa">vencida</span>' : '<span class="st st-aberta">aberta</span>';
}

async function loadBilling() {
  const period = $('#bi-period').value || thisMonth();
  const d = await api('GET', `/api/admin/billing?period=${period}`);
  bi.data = d;
  const T = d.totals;
  const cards = [
    { label: `Consultas em ${fmtPeriod(d.period)}`, value: intN(T.usage), sub: 'com chave de empresa' },
    { label: d.current ? 'Estimativa do mês (parcial)' : 'A faturar', value: brl(T.estimate), sub: 'empresas com plano ainda sem fatura' },
    { label: 'Faturado no mês', value: brl(T.invoiced), sub: `${brl(T.paid)} recebido · ${brl(T.open)} em aberto` },
    { label: 'Faturas vencidas (todas)', value: intN(d.overdue.n), sub: brl(d.overdue.total), tone: d.overdue.n ? 'danger' : '' },
  ];
  $('#bi-cards').innerHTML = cards.map((c) => `<div class="card ${c.tone || ''}"><div class="card-label">${c.label}</div>
    <div class="card-value">${c.value}</div><div class="card-sub">${c.sub}</div></div>`).join('');
  $('#bi-generate').textContent = d.current ? 'Gerar faturas do mês (parcial)' : 'Gerar faturas do mês';

  $('#bi-rows').innerHTML = d.items.length ? d.items.map((i, idx) => {
    const e = i.estimate;
    const inv = i.invoice;
    const shown = inv || e;
    return `<tr>
      <td><a href="#/empresas" data-co="${i.company.id}">${esc(i.company.name)}</a>
        <div class="muted small">${esc(i.company.cnpj_formatted)}${i.company.status !== 'ativa' ? ` · ${STATUS_LABEL[i.company.status]}` : ''}${!i.company.has_api_key ? ' · sem chave' : ''}</div></td>
      <td>${i.plan ? esc(inv?.plan_name || i.plan.name) : '<span class="muted small">sem plano</span>'}</td>
      <td class="num">${intN(shown.usage)}${shown.included ? `<div class="muted small">de ${intN(shown.included)} incl.</div>` : ''}</td>
      <td class="num">${shown.extra_usage ? `${intN(shown.extra_usage)}<div class="muted small">${brl(shown.extra_amount)}</div>` : '—'}</td>
      <td class="num"><strong>${i.plan || inv ? brl(shown.total) : '—'}</strong>${inv?.discount ? `<div class="muted small">desc. ${brl(inv.discount)}</div>` : ''}</td>
      <td>${inv ? `${invoiceChip(inv)}<div class="muted small">vence ${fmtIsoDay(inv.due_date)}</div>` : '<span class="muted small">não gerada</span>'}</td>
      <td>${inv ? `<button type="button" data-inv="${inv.id}">Abrir</button>`
        : i.plan && i.company.status === 'ativa' ? `<button type="button" data-gen="${idx}">Gerar</button>` : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="muted small">Nenhuma empresa cadastrada.</td></tr>';

  $('#bi-rows').querySelectorAll('[data-co]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    location.hash = '#/empresas';
    openCompany(Number(a.dataset.co));
  }));
  $('#bi-rows').querySelectorAll('[data-inv]').forEach((b) => b.addEventListener('click', () => openInvoice(Number(b.dataset.inv))));
  $('#bi-rows').querySelectorAll('[data-gen]').forEach((b) => b.addEventListener('click', () => generateInvoices([d.items[b.dataset.gen].company.id])));
}

async function generateInvoices(companyIds) {
  const period = $('#bi-period').value || thisMonth();
  const partial = period === thisMonth();
  if (!companyIds && !confirm(`Gerar as faturas de ${fmtPeriod(period)} para todas as empresas ativas com plano?` +
    (partial ? '\n\nO mês ainda não terminou: o consumo será o registrado até agora (dá para recalcular depois enquanto a fatura estiver aberta).' : ''))) return;
  try {
    let r = await api('POST', '/api/admin/invoices/generate', { period, company_ids: companyIds });
    if (!companyIds && r.skipped && confirm(`${r.skipped} empresa(s) já tinham fatura neste mês. Recalcular as que ainda estão abertas com o consumo atual?`)) {
      const r2 = await api('POST', '/api/admin/invoices/generate', { period, recalcular: true });
      r = { ...r, updated: r2.updated };
    }
    setMsg('#bi-msg', `Faturas: ${r.created} criada(s)` + (r.updated ? `, ${r.updated} recalculada(s)` : '') +
      (r.without_plan ? ` · ${r.without_plan} empresa(s) ativa(s) sem plano não foram faturadas` : '') + '.');
    loadBilling();
  } catch (err) { setMsg('#bi-msg', err.message, 'error'); }
}
$('#bi-generate').addEventListener('click', () => generateInvoices());

// ---- Fatura
let currentInvoice = null;

async function openInvoice(id) {
  const inv = await api('GET', `/api/admin/invoices/${id}`);
  currentInvoice = inv;
  $('#invoice-title').textContent = `Fatura ${fmtPeriod(inv.period)} · ${inv.nome_fantasia || inv.razao_social}`;
  $('#invoice-body').innerHTML = invoiceDetail(inv);
  const f = $('#invoice-form').elements;
  f.discount.value = inv.discount ? String(inv.discount).replace('.', ',') : '';
  f.notes.value = inv.notes || '';
  $('#invoice-pay').classList.toggle('hidden', inv.status !== 'aberta');
  $('#invoice-cancel').classList.toggle('hidden', inv.status !== 'aberta');
  $('#invoice-reopen').classList.toggle('hidden', inv.status === 'aberta');
  $('#invoice-save').classList.toggle('hidden', inv.status !== 'aberta');
  f.discount.disabled = inv.status !== 'aberta';
  setMsg('#invoice-msg', '');
  $('#invoice-dialog').showModal();
}

function invoiceDetail(inv) {
  return `<table class="dash-table inv-detail">
    <tr><td>Situação</td><td>${invoiceChip(inv)}${inv.paid_at ? ` em ${fmtDay(inv.paid_at)}` : ''}</td></tr>
    <tr><td>CNPJ</td><td>${esc(inv.cnpj_formatted)}</td></tr>
    <tr><td>Plano</td><td>${esc(inv.plan_name)}</td></tr>
    <tr><td>Mensalidade</td><td class="num">${brl(inv.monthly)}</td></tr>
    <tr><td>Consultas no mês</td><td class="num">${intN(inv.usage)} (incluídas: ${intN(inv.included)})</td></tr>
    <tr><td>Excedente</td><td class="num">${intN(inv.extra_usage)} × ${brlUnit(inv.extra_price)} = ${brl(inv.extra_amount)}</td></tr>
    ${inv.discount ? `<tr><td>Desconto</td><td class="num">− ${brl(inv.discount)}</td></tr>` : ''}
    <tr><td><strong>Total</strong></td><td class="num"><strong>${brl(inv.total)}</strong></td></tr>
    <tr><td>Vencimento</td><td>${fmtIsoDay(inv.due_date)}</td></tr>
  </table>`;
}

async function updateInvoice(body, okText) {
  try {
    await api('PUT', `/api/admin/invoices/${currentInvoice.id}`, body);
    await openInvoice(currentInvoice.id);
    setMsg('#invoice-msg', okText);
    loadBilling();
  } catch (err) { setMsg('#invoice-msg', err.message, 'error'); }
}

const invoiceEdits = () => {
  const f = $('#invoice-form').elements;
  return { discount: f.discount.value.trim() || 0, notes: f.notes.value };
};
$('#invoice-save').addEventListener('click', () => updateInvoice(invoiceEdits(), 'Fatura salva.'));
$('#invoice-pay').addEventListener('click', () => updateInvoice({ ...invoiceEdits(), status: 'paga' }, 'Pagamento registrado.'));
$('#invoice-reopen').addEventListener('click', () => {
  if (confirm('Reabrir a fatura? (estorna o pagamento ou o cancelamento)')) updateInvoice({ status: 'aberta' }, 'Fatura reaberta.');
});
$('#invoice-cancel').addEventListener('click', () => {
  if (confirm('Cancelar esta fatura?')) updateInvoice({ status: 'cancelada', notes: $('#invoice-form').elements.notes.value }, 'Fatura cancelada.');
});

// Demonstrativo para imprimir ou salvar em PDF
$('#invoice-print').addEventListener('click', () => {
  const inv = currentInvoice;
  const addr = [inv.logradouro, inv.numero, inv.complemento, inv.bairro].filter(Boolean).join(', ');
  const city = [inv.municipio, inv.uf].filter(Boolean).join('/') + (inv.cep ? ` · CEP ${inv.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2')}` : '');
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fatura ${esc(inv.period)} - ${esc(inv.razao_social)}</title>
    <style>body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:720px;margin:32px auto;padding:0 16px}
    h1{font-size:20px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:16px}
    td{padding:8px 4px;border-top:1px solid #ddd}td.num{text-align:right}.muted{color:#666}</style></head><body>
    <h1>Demonstrativo de uso — ${esc(fmtPeriod(inv.period))}</h1>
    <div class="muted">Repositório de Produtos · fatura nº ${inv.id}</div>
    <p><strong>${esc(inv.razao_social)}</strong><br>CNPJ ${esc(inv.cnpj_formatted)}<br>${esc(addr)}<br>${esc(city)}</p>
    ${invoiceDetail(inv).replace(/<span class="st[^"]*">/g, '<span>')}
    ${inv.notes ? `<p><strong>Observações:</strong> ${esc(inv.notes)}</p>` : ''}
    <script>print()<\/script></body></html>`);
  w.document.close();
});

// ---- Planos
async function loadPlans() {
  bi.plans = await api('GET', '/api/admin/plans');
  $('#pl-rows').innerHTML = bi.plans.length ? bi.plans.map((p) => `<tr class="${p.active ? '' : 'muted'}">
    <td>${esc(p.name)}${p.active ? '' : ' <span class="small">(inativo)</span>'}</td>
    <td class="num">${brl(p.monthly)}</td><td class="num">${intN(p.included)}</td>
    <td class="num">${p.extra_price ? brlUnit(p.extra_price) : '—'}</td><td class="num">${intN(p.companies)}</td>
    <td><button type="button" data-plan="${p.id}">Editar</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="muted small">Nenhum plano. Crie um plano para poder faturar as empresas.</td></tr>';
  $('#pl-rows').querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => openPlan(bi.plans.find((p) => p.id === Number(b.dataset.plan)))));
}

let currentPlan = null;
function openPlan(p) {
  currentPlan = p || null;
  const f = $('#plan-form');
  f.reset();
  $('#plan-dialog-title').textContent = p ? `Plano ${p.name}` : 'Novo plano';
  if (p) {
    f.elements.name.value = p.name;
    f.elements.monthly.value = String(p.monthly).replace('.', ',');
    f.elements.included.value = p.included;
    f.elements.extra_price.value = String(p.extra_price).replace('.', ',');
    f.elements.active.checked = p.active;
  }
  $('#plan-delete').classList.toggle('hidden', !p);
  setMsg('#plan-msg', '');
  $('#plan-dialog').showModal();
}
$('#pl-new').addEventListener('click', () => openPlan());

$('#plan-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target.elements;
  const body = { name: f.name.value, monthly: f.monthly.value || 0, included: Number(f.included.value || 0), extra_price: f.extra_price.value || 0, active: f.active.checked };
  try {
    if (currentPlan) await api('PUT', `/api/admin/plans/${currentPlan.id}`, body);
    else await api('POST', '/api/admin/plans', body);
    $('#plan-dialog').close();
    loadPlans();
    loadBilling();
  } catch (err) { setMsg('#plan-msg', err.message, 'error'); }
});

$('#plan-delete').addEventListener('click', async () => {
  if (!confirm(`Excluir o plano ${currentPlan.name}?`)) return;
  try {
    await api('DELETE', `/api/admin/plans/${currentPlan.id}`);
    $('#plan-dialog').close();
    loadPlans();
  } catch (err) { setMsg('#plan-msg', err.message, 'error'); }
});

// =================================================================== Usuários
const us = { items: [], modules: {}, current: null };

window.onUsersView = loadUsers;

async function loadUsers() {
  const d = await api('GET', '/api/admin/users');
  us.items = d.items;
  us.modules = d.modules;
  $('#us-rows').innerHTML = us.items.length ? us.items.map((u) => `<tr class="${u.active ? '' : 'muted'}">
    <td>${esc(u.name)}${u.active ? '' : ' <span class="small">(inativo)</span>'}${state.user?.id === u.id ? ' <span class="small muted">(você)</span>' : ''}</td>
    <td><code>${esc(u.login)}</code></td>
    <td class="small">${u.is_admin ? '<strong>Administrador</strong>' : u.permissions.map((p) => esc(us.modules[p]?.split(' (')[0] || p)).join(', ') || '<span class="muted">nenhuma</span>'}</td>
    <td class="small muted">${u.last_login_at ? fmtDate(u.last_login_at) : 'nunca'}</td>
    <td><button type="button" data-user="${u.id}">Editar</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="muted small">Nenhum usuário. Crie o primeiro (marque "Administrador" para acesso total).</td></tr>';
  $('#us-rows').querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', () => openUser(us.items.find((u) => u.id === Number(b.dataset.user)))));
}

function openUser(u) {
  us.current = u || null;
  const f = $('#user-form');
  f.reset();
  $('#user-dialog-title').textContent = u ? `Usuário ${u.name}` : 'Novo usuário';
  $('#user-pass-hint').textContent = u ? '(deixe vazio para manter)' : '(mínimo 8 caracteres)';
  f.elements.password.required = !u;
  $('#user-perms').innerHTML = '<legend>Módulos liberados</legend>' + Object.entries(us.modules).map(([k, label]) =>
    `<label class="check"><input type="checkbox" value="${k}" ${u?.permissions.includes(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
  if (u) {
    f.elements.name.value = u.name;
    f.elements.login.value = u.login;
    f.elements.is_admin.checked = u.is_admin;
    f.elements.active.checked = u.active;
  }
  syncAdminPerms();
  setMsg('#user-msg', '');
  $('#user-dialog').showModal();
}

function syncAdminPerms() {
  const admin = $('#user-form').elements.is_admin.checked;
  $('#user-perms').querySelectorAll('input').forEach((i) => { i.disabled = admin; if (admin) i.checked = true; });
}
$('#user-form').elements.is_admin.addEventListener('change', syncAdminPerms);
$('#us-new').addEventListener('click', () => openUser());

$('#user-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    name: f.name.value, login: f.login.value, is_admin: f.is_admin.checked, active: f.active.checked,
    permissions: [...$('#user-perms').querySelectorAll('input:checked')].map((i) => i.value),
  };
  if (f.password.value) body.password = f.password.value;
  try {
    if (us.current) await api('PUT', `/api/admin/users/${us.current.id}`, body);
    else await api('POST', '/api/admin/users', body);
    $('#user-dialog').close();
    setMsg('#us-msg', 'Usuário salvo.');
    loadUsers();
  } catch (err) { setMsg('#user-msg', err.message, 'error'); }
});
