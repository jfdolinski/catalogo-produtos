// Geração de imagem ilustrativa do produto por IA (OpenAI ou Google Gemini).
// A IA não reconhece o produto pelos dígitos do código de barras: o código identifica o produto
// (cadastro ou bases externas) e a imagem é gerada a partir do nome, marca, tamanho e categoria.
const TIMEOUT_MS = 120000;
// Endereços das APIs (podem ser trocados por variável de ambiente, ex.: proxy da empresa)
const OPENAI_URL = process.env.IA_OPENAI_URL || 'https://api.openai.com/v1/images/generations';
const GEMINI_URL = process.env.IA_GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/models';

export const AI_PROVIDERS = {
  openai: { name: 'OpenAI', defaultModel: 'gpt-image-1-mini' },
  gemini: { name: 'Google Gemini', defaultModel: 'gemini-2.5-flash-image' },
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function buildPrompt({ name, brand, unit, category, description }) {
  const facts = [
    `Product: ${clean(name)}`,
    brand && `Brand: ${clean(brand)}`,
    unit && `Size/unit: ${clean(unit)}`,
    category && `Category: ${clean(category)}`,
    description && `Details: ${clean(description).slice(0, 300)}`,
  ].filter(Boolean).join('\n');
  return `Professional e-commerce catalog photo of a single retail product sold in Brazil.
${facts}
Show the product packaging from the front, centered, filling most of the frame, on a pure white background,
soft studio lighting, realistic photographic style. Packaging text may be in Portuguese.
Do not add people, hands, props, extra products, watermarks or captions.`;
}

class AiError extends Error {
  constructor(message, { unauthorized = false, rateLimited = false } = {}) {
    super(message);
    this.unauthorized = unauthorized;
    this.rateLimited = rateLimited;
  }
}

async function post(url, headers, body) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new AiError(e.name === 'TimeoutError' ? 'a IA demorou demais para responder' : `falha de conexão (${e.message})`);
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* resposta não JSON */ }
  if (!r.ok) {
    const msg = String(j?.error?.message || text || `HTTP ${r.status}`).replace(/\s+/g, ' ').slice(0, 300);
    // O Gemini responde 400 (e não 401) para chave inválida
    const unauthorized = r.status === 401 || r.status === 403 || (r.status === 400 && /api key/i.test(msg));
    throw new AiError(`${unauthorized ? 'chave inválida ou sem permissão' : r.status === 429 ? 'limite ou créditos da conta esgotados' : `HTTP ${r.status}`}: ${msg}`,
      { unauthorized, rateLimited: r.status === 429 });
  }
  return j;
}

async function generateOpenAI(prompt, { token, model }) {
  const j = await post(OPENAI_URL, { Authorization: `Bearer ${token}` },
    { model, prompt, n: 1, size: '1024x1024', quality: 'medium' });
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new AiError('a OpenAI não devolveu imagem');
  return { buffer: Buffer.from(b64, 'base64'), mime: 'image/png' };
}

async function generateGemini(prompt, { token, model }) {
  const j = await post(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': token },
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } });
  const part = j?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) {
    const reason = j?.promptFeedback?.blockReason || j?.candidates?.[0]?.finishReason;
    throw new AiError(`o Gemini não devolveu imagem${reason ? ` (${reason})` : ''}`);
  }
  return { buffer: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType || 'image/png' };
}

// Gera a imagem. config: { provider, model, token }. Retorna { buffer, mime, prompt, provider, model }.
export async function generateProductImage(product, config) {
  const provider = AI_PROVIDERS[config.provider];
  if (!provider) throw new AiError('Geração por IA não configurada (escolha o provedor em Parâmetros)');
  if (!config.token) throw new AiError('Informe a chave da API de IA em Parâmetros');
  const model = config.model || provider.defaultModel;
  const prompt = buildPrompt(product);
  const img = config.provider === 'openai' ? await generateOpenAI(prompt, { ...config, model }) : await generateGemini(prompt, { ...config, model });
  if (img.buffer.length < 1000) throw new AiError('a imagem gerada veio vazia');
  return { ...img, prompt, provider: config.provider, model };
}
