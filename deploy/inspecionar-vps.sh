#!/usr/bin/env bash
# Diagnóstico somente leitura da VPS (Easypanel/Traefik). Uso: ssh root@VPS 'bash -s' < deploy/inspecionar-vps.sh
c=$(docker ps -q -f name=easypanel-traefik)
echo "== args do traefik"
docker inspect "$c" --format '{{json .Args}}' | tr ',' '\n' | grep -iE 'provider|resolver|acme|entrypoint'
echo "== mounts do traefik"
docker inspect "$c" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}};{{end}}' | tr ';' '\n'
echo "== certResolvers usados"
grep -oE 'certResolver: *[A-Za-z_-]+' /etc/easypanel/traefik/config/main.yaml | sort | uniq -c
echo "== exemplo de router com https"
grep -nB12 -m1 'certResolver' /etc/easypanel/traefik/config/main.yaml
echo "== redes do traefik"
docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}};{{end}}' | tr ';' '\n'
echo "== urls de servicos"
grep -nE 'url: ' /etc/easypanel/traefik/config/main.yaml | head -5
echo "== catalogo instalado?"
systemctl is-active catalogo 2>/dev/null; ls /opt/catalogo 2>/dev/null
