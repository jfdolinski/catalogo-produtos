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

// ---- Ajustes da câmera (por celular) ----------------------------------------------

export interface AjustesCamera {
  camera: 'back' | 'front';
  zoom: number; // 0 (sem zoom) a 1 (máximo do celular)
  flash: 'off' | 'on' | 'auto';
  lanterna: boolean; // lanterna acesa ao abrir
  formato: '4:3' | '16:9' | '1:1'; // 1:1 também recorta a foto enviada em quadrado
  qualidade: number; // JPEG da captura, 0 a 1
  ladoMaximo: number; // lado maior da foto enviada, em px; 0 = tamanho original
  maxFotos: number;
  som: boolean; // som do disparo
}

export const AJUSTES_PADRAO: AjustesCamera = {
  camera: 'back', zoom: 0, flash: 'off', lanterna: false, formato: '4:3', qualidade: 0.7, ladoMaximo: 1600, maxFotos: 10, som: false,
};

export const OPCOES_CAMERA = {
  camera: [['back', 'Traseira'], ['front', 'Frontal']],
  zoom: [[0, 'Sem zoom'], [0.1, '10%'], [0.2, '20%'], [0.3, '30%'], [0.5, '50%']],
  flash: [['off', 'Desligado'], ['auto', 'Automático'], ['on', 'Ligado']],
  formato: [['4:3', '4:3'], ['16:9', '16:9'], ['1:1', 'Quadrado']],
  qualidade: [[0.5, 'Econômica'], [0.7, 'Normal'], [0.9, 'Alta']],
  ladoMaximo: [[1200, '1200 px'], [1600, '1600 px'], [2048, '2048 px'], [0, 'Original']],
  maxFotos: [[5, '5'], [10, '10'], [20, '20']],
} as const;

/** Ajustes lidos do aparelho: valores fora das opções voltam ao padrão (versão antiga, arquivo corrompido). */
export function normalizarAjustes(bruto: unknown): AjustesCamera {
  const b = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const opcao = <K extends keyof typeof OPCOES_CAMERA>(k: K) =>
    (OPCOES_CAMERA[k] as readonly (readonly [unknown, string])[]).some(([v]) => v === b[k]) ? (b[k] as AjustesCamera[K]) : AJUSTES_PADRAO[k];
  return {
    camera: opcao('camera'),
    zoom: opcao('zoom'),
    flash: opcao('flash'),
    lanterna: typeof b.lanterna === 'boolean' ? b.lanterna : AJUSTES_PADRAO.lanterna,
    formato: opcao('formato'),
    qualidade: opcao('qualidade'),
    ladoMaximo: opcao('ladoMaximo'),
    maxFotos: opcao('maxFotos'),
    som: typeof b.som === 'boolean' ? b.som : AJUSTES_PADRAO.som,
  };
}

/**
 * Recorte e redução da foto enviada: retângulo central quadrado (formato 1:1) e novo tamanho (lado maior).
 * Devolve null no que não precisa mudar.
 */
export function planoDaFoto(largura: number, altura: number, a: Pick<AjustesCamera, 'formato' | 'ladoMaximo'>) {
  let w = largura;
  let h = altura;
  let recorte: { originX: number; originY: number; width: number; height: number } | null = null;
  if (a.formato === '1:1' && w !== h) {
    const lado = Math.min(w, h);
    recorte = { originX: Math.floor((w - lado) / 2), originY: Math.floor((h - lado) / 2), width: lado, height: lado };
    w = h = lado;
  }
  const maior = Math.max(w, h);
  const novo = a.ladoMaximo && maior > a.ladoMaximo ? (w >= h ? { width: a.ladoMaximo } : { height: a.ladoMaximo }) : null;
  return { recorte, novo };
}
