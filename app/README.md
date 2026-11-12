# Aplicativo de celular (Catálogo)

Atualiza cadastros pelo celular Android, usando a câmera:

1. Lê o código de barras (câmera ou digitado).
2. Produto cadastrado: a câmera abre para as fotos. Depois, opcionalmente: conferir nome e marca, escolher a foto principal, apagar fotos, marcar como revisado.
3. Produto não cadastrado: mostra o que as bases públicas sabem do código (as mesmas da fila de atualização; a Cosmos só pelo botão), o usuário confirma ou digita o nome, cadastra e segue para as fotos.

React Native com Expo, a mesma base do app Flow. Usa as rotas do painel (`/api/admin/...`) com o token do aparelho, então vale o que o usuário pode fazer no painel (módulo **Atualização** ou **Produtos**).

## Auditoria (localização)

Cada alteração enviada pelo app leva a posição do celular (cabeçalhos `X-Geo-Lat`, `X-Geo-Lon`, `X-Geo-Precisao`, `X-Geo-Momento`), e o servidor grava em `app_audit` com o usuário e o aparelho. A permissão é pedida ao abrir o app, só com o app em uso (sem localização em segundo plano). Sem permissão ou sem GPS em 4 segundos, a alteração vai sem posição: nunca deixa de gravar por causa disso (`src/localizacao.ts`).

## Vínculo do celular (como no Flow)

- No painel, o usuário clica em **📱 Aplicativo** (no alto) e aparece um QR code `catalogo://vincular?servidor=...&codigo=...`. O código vale 10 minutos e uma vez só; gerar outro invalida o anterior.
- O app lê o QR (ou o usuário digita o endereço e o código) e chama `POST /api/app/link`. Recebe um token `app_...`, guardado no cofre do aparelho (`expo-secure-store`). O servidor guarda só o hash.
- O token vale como o login do usuário até ser desvinculado (no painel, na mesma janela, ou em **Sair** no app) ou o usuário ser desativado. Tentativas erradas bloqueiam por 15 minutos.

## Comandos

```bash
npm ci
npm test              # regras em src/regras.ts
npm run typecheck
npm run web           # telas no navegador, para desenvolver; sem câmera nem cofre do aparelho
```

Os testes do servidor para o app ficam em `tests/app.test.mjs` (raiz do projeto).

## Como o APK nasce e vai para o ar

1. Suba `version` em `package.json` quando for versão nova. Mesmo sem subir, cada compilação tem número próprio (`versionCode`), e o app compara versão e compilação com a publicada.
2. O workflow **Aplicativo** (`.github/workflows/aplicativo.yml`) roda a cada push em `main` que mexe em `app/` (ou à mão, em Actions). Ele compila, instala num emulador, confere que abre e publica uma Release `app-<versão>-<execução>`.
3. Para colocar no ar: `.\deploy\publicar-app.ps1 -Tag app-1.0.0-3` (sem `-Tag`: a mais recente). O APK vai para `/opt/catalogo/data/downloads` e fica em `/downloads/catalogo-app.apk`; o painel mostra o botão de download na janela do aplicativo.

Não é preciso Android SDK na máquina.

## Atualização automática

Ao abrir (e sempre que volta para a frente), o app confere `/downloads/app-versao.txt`. Se a publicada for mais nova, baixa o APK sozinho e abre o instalador do Android: o usuário só toca em **Atualizar**. Na primeira vez o Android pede para permitir instalar apps desta origem. Não dá para pular essa confirmação fora da Play Store. A atualização mantém o vínculo do celular, desde que o APK novo seja assinado com a mesma chave.

## Chave de assinatura (uma vez)

Sem os segredos abaixo, o APK sai de **teste**, assinado com a chave pública de depuração. Funciona, mas trocar depois para a chave de produção obriga a desinstalar e instalar de novo em todos os celulares. Melhor criar antes de distribuir:

```bash
node scripts/gerar-chave.mjs <pasta-fora-do-repositorio>
```

Guarde o arquivo `.p12` e a senha em lugar seguro e cadastre no GitHub (Settings → Secrets and variables → Actions):

| Segredo | Conteúdo |
|---|---|
| `APP_KEYSTORE_BASE64` | `catalogo-app-keystore-base64.txt` |
| `APP_KEYSTORE_SENHA` | `catalogo-app-senha.txt` |

## Estrutura

- `src/regras.ts`: leitura do QR, código de barras, sugestões, versões. Sem React Native; testado com Node.
- `src/api.ts`: sessão no cofre do aparelho e chamadas ao catálogo.
- `src/App.tsx`: fluxo (ler → fotos → conferir, ou ler → cadastrar → fotos → conferir).
- `src/TelaVincular.tsx`, `LeitorCodigo.tsx`, `TelaFotos.tsx`, `TelaProduto.tsx`, `TelaNovo.tsx`: telas.
- `src/ui.tsx`: botões, alertas e cores (verde, para não confundir com o Flow).
