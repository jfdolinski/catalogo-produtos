// Regras puras (sem React Native): testadas com Node em regras.test.ts.

export interface DadosVinculo {
  servidor: string;
  codigo: string;
}

/** Endereço do catálogo: só https (http só em teste), sem usuário/senha na URL. Devolve a origem limpa. */
export function servidorValido(endereco: string, aceitarHttp = false): string | null {
  let u: URL;
  try {
    u = new URL(endereco.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && !(aceitarHttp && u.protocol === 'http:')) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

/** Código de vínculo do painel: 10 letras e números; aceita espaços, hífen e minúsculas. */
export function codigoValido(codigo: string): string | null {
  const limpo = codigo.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{10}$/.test(limpo) ? limpo : null;
}

/** Lê catalogo://vincular?servidor=...&codigo=... do QR code. Qualquer outra coisa é null. */
export function lerQrDeVinculo(texto: string, aceitarHttp = false): DadosVinculo | null {
  const m = /^catalogo:\/\/vincular\?(.+)$/.exec(texto.trim());
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const servidor = servidorValido(p.get('servidor') ?? '', aceitarHttp);
  const codigo = codigoValido(p.get('codigo') ?? '');
  return servidor && codigo ? { servidor, codigo } : null;
}

/**
 * Código de barras lido ou digitado: só dígitos, de 8 a 14 (EAN-8, UPC-A, EAN-13, DUN-14).
 * O leitor às vezes entrega espaços ou o texto de um QR; isso vira null com a mensagem de erro.
 */
export function codigoDeBarras(texto: string): { codigo: string } | { erro: string } {
  const limpo = texto.replace(/[\s.-]/g, '');
  if (!limpo) return { erro: 'Informe o código de barras.' };
  if (!/^\d+$/.test(limpo)) return { erro: 'O código de barras tem só números.' };
  if (limpo.length < 8 || limpo.length > 14) return { erro: 'O código de barras tem de 8 a 14 números.' };
  return { codigo: limpo };
}

/** Dígito verificador GTIN (EAN/UPC). Leitura pela câmera já vem conferida; o digitado pode ter erro. */
export function gtinValido(codigo: string): boolean {
  if (![8, 12, 13, 14].includes(codigo.length) || !/^\d+$/.test(codigo)) return false;
  const d = codigo.split('').map(Number);
  const dv = d.pop()!;
  const soma = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === dv;
}

export interface Sugestao {
  source: string;
  source_name: string;
  name?: string;
  brand?: string;
  category?: string;
  unit?: string;
  images?: string[];
  skipped?: boolean;
  error?: string;
}

/** Sugestões das bases públicas que trazem nome, sem repetir o mesmo nome+marca. */
export function sugestoesUteis(resultados: Sugestao[]): Sugestao[] {
  const vistos = new Set<string>();
  return resultados.filter((r) => {
    if (!r.name) return false;
    const chave = `${r.name} ${r.brand ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

/** Nova ordem das fotos com `id` em primeiro lugar (vira a foto principal). */
export function comoPrincipal(ids: number[], id: number): number[] {
  return ids.includes(id) ? [id, ...ids.filter((x) => x !== id)] : ids;
}

/** "1.2.10" é mais nova que "1.2.9"; formato estranho nunca é mais nova. */
export function versaoMaisNova(candidata: string, atual: string): boolean {
  const partes = (v: string) => v.trim().split('.').map(Number);
  const a = partes(candidata);
  const b = partes(atual);
  if ([...a, ...b].some((n) => !Number.isInteger(n) || n < 0)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
