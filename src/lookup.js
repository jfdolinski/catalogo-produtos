// Busca de dados de produto em bases externas pelo código de barras.
// Cosmos (Bluesoft) exige token; as bases "Open ... Facts" são públicas.
const UA = 'RepositorioProdutos/1.0 (catalogo de imagens de produtos)';
const TIMEOUT_MS = 8000;

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status === 404) return null;
  // Mensagem da própria API (ex.: Cosmos informa a franquia excedida), resumida
  const detail = async () => {
    const t = (await r.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    try { const j = JSON.parse(t); return String(j.message || j.error || j.errors || '').slice(0, 400); } catch { return t.slice(0, 400); }
  };
  if (r.status === 429) {
    const d = await detail();
    throw Object.assign(new Error(`limite de consultas atingido${d ? `: ${d}` : ''}`), { rateLimited: true });
  }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`token inválido ou sem permissão (HTTP ${r.status})`), { unauthorized: true });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function openFacts(name, host) {
  return {
    id: host.split('.')[1],
    name,
    async find(code) {
      const fields = 'product_name,product_name_pt,generic_name,generic_name_pt,brands,categories,quantity,image_front_url,image_url';
      const j = await getJson(`https://${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
      if (!j || j.status !== 1 || !j.product) return null;
      const p = j.product;
      const title = clean(p.product_name_pt || p.product_name);
      if (!title) return null;
      const qty = clean(p.quantity);
      const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
      return {
        name: qty && !squash(title).includes(squash(qty)) ? `${title} ${qty}` : title,
        brand: clean(String(p.brands || '').split(',')[0]),
        category: clean(String(p.categories || '').split(',').pop()),
        description: clean(p.generic_name_pt || p.generic_name),
        unit: '',
        images: [p.image_front_url || p.image_url].filter(Boolean),
      };
    },
  };
}

function cosmos(token) {
  return {
    id: 'cosmos',
    name: 'Cosmos (Bluesoft)',
    async find(code) {
      // https://cosmos.bluesoft.com.br/api — exige X-Cosmos-Token e User-Agent "Cosmos-API-Request"
      const j = await getJson(`https://cosmos.bluesoft.com.br/api/gtins/${encodeURIComponent(code)}.json`, {
        'X-Cosmos-Token': token, 'User-Agent': 'Cosmos-API-Request', 'Content-Type': 'application/json',
      });
      if (!j || !j.description) return null;
      return {
        name: clean(j.description),
        brand: clean(j.brand?.name),
        category: clean(j.gpc?.description),
        description: '', // a Cosmos não tem descrição do produto (o texto do NCM é fiscal)
        unit: '',
        images: [j.thumbnail].filter(Boolean),
      };
    },
  };
}

export function providers({ cosmosToken } = {}) {
  const list = [];
  if (cosmosToken) list.push(cosmos(cosmosToken));
  list.push(
    openFacts('Open Food Facts', 'world.openfoodfacts.org'),
    openFacts('Open Beauty Facts', 'world.openbeautyfacts.org'),
    openFacts('Open Products Facts', 'world.openproductsfacts.org'),
  );
  return list;
}

// Consulta uma base: { source, source_name, ...dados } | { ..., not_found: true } | { ..., error, rateLimited?, unauthorized? }
// (o cache das respostas fica no servidor, em lookup_cache)
export async function lookupOne(provider, code) {
  const base = { source: provider.id, source_name: provider.name };
  try {
    const data = await provider.find(code);
    return data ? { ...base, ...data } : { ...base, not_found: true };
  } catch (e) {
    return { ...base, error: e.name === 'TimeoutError' ? 'tempo esgotado' : e.message, rateLimited: !!e.rateLimited, unauthorized: !!e.unauthorized };
  }
}
