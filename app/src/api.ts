import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { Sugestao } from './regras';

export interface Usuario {
  id: number;
  name: string;
  login: string;
  permissions: string[];
  is_admin: boolean;
}

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

async function pedir<T>(servidor: string, caminho: string, opcoes: { metodo?: string; corpo?: unknown; form?: FormData; token?: string; limiteMs?: number }): Promise<T> {
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
      },
      body: opcoes.form ?? (opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo)),
    });
  } catch {
    throw new ErroApi(0, 'Sem conexão com o servidor. Confira a internet e tente de novo.');
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
      return await pedir<T>(sessao.servidor, `/api/admin${caminho}`, { ...opcoes, token: sessao.token });
    } catch (e) {
      if (e instanceof ErroApi && e.status === 401) aoExpirar();
      throw e;
    }
  }
  return {
    eu: () => chamar<{ user: Usuario }>('/me'),
    porCodigo: (codigo: string) => chamar<{ found: boolean; code: string; product?: Produto }>(`/code/${encodeURIComponent(codigo)}`),
    sugestoes: (codigo: string, cosmos: 'cache' | 'only' = 'cache') =>
      chamar<{ cosmos_available: boolean; results: Sugestao[] }>(`/lookup/${encodeURIComponent(codigo)}?cosmos=${cosmos}`),
    cadastrar: (dados: { name: string; brand: string; category: string }, codigo: string) =>
      chamar<Produto>('/products', { metodo: 'POST', corpo: { ...dados, barcodes: [codigo] } }),
    salvar: (id: number, dados: { name: string; brand: string }) => chamar<Produto>(`/products/${id}`, { metodo: 'PUT', corpo: dados }),
    revisado: (id: number) => chamar<Produto>(`/products/${id}/resolve`, { metodo: 'POST' }),
    fotoDaUrl: (id: number, url: string) => chamar<{ product: Produto }>(`/products/${id}/images/from-url`, { metodo: 'POST', corpo: { url } }),
    ordenar: (id: number, ids: number[]) => chamar<Produto>(`/products/${id}/images/order`, { metodo: 'PUT', corpo: { ids } }),
    apagarFoto: (imagemId: number) => chamar<Produto>(`/images/${imagemId}`, { metodo: 'DELETE' }),
    /** Fotos tiradas na câmera (arquivos locais do aparelho), enviadas de uma vez. */
    enviarFotos: (id: number, uris: string[]) => {
      const form = new FormData();
      uris.forEach((uri, i) => {
        // No React Native o arquivo vai por { uri, name, type }; o servidor aceita jpeg, png e webp.
        form.append('images', { uri, name: `foto-${Date.now()}-${i + 1}.jpg`, type: 'image/jpeg' } as unknown as Blob);
      });
      return chamar<Produto>(`/products/${id}/images`, { metodo: 'POST', form, limiteMs: 180_000 });
    },
    desvincular: () => chamar<void>('/me/device', { metodo: 'DELETE' }),
  };
}

export type Api = ReturnType<typeof clienteDa>;
