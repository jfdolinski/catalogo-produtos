#!/usr/bin/env bash
# Instala/atualiza o catálogo na VPS (executar como root). Chamado por deploy/publicar.ps1.
# Pacote extraído em $ORIGEM com: app/ (código) e, opcionalmente, data/ (banco, imagens, config).
# Os dados só são copiados se ainda não existirem na VPS, ou com FORCAR_DADOS=1 (faz backup antes).
set -euo pipefail

DOMINIO="${DOMINIO:-catalogo.b6nhiy.easypanel.host}"
PORTA="${PORTA:-8091}"
BIND="${BIND:-172.17.0.1}"          # gateway docker0: só o Traefik (e a própria VPS) alcançam
ORIGEM="${ORIGEM:-/tmp/catalogo-deploy}"
BASE=/opt/catalogo
TRAEFIK_DIR=/etc/easypanel/traefik/config

echo "== usuário e pastas"
id catalogo >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin catalogo
mkdir -p "$BASE"

echo "== código"
rm -rf "$BASE/app.new"
cp -a "$ORIGEM/app" "$BASE/app.new"
(cd "$BASE/app.new" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

echo "== dados"
if [ -d "$ORIGEM/data" ] && { [ ! -f "$BASE/data/catalogo.db" ] || [ "${FORCAR_DADOS:-0}" = 1 ]; }; then
  systemctl stop catalogo 2>/dev/null || true
  if [ -f "$BASE/data/catalogo.db" ]; then
    mv "$BASE/data" "$BASE/data.bak-$(date +%Y%m%d-%H%M%S)"
    echo "backup dos dados anteriores criado"
  fi
  rm -rf "$BASE/data"
  cp -a "$ORIGEM/data" "$BASE/data"
  echo "dados copiados do pacote"
else
  mkdir -p "$BASE/data"
  echo "dados existentes mantidos"
fi

echo "== troca de versão"
rm -rf "$BASE/app.old"
[ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.old"
mv "$BASE/app.new" "$BASE/app"
chown -R catalogo:catalogo "$BASE"
chmod 750 "$BASE/data"
[ -f "$BASE/data/config.json" ] && chmod 600 "$BASE/data/config.json"

echo "== serviço systemd"
cat > /etc/systemd/system/catalogo.service <<EOF
[Unit]
Description=Repositorio de imagens de produtos (catalogo)
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=catalogo
WorkingDirectory=$BASE/app
Environment=NODE_ENV=production
Environment=HOST=$BIND
Environment=PORT=$PORTA
Environment=DATA_DIR=$BASE/data
Environment=PUBLIC_BASE_URL=https://$DOMINIO
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $BASE/app/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable catalogo >/dev/null 2>&1
systemctl restart catalogo

echo "== rota no Traefik (arquivo próprio; o main.yaml do Easypanel não é alterado)"
# Gera em arquivo temporário e só substitui se mudou: regravar à toa faz o Traefik
# recarregar e responder 404 por alguns segundos
ROTA_TMP=$(mktemp)
cat > "$ROTA_TMP" <<EOF
http:
  routers:
    catalogo-http:
      rule: "Host(\`$DOMINIO\`)"
      entryPoints: [http]
      middlewares: [catalogo-https]
      service: catalogo
    catalogo-https:
      rule: "Host(\`$DOMINIO\`)"
      entryPoints: [https]
      service: catalogo
      tls:
        certResolver: letsencrypt
  middlewares:
    catalogo-https:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    catalogo:
      loadBalancer:
        servers:
          - url: "http://$BIND:$PORTA"
EOF
if cmp -s "$ROTA_TMP" "$TRAEFIK_DIR/catalogo.yaml"; then
  rm -f "$ROTA_TMP"
  echo "rota inalterada"
else
  chmod 644 "$ROTA_TMP"
  mv "$ROTA_TMP" "$TRAEFIK_DIR/catalogo.yaml" # mv é atômico: o Traefik nunca lê o arquivo pela metade
  echo "rota atualizada"
fi

echo "== verificação local"
for i in $(seq 1 20); do
  if curl -fsS "http://$BIND:$PORTA/api/v1/categories" >/dev/null 2>&1; then
    echo "serviço respondendo em $BIND:$PORTA"
    systemctl --no-pager --lines=0 status catalogo | head -3
    rm -rf "$ORIGEM"
    exit 0
  fi
  sleep 1
done
echo "ERRO: serviço não respondeu" >&2
journalctl -u catalogo --no-pager -n 30 >&2
exit 1
