# Repositório de Imagens de Produtos

Cadastro central de produtos com **várias imagens** e **vários códigos de barras** por item,
que gera **links públicos** (JSON, CSV, página e imagem direta) para outros sistemas usarem como catálogo.

- Node.js ≥ 22.13 e **PostgreSQL** (`DATABASE_URL`)
- Arquivos em `data/`: `images/` (fotos) e `config.json` (token de administração, se não vier de `ADMIN_TOKEN`)

## Rodar

```bash
npm install
npm run db:local        # PostgreSQL local (PGlite) na porta 5433, dados em data/pg-local; deixe aberto
DATABASE_URL=postgres://postgres@localhost:5433/postgres npm start
```

- **Painel:** http://localhost:3000/ (também em `/admin/`). Pede login; no primeiro acesso, use o token de
  administração, que aparece no terminal ao iniciar e fica salvo em `data/config.json`.
- **Consulta pública, sem login:** http://localhost:3000/consulta/
- **Testes:** `npm test` (cada arquivo sobe o catálogo com um PostgreSQL descartável; nada toca em dados reais).

### Variáveis de ambiente

| Variável          | Padrão              | Uso                                                                  |
|-------------------|---------------------|----------------------------------------------------------------------|
| `DATABASE_URL`    | —                   | Conexão do PostgreSQL (obrigatória)                                  |
| `PORT`            | `3000`              | Porta HTTP                                                           |
| `PUBLIC_BASE_URL` | host atual          | Base usada nos links gerados (ex.: `https://catalogo.suaempresa.com`) |
| `ADMIN_TOKEN`     | gerado              | Substitui o token salvo em `data/config.json`                         |
| `DATA_DIR`        | `data`              | Pasta das imagens e do `config.json`                                 |
| `APP_TZ`          | `America/Sao_Paulo` | Fuso do "hoje" (dashboard, estatísticas por dia, prazos)             |
| `DB_POOL_MAX`     | `10`                | Conexões simultâneas com o banco                                     |
| `AUTO_CADASTRO`   | ligado              | `0` desliga o cadastro automático de códigos não encontrados          |
| `CATALOGO_CACHE_SEGUNDOS` | `300`       | Validade do catálogo completo em memória                             |
| `MIGRAR_SQLITE`   | —                   | Caminho do `catalogo.db` antigo: com o PostgreSQL vazio, copia tudo ao iniciar |

### Banco de dados

O esquema fica em `src/schema.sql` e é aplicado a cada início (só cria o que falta). As consultas usam a forma do SQLite,
e `src/db.js` traduz o que difere: parâmetros `?`, `datetime('now', ...)`/`date(...)` (funções `sqlite_datetime`/`sqlite_date`
no banco), `INSERT OR IGNORE`, `COLLATE NOCASE` e `LIKE` sem diferenciar maiúsculas. Datas ficam como texto UTC
(`AAAA-MM-DD HH:MM:SS`). Transações: `await tx(async () => ...)`.

**Migração do SQLite:** `DATABASE_URL=... node scripts/migrar-sqlite.mjs data/catalogo.db`, ou `MIGRAR_SQLITE` ao subir.
Só roda com o PostgreSQL sem produtos, é tudo ou nada, confere a contagem de cada tabela e guarda uma cópia do arquivo
SQLite antes (`catalogo.db.antes-postgres-<data>`).

## Produção (Easypanel)

Publicado em **https://catalogo.b6nhiy.easypanel.host/** (VPS `212.85.12.23`, Ubuntu 24.04 com Easypanel).
Código em **github.com/jfdolinski/catalogo-produtos** (privado).

| Item          | Onde                                                                                         |
|---------------|----------------------------------------------------------------------------------------------|
| Banco         | serviço PostgreSQL do Easypanel; a URL interna vai em `DATABASE_URL` do app                   |
| App           | app do Easypanel construído pelo `Dockerfile` do repositório, porta 3000, **1 réplica**       |
| Imagens       | volume montado em `/app/data`                                                                |
| Domínio/HTTPS | configurado no app do Easypanel                                                              |

Publicar: envie ao GitHub e clique em **Deploy** no app (ou ligue o deploy automático).
`node deploy/verificar.mjs https://catalogo.b6nhiy.easypanel.host data/config.json` testa o sistema publicado.

Os scripts `deploy/publicar.ps1` e `deploy/instalar.sh` são da instalação anterior (serviço `systemd` com SQLite) e ficam só para
voltar atrás, se for preciso.

## Dashboard (página inicial)

`http://localhost:3000/` abre o **Dashboard**; a aba **Produtos** (`/#/produtos`) é o cadastro.
Atualiza sozinho a cada minuto. Os cards com filtro abrem a lista de produtos já filtrada:

| Card                    | Conteúdo                                                        | Filtro da lista       |
|-------------------------|-----------------------------------------------------------------|-----------------------|
| Produtos cadastrados    | total, ativos e inativos                                        | todos                 |
| Cadastros pendentes     | produtos de cadastro automático; consultas aguardando           | `pending=1`           |
| Registros vencidos      | prazo de dados ou imagens vencido                               | `overdue=1`           |
| Vencendo hoje           | prazo de dados ou imagens vence hoje (e nos próximos 7 dias)    | `due_today=1` / `due_week=1` |
| Novos hoje              | cadastrados hoje                                                | `created_today=1`     |
| Atualizados hoje        | cadastros de antes de hoje alterados hoje                       | `updated_today=1`     |
| Conexão mais utilizada  | origem com mais consultas por código de barras                  | —                     |
| Consultas hoje          | consultas de hoje, conexões ativas hoje e total                 | —                     |
| Sem foto real           | produtos sem nenhuma imagem real                                | `no_image=1`          |
| Códigos de barras, Inativos, Mesclagens | totais                                          | `inactive=1` (inativos) |

Painéis: conexões mais utilizadas (consultas no período, hoje, auto-cadastros, última consulta), pendentes mais
consultados e últimas atualizações. Dados em `GET /api/admin/dashboard`.

O painel de conexões e o card "Conexão mais utilizada" seguem o período escolhido (padrão: últimos 7 dias, ou
de/até); clique no título de uma coluna para ordenar. Na API: `?dias=7` (`0` = todo o período) ou
`?de=AAAA-MM-DD&ate=AAAA-MM-DD`. A lista traz até 500 conexões. Os demais cards não dependem do período.

As consultas são contadas por origem e por dia (data local do servidor) em `/api/v1/barcodes/{codigo}` e
`/img/{codigo}`. O histórico anterior à contagem foi estimado a partir da última origem de cada código pendente.

## Links públicos (sem autenticação, CORS liberado)

Só produtos marcados como **ativos** aparecem.

| Link                                   | Retorna                                                   |
|----------------------------------------|-----------------------------------------------------------|
| `GET /api/v1/barcodes/{codigo}`        | Produto pelo código de barras (qualquer um dos códigos)    |
| `GET /img/{codigo}`                    | Redireciona para a imagem principal do produto            |
| `GET /img/{codigo}/{n}`                | Redireciona para a n-ésima imagem (1 = principal)         |
| `GET /api/v1/products/{id}`            | Produto por id                                            |
| `GET /api/v1/products?q=&category=&page=&limit=` | Busca paginada (nome, SKU, marca, descrição, código) |
| `GET /api/v1/categories`               | Categorias e quantidade de produtos                       |
| `GET /api/v1/catalog.json`             | Catálogo completo em JSON                                 |
| `GET /api/v1/catalog.csv`              | Catálogo completo em CSV (`;`, UTF-8, abre no Excel)       |

Os dois catálogos ficam prontos em memória, comprimidos: uma alteração pode levar até 10 minutos para aparecer neles (5 de validade,
mais 5 em que a cópia ainda é entregue enquanto outra é montada; `CATALOGO_CACHE_SEGUNDOS` ajusta a validade). As demais rotas são sempre atuais.
Eles respondem com `ETag`: quem envia `If-None-Match` recebe `304` se nada mudou, sem baixar de novo.
| `GET /p/{id}`                          | Página HTML do produto                                    |
| `GET /files/{arquivo}`                 | Arquivo da imagem (cache longo, nome imutável)            |

Uso típico em outro sistema: `<img src="https://catalogo.suaempresa.com/img/7891000315507">`.

## Cadastro automático de códigos não encontrados

Quando `/api/v1/barcodes/{codigo}` ou `/img/{codigo}` recebe um código que não existe na base:

1. É criado um produto `PRODUTO NÃO CADASTRADO {codigo}` com esse código e a imagem padrão
   (`assets/imagem-padrao.png`, caixa de medicamento "IMAGEM NÃO LOCALIZADA"). A resposta já devolve esse produto.
2. O código entra na **lista de pendentes**, com nº de consultas, primeira/última consulta e origem.
3. O JSON do produto traz `"pending": true` e a imagem traz `"placeholder": true`, para o sistema consumidor saber que é provisório.

Só códigos GTIN válidos (EAN-8, UPC-A, EAN-13, DUN-14 com dígito verificador correto) são cadastrados;
outros recebem 404. Códigos de produtos **inativos** também recebem 404 e não são recriados.

Origem da consulta: informe `?origem=NOME` ou o header `X-Origem: NOME`. Sem isso, usa o host do Referer ou o IP.

No painel, a aba **Pendentes** lista esses produtos. O primeiro envio de foto real remove a imagem padrão,
e o botão **Marcar como atualizado** tira o produto da lista.

A imagem padrão pode ser regerada/alterada com `scripts/gerar-imagem-padrao.ps1` (vale para novos cadastros).

**Zeros à esquerda:** `/api/v1/barcodes/{codigo}` e `/img/{codigo}` acham o mesmo GTIN com outra quantidade de zeros
(`07896004801216` = `7896004801216`), sem criar cadastro duplicado. Código com menos de 7 dígitos sem os zeros só vale exato.

**Imagem padrão:** produto sem imagem própria sempre mostra a imagem padrão, escolhida entre as 10 opções em **Parâmetros**
(arquivos em `assets/padrao`, geradas por `scripts/gerar-imagens-padrao.ps1`). É um arquivo só (`/padrao/{n}.png`), sem linha em `images`: na API
vem com `id: null` e `placeholder: true`. Enviar uma foto a substitui; excluir a última foto a traz de volta. O item segue em "Sem foto real".

## Parâmetros e prazos de atualização

Tela **⚙ Parâmetros** no painel (ou `GET/PUT /api/admin/settings`):

| Parâmetro              | Padrão | Significado                                                        |
|------------------------|--------|--------------------------------------------------------------------|
| `prazo_cadastro_dias`  | 180    | Dias até o cadastro (dados) precisar ser atualizado. 0 = sem prazo |
| `prazo_imagens_dias`   | 365    | Dias até as imagens precisarem ser atualizadas. 0 = sem prazo      |

- **Dados**: salvar o cadastro (mesmo sem mudanças) conta como atualização e renova o prazo.
- **Imagens**: enviar, excluir ou reordenar imagens renova o prazo; o botão **Confirmar imagens atuais**
  (`POST /api/admin/products/{id}/images/confirm`) renova sem enviar novas.
- Itens com prazo vencido aparecem na aba **Vencidos** (`GET /api/admin/products?overdue=1`).

### Datas registradas

- Produto: `created_at` (cadastro), `updated_at` (última alteração do registro, qualquer que seja).
- `review.data` e `review.images`: última atualização, data limite (`due_at`) e se está vencido (`overdue`).
- `field_dates`: data de cadastro e de alteração **de cada informação** (`name`, `sku`, `description`, `brand`,
  `category`, `unit`, `active`). A data de alteração só muda quando o valor muda.
- Cada código de barras tem `created_at`/`updated_at` (alterado quando muda tipo ou observação).
- Cada imagem tem `created_at` (data de envio).

## Ferramentas de atualização (aba "Atualização")

**Fila de atualização** — percorre Pendentes (mais consultados primeiro), Vencidos, Vencendo em 7 dias, Sem foto
real ou Todos, um item por vez. Mostra os códigos com link do Google Imagens e as sugestões das bases externas
("Usar dados" / "Usar foto"). Imagens: arrastar, escolher, **colar com Ctrl+V** ou colar uma URL.
**Salvar e próximo** (Ctrl+Enter) grava, renova o prazo e tira o item dos pendentes.

**Importar planilha** — CSV (`;`, `,` ou tab; UTF-8 ou Windows-1252) ou Excel `.xlsx`, uma linha por produto.
Colunas reconhecidas (nomes sem acento/maiúsculas): `codigo_barras` (ou `ean`, `gtin`; vários separados por `|`),
`sku`, `nome`, `descricao`, `marca`, `categoria`, `unidade`, `ativo` (sim/não), `imagem_url` (várias com `|`).
O produto é localizado pelo código de barras (ou SKU). Antes de aplicar há uma **prévia** linha a linha
(criar / atualizar / sem mudança / erro). Opções: criar códigos inexistentes, tirar dos pendentes, baixar imagens,
células vazias apagam valores. Limite: 20.000 linhas e 20 MB por arquivo. API: `POST /api/admin/import/preview`
(multipart `file`) e `POST /api/admin/import/apply` (`{ rows, options }`).

**Busca automática** — consulta em segundo plano Cosmos/Bluesoft (se houver token em ⚙ Parâmetros), Open Food Facts,
Open Beauty Facts e Open Products Facts, ~1 item a cada 0,7 s. Preenche **só campos vazios** (e o nome provisório) e
baixa a foto quando só há a imagem padrão; os itens **continuam pendentes** para revisão na fila (com aviso de
"preenchido automaticamente"). Itens já consultados são pulados nas próximas execuções. API: `GET /api/admin/autofill`,
`POST /api/admin/autofill/start` (`{ target, limit, skip_checked }`), `POST /api/admin/autofill/stop`.

**Edição em massa** — na aba Produtos, "☑ Edição em massa": marque itens (ou "todos do filtro atual") e altere
categoria, marca, unidade, ativo/inativo, marque como atualizados ou confirme as imagens. API: `POST /api/admin/bulk`
com `{ ids | filter, set: { category, brand, unit, active }, actions: { resolve, confirm_images } }`.

Outros endpoints: `GET /api/admin/lookup/{codigo}` (busca externa), `POST /api/admin/products/{id}/images/from-url`
(`{ url }` ou `{ urls }`), `GET /api/admin/product-ids?<filtro>=1&order=requests`.

### Imagem gerada por IA

Opcional. Para ativar, vá em **Parâmetros → Geração de imagem por IA**: escolha o provedor (OpenAI ou Google Gemini)
e cole a chave da API. Se quiser, troque o modelo; os padrões são `gpt-image-1-mini` e `gemini-2.5-flash-image`.

- **Fila de atualização:** botão **✨ Gerar imagem por IA**.
- **Busca automática:** opção "Gerar imagem por IA quando não houver foto", desligada por padrão. Ela só gera a
  imagem para itens que ficaram sem nenhuma foto depois da consulta às bases. Se o provedor recusar a chave ou o
  limite acabar, a geração é desligada no resto do lote.
- A IA não reconhece um produto pelos dígitos do código de barras. Por isso, o código identifica o produto, e a
  imagem é gerada a partir do **nome, marca, tamanho e categoria**. Esses dados vêm, nesta ordem:
  - do formulário da fila (mesmo antes de salvar);
  - do cadastro;
  - da primeira base externa que conhece o código.
- Sem um nome identificado, nada é gerado: a rota responde 400 e a busca automática pula o item.
- A imagem gerada:
  - substitui a imagem padrão;
  - fica marcada como **IA** (`ai_generated: true` na API, selo "IA" no painel, aviso na página pública e na consulta);
  - **não conta como foto real**: o item continua em "Sem foto real" e o prazo das imagens não é renovado;
  - quando uma foto real é enviada depois, ela passa para a frente da imagem de IA.
- Cada imagem é cobrada na conta do provedor.
- Rotas:
  - `GET /api/admin/ai/status`;
  - `POST /api/admin/products/{id}/images/ai` com `{ name?, brand?, unit?, category?, description? }`.
- As variáveis `IA_OPENAI_URL` e `IA_GEMINI_URL` permitem trocar o endereço das APIs, por exemplo para usar um proxy.

## Aplicativo de celular (Android)

Atualiza cadastros pela câmera do celular: lê o código de barras; se o produto existe, a câmera abre para as fotos (depois dá para conferir nome e marca, escolher a foto principal e marcar como revisado); se não existe, mostra o que as bases públicas sabem e cadastra na hora. Código em `app/` (Expo, mesma base do app Flow); detalhes em [app/README.md](app/README.md).

- **Vínculo:** no painel, **📱 Aplicativo** (no alto) mostra um QR code de uso único, válido por 10 minutos. O app troca o código por um token de aparelho, que vale como o login do usuário (mesmas permissões: módulo Atualização ou Produtos) até ser desvinculado na mesma janela, pelo **Sair** do app, ou o usuário ser desativado.
- **Rotas:** `POST /api/admin/me/app-link` (gera o código e o QR), `GET /api/admin/me/devices` e `DELETE /api/admin/me/devices/:id` (aparelhos do usuário), `GET /api/admin/users/:id/devices` e `DELETE /api/admin/users/:id/devices/:aparelho` (administração de usuários), `POST /api/app/link` (o app troca o código pelo token), `DELETE /api/admin/me/device` (o app se desvincula) e `GET /api/admin/code/:codigo` (produto pelo código de barras, aceitando UPC-A de 12 dígitos para EAN-13 com zero; não conta como consulta nem cadastra).
- **Auditoria:** toda alteração feita pelo app (cadastro, edição, revisado, fotos, foto principal, foto apagada) fica em `app_audit` com o usuário, o aparelho, o produto, a ação, a data e a posição do celular (latitude, longitude, precisão e hora da leitura, enviadas nos cabeçalhos `X-Geo-*`; sem permissão de localização a alteração é gravada sem posição). Consulta (só administrador): `GET /api/admin/app-audit?product_id=&user_id=&device_id=&limit=`.
- **Download:** o APK é gerado pelo workflow **Aplicativo** do GitHub e posto no ar com `deploy/publicar-app.ps1`, que o copia para `DATA_DIR/downloads`; fica em `/downloads/catalogo-app.apk` e o painel mostra o botão de download.

## Tratamento automático de espaços

Todo texto que entra ou é atualizado fica sem espaço no início e no fim, e com um só espaço entre as palavras. Vale para o painel e a API
administrativa, planilhas, busca externa, NFC-e e cadastro automático (`src/text.js`). Descrição e observações mantêm as quebras de linha, e cada
linha recebe o tratamento. Senhas e tokens não são alterados.

Os dados já gravados foram limpos uma vez, ao iniciar o serviço (`src/text-cleanup.js`). Cada valor antigo fica em `text_cleanup_log`, e o resumo em
`GET /api/admin/text-cleanup` (só administrador). Em campo de valor único, se a limpeza criaria duplicidade, o valor antigo foi mantido e registrado.
Ficaram de fora o login, as faturas e as estatísticas de consulta.

## Marcas e categorias

A tela **Marcas e categorias** (`/#/valores`, permissão "Produtos") lista as marcas, os fabricantes/laboratórios e as categorias em uso, com a quantidade de produtos de cada um. **Renomear** corrige a grafia em todos os produtos de uma vez; renomear para um valor que já existe junta os dois; deixar vazio tira o valor dos produtos. **Ver produtos** abre a planilha Nomes filtrada. Rotas: `GET /api/admin/field-values/:campo?q=&limit=&empty=1` e `POST /api/admin/field-values/:campo/rename` (`{ from, to }`). Os mesmos valores alimentam as sugestões dos campos Marca, Fabricante e Categoria no cadastro.

## Maiúsculas por palavra

Nome, marca, fabricante e categoria dos produtos ficam com a primeira letra de cada palavra maiúscula, em toda entrada de dados (painel, planilha Nomes, app, importação de planilha e de NFC-e, busca automática, edição em massa, renomear valores): "DIPIRONA SÓDICA 500MG C/10 CPR" vira "Dipirona Sódica 500mg C/10 CPR". Regras (`caseWords` em `src/text.js`): de, da, do, e, com, para... minúsculos no meio; número com unidade padronizado (500mg, 10ml, 1,5L, 200UI; "2X30UN" vira "2x30UN"); siglas curtas sem vogal (CX, PCT, CPR), siglas conhecidas (USB, UHT, EMS...), códigos com número (B12, 3M, C30) e algarismos romanos ficam maiúsculos. O nome provisório "PRODUTO NÃO CADASTRADO ..." fica como está. Unidade, SKU e descrição não mudam.

Os produtos já cadastrados foram convertidos uma vez, em segundo plano, ao subir a versão (`src/case-cleanup.js`, marca `migr_maiusculas_por_palavra` em settings); cada valor antigo está em `text_cleanup_log` com status `maiusculas`.

## Dicionário de correções

Tela **Dicionário** (`/#/dicionario`, permissão "Produtos"). Cada regra tem um campo (nome, marca, fabricante ou categoria), um trecho a procurar e o texto que entra no lugar (vazio tira o trecho). A procura vale em qualquer parte do texto, sem diferenciar maiúsculas; com **Só palavra inteira** marcado, o trecho só casa sozinho (antes e depois não pode haver letra nem número: "Gen" muda "C10 Gen" mas não "Sustagen" nem "Gengibre"). As regras ativas valem sozinhas em toda entrada de dados, depois das maiúsculas por palavra (`applyDictionary` em `src/text.js`): numa passada só, o trecho mais longo primeiro, sem trocar de novo o que já foi trocado ("Comp" → "Comprimidos" não repete em "Comprimidos").

Ao cadastrar ou editar uma regra, **Ver prévia** mostra os produtos atuais que mudariam (antes → depois). Daí: **Salvar e aplicar** (corrige esses produtos, sem renovar o prazo de atualização) ou **Só salvar** (vale daqui para frente). **Testar um texto** mostra como um nome fica com todas as regras. Como a procura é por trecho, confira a prévia: "Gen" → "Genérico" também muda "Gentamicina". Rotas em `/api/admin/dictionary` (`src/dictionary.js`).

## Nomes dos produtos (planilha)

A tela **Nomes** (`/#/nomes`, permissão "Produtos") mostra o catálogo como uma planilha. São editáveis Nome, Marca, Fabricante e Categoria (as três últimas sugerem os valores já cadastrados), e dá para filtrar por marca, fabricante e categoria (digite `(vazio)` para ver os produtos sem o valor); as alterações ficam
na tela, em amarelo, até **Salvar** (Ctrl+S). Salvar não renova o prazo de atualização do produto, nem o tira da lista de pendentes.

| Teclas | Ação |
|---|---|
| Clique no Nome, digitar, F2 ou duplo clique | edita a célula (o clique põe o cursor onde você clicou; digitar substitui; F2 mantém o texto) |
| Enter / Tab / Esc | confirma e desce / confirma e vai para a direita / cancela (editando, as setas para cima e para baixo confirmam e já editam a linha vizinha) |
| Setas, Page Up/Down, Ctrl+Home/End, Ctrl+setas | navegam |
| Shift+setas, arrastar, clicar no número da linha, Ctrl+A | selecionam |
| Ctrl+C / Ctrl+X / Ctrl+V | copiam, recortam e colam, inclusive do Excel |
| Ctrl+D / Delete | repete o nome de cima na seleção / limpa |
| Ctrl+Z / Ctrl+Y | desfazem e refazem o que ainda não foi salvo |

- Colar vale por posição, como no Excel: as linhas entram a partir da célula selecionada, na ordem atual da lista. Um valor só preenche toda a seleção.
- Duplo clique nas outras colunas abre o cadastro completo. Clicar no título da coluna ordena; arrastar a borda ajusta a largura.
- Nome vazio ou com mais de 300 caracteres fica em vermelho e impede a gravação.
- Se outra pessoa mudou o nome enquanto você editava, ele não é gravado e fica em laranja; salvar de novo confirma a sua versão.

Rotas: `GET /api/admin/product-names?q=&provisional=1&pending=1&inactive=1&sort=id|code|name|brand&dir=&offset=&limit=` e
`POST /api/admin/product-names` `{ items: [{ id, name, original }] }` (até 2.000 por chamada), que responde `{ saved, conflicts, missing }`.

## Cadastro do produto em abas

O **nome** fica no cabeçalho, sempre visível. O restante é dividido em abas:

| Aba | Conteúdo |
|-----|----------|
| Imagens | Envio, ordem, imagem principal e prazo das imagens |
| Códigos de barras | Um ou mais códigos por produto |
| Dados gerais | Marca, fabricante, categoria, SKU, unidade de medida, quantidade na embalagem, pesos (kg), medidas (cm), descrição e situação |
| Tributação | NCM, classificação, origem, tributação resultante por estado, exceção só do produto e observações |
| Medicamento | Princípios ativos (DCB) com concentração, registro no MS, tipo, tarja, controle especial, forma farmacêutica, classe terapêutica e apresentação |
| Links e histórico | Links para outros sistemas e histórico de mesclagens |

- Números aceitam vírgula, e NCM, CEST, CFOP e registro aceitam pontuação; tudo é gravado normalizado.
- Enviar, mover ou excluir imagens não apaga o que foi digitado e ainda não salvo nas outras abas.
- A API (`/api/v1/...`) devolve os campos novos, incluindo os de **tributação**, além de `is_medicine` e `actives`.
  A página pública e a consulta mostram os dados do medicamento, mas não os de tributação.
- A busca de produtos também encontra pelo princípio ativo.

## NCM e regras tributárias

Tela **NCM** (permissão "NCM e regras tributárias"). A tributação é configurada no NCM, e o produto a recebe ao ser vinculado.
Quem cadastra produtos consulta as opções, mas só quem tem a permissão altera NCM, regras e classificações.

- **NCM:** código, descrição, CEST e tributos federais padrão (IPI, PIS e COFINS).
- **Classificações tributárias:** nome, código interno, CST do IBS/CBS e cClassTrib. Servem para separar produtos do mesmo
  NCM com tributação diferente, como lista positiva/negativa, monofásico ou ST.
- **Regras do NCM:** por estado (ou todos) e por classificação (ou todas), com CFOP, CST/CSOSN, ICMS, redução da base, FCP,
  MVA, ICMS-ST e, se preciso, federais e IBS/CBS. Uma regra pode ser criada para vários estados de uma vez.
- **Produto:** na aba Tributação, escolha o NCM e a classificação. A tabela mostra, por estado, o valor de cada campo e de onde ele vem.
  Em massa: **Edição em massa** aceita NCM e classificação. Os filtros `no_ncm` e `ncm_unregistered` listam os que faltam.

**Como o valor é montado:** campo a campo, do mais geral para o mais específico; campo vazio herda do nível anterior, e `0` é um valor.

1. NCM
2. Classificação (campos da reforma)
3. Regra de todos os estados
4. Regra de todos os estados com a classificação
5. Regra do estado
6. Regra do estado com a classificação
7. Exceção do produto (vale em todos os estados)
8. Exceção do produto no estado (criada pela importação de NFC-e; pode ser removida na aba Tributação)

O estado de cada regra é um só: a regra não diferencia origem e destino nem operação interna e interestadual.

**Reforma tributária:** NCM, classificação, regra e exceção do produto têm CST do IBS/CBS, cClassTrib, IBS estadual, IBS municipal e CBS
com as reduções, além de CST, cClassTrib, alíquota e valor específico do IS. O valor é único por camada: não há vigência por data, e o IBS
municipal é guardado por estado, não por município.

**Importação de NFC-e** (Atualização > **Importar XML**; permissão "Atualização"): `.xml` soltos ou `.zip`, com prévia antes de gravar.

- Vale só NFC-e (modelo 65) de venda, autorizada (cStat 100 ou 150) e de produção. Os demais arquivos são contados por motivo. Cancelamento só
  exclui a nota que vier no mesmo envio.
- O estado é o do emitente. O produto é localizado pelo GTIN (`cEAN` ou `cEANTrib`); item sem GTIN válido fica de fora.
- De cada produto fica o dado da nota mais recente por estado e emitente; nota antiga não desfaz a recente. Entre emitentes vale a maioria.
- Em cada NCM + classificação + estado, o valor da maioria vai para a regra e quem difere recebe exceção no estado. Só o que as notas enviadas
  alcançam é alterado; outros NCMs e estados continuam como estão.
- O produto recebe NCM, CEST, origem, registro no MS, unidade e a marca de medicamento. O nome só muda se for o provisório.
- Tributos de IBS, CBS e IS vêm dos grupos `IBSCBS` e `IS`, quando existem. O XML e os dados do consumidor não são guardados.
- Opções: criar produtos novos (ligada), atualizar tributos diferentes (ligada), trocar NCM, CEST, origem e registro já preenchidos (desligada)
  e usar ICMS, PIS e COFINS de emitente do Simples (desligada; esses valores não servem de regra para os demais regimes).

Rotas: `POST /api/admin/xml-import/start` (multipart, campo `files`), `GET /api/admin/xml-import` (situação e prévia),
`POST /api/admin/xml-import/plan` (opções), `POST /api/admin/xml-import/apply` `{ id }`, `DELETE /api/admin/xml-import`;
`DELETE /api/admin/products/{id}/tax-uf/{uf}` remove a exceção no estado.

**Fontes oficiais para atualizar as listas:**
- NCM: tabela JSON do Siscomex (`portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json`).
- DCB: planilha "Lista consolidada das DCB" na Biblioteca Digital da Anvisa (coleção "Farmacopeia: Denominações Comuns Brasileiras").

**Importação por planilha** (aba **Importar planilha**; CSV ou XLSX, até 50 mil linhas, com prévia antes de gravar):

- **Cadastro de NCM:** colunas `ncm` e `descricao` (obrigatória nos novos), e opcionais `cest`, `cst_ipi`, `ipi`, `cst_pis`, `pis`,
  `cst_cofins`, `cofins` e `observacoes`. Linhas de capítulo ou posição (menos de 7 dígitos) são ignoradas. Regras por estado não são importadas.
- **Vínculo dos produtos:** colunas `codigo_barras` (ou `sku`) e ao menos uma destas: `ncm`, `classificacao` (nome ou código) e `origem` (0 a 8).
  - Produto não encontrado não é criado, e vincular não renova o prazo de atualização do cadastro.
  - Opções: vincular mesmo com NCM não cadastrado (ligada) e criar as classificações que faltam (desligada).
  - Vários códigos do mesmo produto na planilha são aceitos se os valores forem iguais; se forem diferentes, a linha dá erro.
- **Nas duas:**
  - célula vazia não apaga o valor atual;
  - títulos acima do cabeçalho são ignorados;
  - o botão "Baixar linhas com problema" gera um CSV com o motivo de cada linha;
  - zeros perdidos pelo Excel são recuperados em NCM, CEST, CST e código de barras;
  - valores em notação científica (`7,89E+12`) dão erro, porque os dígitos já se perderam: formate a coluna como texto e exporte de novo.
- **Permissão:** "NCM e regras tributárias".

Rotas: `POST /api/admin/ncm/import/preview` (multipart, campo `file`) e `/ncm/import/apply` `{ rows, update_existing }`;
`POST /api/admin/ncm/link/preview` (multipart: `file`, `create_classes`, `link_unregistered`) e `/ncm/link/apply` `{ rows, create_classes, link_unregistered }`.

**Rotas:**
- `GET /api/v1/products/{id}/tax?uf=SP` e `GET /api/v1/barcodes/{codigo}/tax?uf=SP` (públicas; não cadastram código desconhecido);
- `GET` / `POST /api/admin/ncm`, `GET` / `PUT` / `DELETE /api/admin/ncm/{id}`;
- `POST /api/admin/ncm/{id}/rules` `{ ufs: ["SP", "RJ"], class_id, ... }` (`ufs: [""]` = todos os estados), `PUT` / `DELETE /api/admin/ncm/rules/{id}`;
- `GET` / `POST /api/admin/tax-classes`, `PUT` / `DELETE /api/admin/tax-classes/{id}`;
- `POST /api/admin/tax/resolve` `{ ncm, tax_class_id, uf, overrides }`.

## DCB (princípios ativos)

Tela **DCB** (permissão "DCB"). Quem cadastra produtos pode escolher as opções, mas só quem tem a permissão altera a lista.

- **Medicamento com vários princípios ativos:** na aba Medicamento, digite parte do nome, o número ou o CAS (sem precisar
  de acento), escolha com clique ou Enter e repita. Cada um tem sua concentração.
- **Importação por arquivo:** CSV ou XLSX, com prévia antes de gravar.
  - Colunas: nome (`DCB`, `Denominação`, `Nome`...), `Número DCB` e `CAS` (estas duas opcionais). Títulos acima do cabeçalho são ignorados.
  - PDF e `.xls` antigo não são lidos: salve como `.xlsx` ou `.csv`.
  - Localiza pelo número e depois pelo nome (sem diferenciar acentos e maiúsculas). Célula vazia não apaga o valor atual.
  - Linhas com nome vazio ou repetido, ou em conflito com outro cadastro, são apontadas na prévia e não entram.
- **Exclusão:** uma DCB em uso não pode ser excluída; desative para tirá-la das opções.
- **Rotas:** `GET` / `POST /api/admin/dcb`, `PUT` / `DELETE /api/admin/dcb/{id}`, `POST /api/admin/dcb/import/preview`
  (multipart, campo `file`) e `POST /api/admin/dcb/import/apply` `{ rows, update_existing }`.
  Nos produtos, envie `dcb: [{ id, concentration }]`.

## Mesclagem de cadastros

No painel: **⇄ Mesclar cadastros**, clique nos itens **na ordem** e confirme. Via API:
`POST /api/admin/merge` com `{ "ids": [principal, outro1, outro2, ...] }`.

- O **primeiro** item mantém todos os seus dados (nome, SKU, descrição, marca, datas de cada campo...).
- Os **códigos de barras e imagens** dos demais são movidos para ele **com as mesmas datas de cadastro e
  atualização** (e os mesmos ids/arquivos); as imagens entram depois das do principal, na ordem de seleção.
- Imagem padrão de cadastro automático é descartada se o resultado tiver alguma foto real.
- Pendências (cadastro automático) dos agregados são marcadas como atualizadas, a menos que o principal também seja pendente.
- Os demais itens são removidos. Um retrato completo de cada um fica no histórico (`merges` no
  `GET /api/admin/products/{id}`), e seus links antigos (`/api/v1/products/{id}`, `/p/{id}`) redirecionam (301)
  para o principal, inclusive em mesclagens encadeadas.
- Não há desfazer.

## Cadastre-se

Na tela de login, **Cadastre-se** pede e-mail, senha e o CNPJ da empresa (`POST /api/auth/signup`). A conta é criada com o e-mail como login, **inativa e sem permissões**, ligada à empresa do CNPJ: se ela já está em Empresas, usa essa; se não, busca os dados na Receita e cria a empresa como **pendente** (sem chave de API e fora do faturamento). Quem tenta entrar antes da aprovação vê "Seu cadastro está aguardando a aprovação do administrador" (só com a senha certa). Em **Usuários**, os cadastros pendentes aparecem primeiro, com a empresa: abra, escolha os módulos, marque Ativo e salve. A empresa nova continua pendente até ser revisada em Empresas. Limites: 5 cadastros por hora por IP; e-mail repetido e CNPJ com dígito errado são recusados; empresa cancelada não aceita cadastro.

## Acesso: consulta pública e login com permissões

- **Consulta pública** (`/consulta/`): busca por código de barras, nome, marca ou categoria, sem login.
  Mostra só produtos ativos, não conta consumo, não cadastra códigos desconhecidos e aceita até 120 consultas por minuto por IP.
- **Painel** (`/`): exige **login e senha**. Cada usuário recebe permissões por módulo: Dashboard, Produtos, Atualização,
  Parâmetros, Empresas, Cobrança e Usuários. A opção "Administrador" libera todos os módulos.
  O servidor bloqueia (403) as rotas de módulos não liberados, não só os menus.
- **Primeiro acesso:** entre com o **token de administração** ("Entrar com o token de administração") e crie os usuários
  em **Usuários**. O token continua valendo como acesso total, e os scripts de implantação e verificação o usam.
- As senhas são guardadas com scrypt. A sessão dura 30 dias. Quem erra a senha 8 vezes em 15 minutos fica bloqueado
  por 15 minutos. Desativar um usuário ou trocar a senha dele encerra as sessões abertas.

## Empresas e cobrança

**Empresas:** ao digitar o CNPJ, o sistema valida os dígitos e busca os dados na Receita Federal pelas bases gratuitas,
nesta ordem: CNPJá público, BrasilAPI e ReceitaWS. Os dados trazidos são razão social, fantasia, situação, endereço,
CNAE, porte e contatos.
- **Inscrição estadual:** os Sintegras estaduais exigem captcha e não têm API pública. Sem configuração, a IE é
  preenchida à mão; o botão "Abrir Sintegra" leva ao site oficial. Com um token da API comercial do CNPJá
  (em Parâmetros), a IE vem automaticamente (consulta ao Sintegra/CCC).

**Consumo:** cada empresa recebe uma **chave de acesso** (`cat_...`), que é mostrada uma única vez. Os sistemas do cliente
enviam a chave em `?chave=` ou no header `X-Api-Key`, por exemplo:
`GET /api/v1/barcodes/7891234567895?chave=cat_...` ou `<img src="/img/7891234567895?chave=cat_...">`.
- Toda chamada a `/api/v1/...` e `/img/...` com chave conta 1 consulta para a empresa, por dia.
- Uma chave inválida recebe 401. Uma empresa suspensa ou cancelada recebe 403.
- Em Parâmetros, **"Exigir chave de acesso"** controla as chamadas sem chave:
  - desligado (padrão): a API continua aberta para elas;
  - ligado: só respondem as chamadas com a chave de uma empresa ativa.
- No Dashboard, a "conexão mais utilizada" passa a mostrar o nome da empresa quando há chave.

**Cobrança:**
- **Planos:** mensalidade, consultas incluídas no mês e valor por consulta excedente.
- **Valor da fatura:** mensalidade + (consultas acima das incluídas × valor por consulta extra).
- **Gerar faturas do mês:**
  - cria uma fatura por empresa ativa com plano;
  - grava os valores do plano como estavam no fechamento;
  - vence no dia escolhido do mês seguinte (limitado ao último dia do mês).
- **Mês corrente:** o mês corrente pode ser faturado de forma parcial, e as faturas abertas podem ser recalculadas.
- **Na fatura:** dá para dar desconto, registrar o pagamento, cancelar, reabrir e imprimir (ou salvar em PDF)
  o demonstrativo.
- **Restrições:** fatura paga não pode ser excluída, e empresa com faturas não pode ser excluída; use a situação
  "cancelada".

## API administrativa

Header `Authorization: Bearer <token>`. O token pode ser o token de administração ou o token de sessão devolvido por
`POST /api/auth/login` `{ login, password }`.

| Método e rota                                   | Corpo                                                    |
|-------------------------------------------------|----------------------------------------------------------|
| `GET /api/admin/products?q=&pending=1&overdue=1`| — (inclui inativos; filtros de pendentes e vencidos)     |
| `GET /api/admin/summary`                        | Totais: produtos, pendentes, vencidos                     |
| `GET /api/admin/dashboard`                      | Indicadores do dashboard                                  |
| `POST /api/admin/merge`                         | `{ ids: [principal, ...outros] }` — mescla cadastros       |
| `GET` / `PUT /api/admin/settings`               | Parâmetros (`{ prazo_cadastro_dias, prazo_imagens_dias }`) |
| `GET /api/admin/pending?status=pendente`        | Lista de códigos auto-cadastrados (`pendente`, `atualizado` ou todos) |
| `POST /api/admin/products/{id}/resolve`         | Marca o produto como atualizado (sai da lista)           |
| `POST /api/admin/products`                      | `{ name, sku, description, brand, category, unit, active, barcodes: [{ code, type?, note? }] }` |
| `PUT /api/admin/products/{id}`                  | Campos a alterar; se enviar `barcodes`, a lista é substituída |
| `DELETE /api/admin/products/{id}`               | Exclui o produto e as imagens                             |
| `POST /api/admin/products/{id}/barcodes`        | `{ code, type?, note? }`                                  |
| `DELETE /api/admin/barcodes/{id}`               | —                                                        |
| `POST /api/admin/products/{id}/images`          | `multipart/form-data`, campo `images` (vários arquivos)   |
| `PUT /api/admin/products/{id}/images/order`     | `{ ids: [...] }` — a primeira vira principal              |
| `DELETE /api/admin/images/{id}`                 | —                                                        |
| `GET /api/admin/cnpj/{cnpj}`                    | Dados do CNPJ (Receita; IE com token CNPJá)               |
| `GET` / `POST /api/admin/companies`, `GET` / `PUT` / `DELETE /api/admin/companies/{id}` | Empresas |
| `POST` / `DELETE /api/admin/companies/{id}/api-key` | Gera (mostra uma vez) / revoga a chave de acesso    |
| `GET` / `POST /api/admin/plans`, `PUT` / `DELETE /api/admin/plans/{id}` | Planos `{ name, monthly, included, extra_price, active }` |
| `GET /api/admin/billing?period=AAAA-MM`         | Consumo, estimativa e faturas do mês                      |
| `POST /api/admin/invoices/generate`             | `{ period, company_ids?, recalcular? }`                   |
| `GET` / `PUT` / `DELETE /api/admin/invoices/{id}` | `{ status: aberta\|paga\|cancelada, discount, notes }`  |
| `GET` / `POST /api/admin/users`, `PUT` / `DELETE /api/admin/users/{id}` | `{ name, login, password, permissions: [...], is_admin, active }` |
| `PUT /api/admin/me/password`                    | `{ password }` — troca a própria senha                    |

Regras:
- Um código de barras pertence a um único produto (409 se já estiver em uso).
- EAN-8, UPC-A, EAN-13 e DUN-14 têm o tipo detectado e o dígito verificador validado; outros códigos ficam como `OUTRO` (ou o tipo informado).
- Imagens: JPG, PNG, WEBP, GIF, AVIF, até 15 MB cada.

Exemplo de upload:

```bash
curl -H "Authorization: Bearer SEU_TOKEN" -F "images=@frente.jpg" -F "images=@verso.jpg" http://localhost:3000/api/admin/products/1/images
```
