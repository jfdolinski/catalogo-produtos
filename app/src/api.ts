import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { File, UploadType } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { cabecalhosDePosicao } from './localizacao';
import type { Sugestao } from './regras';

/** Lado maior das fotos enviadas: nítido para o catálogo e leve na rede móvel (de ~4 MB para ~300 KB). */
const LADO_MAXIMO = 1600;

export interface Usuario {
  id: number;
  name: string;
  login: string;
  permissions: string[];
  is_admin: boolean;
}

/** Itens da fila de atualização, como no painel ('' = todos). */
export type Origem = 'pending' | 'overdue' | 'due_week' | 'no_image' | '';

export interface Sessao {
  servidor: string;
  token: string;
  usuario: Usuario;
}

export interface Imagem {
  id: number | null;
  url: string;
  placeholder: boolean;
  ai_generated: boolean;
}

export interface Produto {
  id: number;
  name: string;
  brand: string | null;
  unit: string | null;
  manufacturer: string | null;
  category: string | null;
  barcodes: { id: number; code: string }[];
  images: Imagem[];
  pending?: boolean;
}

const CHAVE = 'catalogo.sessao';

// O cofre do aparelho não existe no navegador, usado só para desenvolver as telas.
const cofre =
  Platform.OS === 'web'
    ? {
        getItemAsync: async (k: string) => localStorage.getItem(k),
        setItemAsync: async (k: string, v: string) => localStorage.setItem(k, v),
        deleteItemAsync: async (k: string) => localStorage.removeItem(k),
      }
    : SecureStore;

export async function lerSessao(): Promise<Sessao | null> {
  const texto = await cofre.getItemAsync(CHAVE);
  if (!texto) return null;
  try {
    return JSON.parse(texto) as Sessao;
  } catch {
    return null;
  }
}

export const gravarSessao = (s: Sessao) => cofre.setItemAsync(CHAVE, JSON.stringify(s));
export const apagarSessao = () => cofre.deleteItemAsync(CHAVE);

export class ErroApi extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/** Sem internet ou servidor fora: não é motivo para desvincular o celular. */
export const semConexao = (e: unknown) => e instanceof ErroApi && e.status === 0;

/** Falha no meio de um envio de várias fotos: as `enviadas` primeiras já estão no catálogo. */
export class ErroEnvio extends ErroApi {
  constructor(
    status: number,
    mensagem: string,
    readonly enviadas: number,
  ) {
    super(status, mensagem);
  }
}

/** Reduz a foto da câmera para JPEG de no máximo LADO_MAXIMO px no lado maior. */
async function reduzir(uri: string): Promise<string> {
  const contexto = ImageManipulator.manipulate(uri);
  const original = await contexto.renderAsync();
  const maior = Math.max(original.width, original.height);
  const imagem =
    maior > LADO_MAXIMO
      ? await ImageManipulator.manipulate(uri)
          .resize(original.width >= original.height ? { width: LADO_MAXIMO } : { height: LADO_MAXIMO })
          .renderAsync()
      : original;
  const salva = await imagem.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return salva.uri;
}

async function pedir<T>(servidor: string, caminho: string, opcoes: { metodo?: string; corpo?: unknown; form?: FormData; token?: string; limiteMs?: number; extras?: Record<string, string> }): Promise<T> {
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), opcoes.limiteMs ?? 60_000);
  let resposta: Response;
  try {
    resposta = await fetch(`${servidor}${caminho}`, {
      method: opcoes.metodo ?? 'GET',
      signal: controle.signal,
      headers: {
        Accept: 'application/json',
        ...(opcoes.corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {}),
        ...opcoes.extras,
      },
      body: opcoes.form ?? (opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo)),
    });
  } catch {
    throw new ErroApi(0, controle.signal.aborted ? 'O servidor demorou demais para responder. Tente de novo.' : 'Sem conexão com o servidor. Confira a internet e tente de novo.');
  } finally {
    clearTimeout(limite);
  }
  if (resposta.status === 204) return undefined as T;
  const dados = (await resposta.json().catch(() => null)) as { error?: string } | null;
  if (!resposta.ok) throw new ErroApi(resposta.status, dados?.error || `Erro ${resposta.status} no servidor.`);
  return dados as T;
}

export function vincular(servidor: string, codigo: string, nome: string, plataforma: 'ANDROID' | 'IOS', versao: string) {
  return pedir<{ token: string; user: Usuario }>(servidor, '/api/app/link', { metodo: 'POST', corpo: { codigo, nome, plataforma, versao } });
}

/** Versão do aplicativo publicada no servidor; null se não der para saber. */
export async function versaoPublicada(servidor: string): Promise<string | null> {
  try {
    const r = await fetch(`${servidor}/downloads/app-versao.txt`);
    return r.ok ? (await r.text()).trim() : null;
  } catch {
    return null;
  }
}

/** Chamadas do catálogo com o token do aparelho. 401 = desvinculado ou usuário desativado. */
export function clienteDa(sessao: Sessao, aoExpirar: () => void) {
  async function chamar<T>(caminho: string, opcoes: { metodo?: string; corpo?: unknown; form?: FormData; limiteMs?: number } = {}): Promise<T> {
    try {
      // Alterações levam a posição do celular, gravada pelo servidor na auditoria junto com o usuário
      const extras = opcoes.metodo && opcoes.metodo !== 'GET' ? await cabecalhosDePosicao() : undefined;
      return await pedir<T>(sessao.servidor, `/api/admin${caminho}`, { ...opcoes, token: sessao.token, extras });
    } catch (e) {
      if (e instanceof ErroApi && e.status === 401) aoExpirar();
      throw e;
    }
  }
  return {
    eu: () => chamar<{ user: Usuario }>('/me'),
    produto: (id: number) => chamar<Produto>(`/products/${id}`),
    /** Valores já cadastrados de marca ou categoria que contêm `q` (mais usados primeiro). */
    valores: (campo: 'brand' | 'category', q: string) =>
      chamar<{ value: string; products: number }[]>(`/field-values/${campo}?q=${encodeURIComponent(q)}&limit=8`, { limiteMs: 15_000 }),
    /** Ids da fila de atualização, na mesma ordem do painel (pendentes: mais consultados primeiro). */
    fila: (origem: Origem) => {
      const p = new URLSearchParams(origem ? { [origem]: '1' } : {});
      if (origem === 'pending') p.set('order', 'requests');
      return chamar<{ ids: number[] }>(`/product-ids?${p}`);
    },
    porCodigo: (codigo: string) => chamar<{ found: boolean; code: string; product?: Produto }>(`/code/${encodeURIComponent(codigo)}`),
    sugestoes: (codigo: string, cosmos: 'cache' | 'only' = 'cache') =>
      chamar<{ cosmos_available: boolean; results: Sugestao[] }>(`/lookup/${encodeURIComponent(codigo)}?cosmos=${cosmos}`),
    cadastrar: (dados: { name: string; brand: string; category: string }, codigo: string) =>
      chamar<Produto>('/products', { metodo: 'POST', corpo: { ...dados, barcodes: [codigo] } }),
    salvar: (id: number, dados: { name: string; brand: string; category: string }) => chamar<Produto>(`/products/${id}`, { metodo: 'PUT', corpo: dados }),
    revisado: (id: number) => chamar<Produto>(`/products/${id}/resolve`, { metodo: 'POST' }),
    fotoDaUrl: (id: number, url: string) => chamar<{ product: Produto }>(`/products/${id}/images/from-url`, { metodo: 'POST', corpo: { url } }),
    ordenar: (id: number, ids: number[]) => chamar<Produto>(`/products/${id}/images/order`, { metodo: 'PUT', corpo: { ids } }),
    apagarFoto: (imagemId: number) => chamar<Produto>(`/images/${imagemId}`, { metodo: 'DELETE' }),
    /**
     * Fotos tiradas na câmera (arquivos locais do aparelho): cada uma é reduzida e enviada pelo módulo nativo
     * de arquivos, uma por vez. O fetch do React Native com FormData falhava no Android ("sem conexão").
     * Se uma falhar, ErroEnvio diz quantas já foram, para tentar de novo só as que faltam.
     */
    enviarFotos: async (id: number, uris: string[], aoProgresso?: (enviadas: number) => void): Promise<Produto> => {
      let produto: Produto | null = null;
      for (const [i, uri] of uris.entries()) {
        aoProgresso?.(i);
        let arquivo: string;
        try {
          arquivo = await reduzir(uri);
        } catch {
          throw new ErroEnvio(-1, `Não foi possível preparar a foto ${i + 1}. Tire de novo.`, i);
        }
        let r: { status: number; body: string };
        try {
          r = await new File(arquivo).upload(`${sessao.servidor}/api/admin/products/${id}/images`, {
            httpMethod: 'POST',
            uploadType: UploadType.MULTIPART,
            fieldName: 'images',
            mimeType: 'image/jpeg',
            headers: { Authorization: `Bearer ${sessao.token}`, Accept: 'application/json', ...(await cabecalhosDePosicao()) },
          });
        } catch (e) {
          const detalhe = e instanceof Error && e.message ? ` (${e.message.slice(0, 120)})` : '';
          throw new ErroEnvio(0, `Falha de rede ao enviar a foto ${i + 1} de ${uris.length}. Confira a internet e tente de novo.${detalhe}`, i);
        }
        let dados: (Produto & { error?: string }) | null = null;
        try {
          dados = JSON.parse(r.body);
        } catch {
          /* resposta sem JSON (proxy) */
        }
        if (r.status === 401) aoExpirar();
        if (r.status < 200 || r.status >= 300 || !dados) {
          throw new ErroEnvio(r.status, dados?.error || `Erro ${r.status} ao enviar a foto ${i + 1}.`, i);
        }
        produto = dados;
      }
      aoProgresso?.(uris.length);
      return produto!;
    },
    desvincular: () => chamar<void>('/me/device', { metodo: 'DELETE' }),
  };
}

export type Api = ReturnType<typeof clienteDa>;
