# Troca para o Easypanel com PostgreSQL

Roteiro da troca do serviço antigo (`systemd` + SQLite em `/opt/catalogo`) pelo app do Easypanel com PostgreSQL.
Durante a troca o catálogo fica fora do ar por alguns minutos.

## 1. No Easypanel (você)

1. **Banco:** no projeto, *+ Service* → **Postgres**. Nome: `catalogo-db`. Guarde a **Internal Connection URL**
   (algo como `postgres://postgres:SENHA@projeto_catalogo-db:5432/projeto`).
2. **App:** *+ Service* → **App**. Nome: `catalogo`.
   - **Source:** GitHub, repositório `jfdolinski/catalogo-produtos`, branch `main`, **Build: Dockerfile**.
   - **Environment:**
     ```
     DATABASE_URL=<Internal Connection URL do passo 1>
     PUBLIC_BASE_URL=https://catalogo.b6nhiy.easypanel.host
     APP_TZ=America/Sao_Paulo
     MIGRAR_SQLITE=/app/data/catalogo.db
     ```
   - **Mounts:** *Bind mount*, caminho no servidor `/opt/catalogo/data`, no container `/app/data`.
     (São as imagens e o banco antigo de hoje; nada é copiado.)
   - **Domains:** ainda **não** configure o domínio (ele está com o serviço antigo).
   - **Deploy:** deixe **1 réplica** e desligue o "zero downtime", se aparecer: o app novo não pode subir antes de o antigo parar.
   - **Não clique em Deploy ainda.**
3. Me avise: eu faço o passo 2.

## 2. Na VPS (eu)

1. Paro o serviço antigo: `systemctl stop catalogo && systemctl disable catalogo` (ele continua instalado, para voltar atrás).
2. Removo a rota antiga do Traefik: `/etc/easypanel/traefik/config/catalogo.yaml` (guardo uma cópia em `/opt/catalogo/`).

## 3. No Easypanel (você)

1. No app `catalogo`, **Domains** → `catalogo.b6nhiy.easypanel.host`, porta **3000**, HTTPS.
2. **Deploy**. Nos logs aparece `Migrando os dados de /app/data/catalogo.db para o PostgreSQL...`, a contagem de cada tabela
   e `Migração concluída`.
3. Remova a variável `MIGRAR_SQLITE` (ela não roda de novo com o banco cheio, mas não precisa ficar).

## 4. Conferência (eu)

`node deploy/verificar.mjs` e comparação das contagens com o banco antigo.

## Voltar atrás

Se algo der errado antes de entrarem dados novos no PostgreSQL: pare o app `catalogo` no Easypanel, tire o domínio dele,
e na VPS `cp /opt/catalogo/catalogo.yaml /etc/easypanel/traefik/config/ && systemctl enable --now catalogo`.
O arquivo SQLite não é apagado; a migração só guarda uma cópia dele antes de ler (`catalogo.db.antes-postgres-<data>`).
