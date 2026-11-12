// Posição do celular para a auditoria das alterações (o servidor grava junto com o usuário e o aparelho).
// Nunca impede uma gravação: sem permissão, sem GPS ou demorando, a alteração vai sem posição.
import { Platform } from 'react-native';
import * as Location from 'expo-location';

const RECENTE_MS = 2 * 60_000; // posição de até 2 minutos atrás ainda vale (a pessoa está no mesmo lugar)
const ESPERA_MS = 4_000; // tempo máximo esperando o GPS antes de gravar sem posição

let permissao: boolean | null = null;
let ultima: Location.LocationObject | null = null;

/** Pede a permissão uma vez (ao abrir o app). Negada, o app segue funcionando sem posição. */
export async function pedirPermissaoLocalizacao(): Promise<boolean> {
  if (Platform.OS === 'web') return (permissao = false);
  try {
    const atual = await Location.getForegroundPermissionsAsync();
    const r = atual.granted || !atual.canAskAgain ? atual : await Location.requestForegroundPermissionsAsync();
    permissao = r.granted;
    // Já começa a buscar, para a primeira gravação não esperar o GPS
    if (permissao) void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then((p) => { ultima = p; }).catch(() => undefined);
  } catch {
    permissao = false;
  }
  return permissao;
}

const comLimite = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((ok) => setTimeout(() => ok(null), ms))]);

async function posicao(): Promise<Location.LocationObject | null> {
  if (permissao === null) await pedirPermissaoLocalizacao();
  if (!permissao) return null;
  if (ultima && Date.now() - ultima.timestamp < RECENTE_MS) return ultima;
  try {
    const nova = await comLimite(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), ESPERA_MS);
    if (nova) return (ultima = nova);
    const conhecida = await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000 });
    return conhecida ? (ultima = conhecida) : ultima;
  } catch {
    return ultima;
  }
}

/** Cabeçalhos com a posição para as requisições que alteram dados (vazio se não houver posição). */
export async function cabecalhosDePosicao(): Promise<Record<string, string>> {
  const p = await posicao();
  if (!p) return {};
  return {
    'X-Geo-Lat': String(p.coords.latitude),
    'X-Geo-Lon': String(p.coords.longitude),
    ...(p.coords.accuracy != null ? { 'X-Geo-Precisao': String(Math.round(p.coords.accuracy * 10) / 10) } : {}),
    'X-Geo-Momento': new Date(p.timestamp).toISOString(),
  };
}
