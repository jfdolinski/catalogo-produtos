const { withAndroidManifest } = require('expo/config-plugins');
const pacote = require('./package.json');

// Cresce a cada versão: o Android só atualiza por cima se o número subir. O CI informa o da execução.
const versionCode = Number(process.env.APP_VERSION_CODE) || 1;

// Só para testar contra um catálogo local, sem HTTPS (APP_TESTE_HTTP=1 no build).
const testeHttp = process.env.APP_TESTE_HTTP === '1';
const liberarHttp = (config) =>
  withAndroidManifest(config, (c) => {
    c.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
    return c;
  });

const usoDaCamera = 'A câmera lê o QR code de vínculo e o código de barras e tira as fotos dos produtos.';

module.exports = {
  expo: {
    name: 'Catálogo',
    slug: 'catalogo-app',
    version: pacote.version,
    orientation: 'portrait',
    scheme: 'catalogo',
    userInterfaceStyle: 'light',
    icon: './assets/icone.png',
    android: {
      package: 'br.com.catalogo.app',
      versionCode,
      adaptiveIcon: { foregroundImage: './assets/icone-frente.png', backgroundColor: '#0f172a' },
      // REQUEST_INSTALL_PACKAGES: abrir o instalador do Android com a versão nova (atualização automática)
      permissions: ['android.permission.CAMERA', 'android.permission.REQUEST_INSTALL_PACKAGES'],
      blockedPermissions: ['android.permission.RECORD_AUDIO'],
    },
    ios: {
      bundleIdentifier: 'br.com.catalogo.app',
      infoPlist: { NSCameraUsageDescription: usoDaCamera },
    },
    plugins: [
      ['expo-camera', { cameraPermission: usoDaCamera, microphonePermission: false, recordAudioAndroid: false }],
      'expo-secure-store',
      ...(testeHttp ? [liberarHttp] : []),
    ],
    extra: { testeHttp },
  },
};
