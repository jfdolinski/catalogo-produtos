// Atualização automática do aplicativo (Android, fora da Play Store).
// Ao abrir (e ao voltar para o app), compara a versão instalada com a publicada no catálogo; se houver nova,
// baixa o APK sozinho e abre o instalador do Android. O Android não deixa um app se instalar sem confirmação:
// o usuário só toca em "Atualizar" (e, na primeira vez, permite instalar apps desta origem).
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { versaoPublicada } from './api';
import { versaoMaisNova } from './regras';

const FLAG_GRANT_READ_URI_PERMISSION = 1;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

/**
 * Versão instalada no formato da publicada: "1.0.1-5" (versão-compilação; a compilação é o versionCode).
 * Lida do pacote instalado (expo-application), não da configuração embutida no JavaScript: na 1.0.1 a
 * configuração embutida trazia versionCode 1, o app se achava sempre mais velho e ficava se atualizando.
 */
export const versaoInstalada = () =>
  `${Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0'}-${Application.nativeBuildVersion ?? '0'}`;

/** Versão publicada mais nova que a instalada (compara versão e, se igual, a compilação), ou null. */
export async function versaoNova(servidor: string): Promise<string | null> {
  const publicada = await versaoPublicada(servidor);
  return publicada && versaoMaisNova(publicada.replace('-', '.'), versaoInstalada().replace('-', '.')) ? publicada : null;
}

/** Baixa o APK publicado e abre o instalador do Android. */
export async function baixarEInstalar(servidor: string, versao: string): Promise<void> {
  if (Platform.OS !== 'android') throw new Error('Atualização automática só no Android.');
  const pasta = new Directory(Paths.cache, 'atualizacao');
  // Apaga downloads antigos: cada APK tem ~65 MB
  if (pasta.exists) pasta.delete();
  pasta.create({ idempotent: true, intermediates: true });
  const destino = new File(pasta, `catalogo-${versao}.apk`);
  const apk = await File.downloadFileAsync(`${servidor}/downloads/catalogo-app.apk`, destino);
  const uri = await getContentUriAsync(apk.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: uri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}
