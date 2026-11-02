#!/usr/bin/env bash
# Despliega (o actualiza) la ruta de Booking en la VM (V2.14). Se ejecuta desde la raíz del repositorio (Git Bash en Windows):
#   bash scripts/cloud/desplegar.sh <nombre DNS o IP de la VM> [usuario]
# SSH_PORT (por defecto 2222): la red de la PUCE bloquea el 22 de salida; la VM escucha también en el 2222 (solo desde la IP
# autorizada en el NSG).
# Copia solo lo que necesitan las imágenes (sin node_modules, dist ni secretos), sube infra/cloud/.env aparte por SSH y
# levanta todo con el override de la nube. Compila de a 2 imágenes a la vez para no agotar los 4 GB de la VM.
set -euo pipefail
HOST="${1:?uso: desplegar.sh <host> [usuario]}"
USER_NAME="${2:-azureuser}"
PORT="${SSH_PORT:-2222}"
[ -f infra/cloud/.env ] || { echo "Falta infra/cloud/.env: genérelo con scripts/cloud/generar-env.mjs"; exit 1; }

PACKAGE="$(mktemp -d)/reto2.tgz"
tar --force-local --exclude=node_modules --exclude=dist --exclude='*.tsbuildinfo' --exclude='.env' -czf "$PACKAGE" \
  package.json package-lock.json tsconfig.base.json packages services contract infra
echo "Paquete: $(du -h "$PACKAGE" | cut -f1)"

scp -P "$PORT" -o StrictHostKeyChecking=accept-new "$PACKAGE" "$USER_NAME@$HOST:reto2.tgz"
scp -P "$PORT" infra/cloud/.env "$USER_NAME@$HOST:reto2.env"
ssh -p "$PORT" "$USER_NAME@$HOST" 'set -e
  mkdir -p ~/reto2 && tar -xzf ~/reto2.tgz -C ~/reto2 && rm ~/reto2.tgz
  install -m 600 ~/reto2.env ~/reto2/infra/cloud/.env && rm ~/reto2.env
  cd ~/reto2/infra
  COMPOSE_PARALLEL_LIMIT=2 docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml --env-file cloud/.env build
  docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml --env-file cloud/.env up -d
  # La configuración se monta como archivo: al reemplazarlo, el contenedor sigue viendo el anterior (V2.20: el Collector siguió sin
  # enviar nada a Prometheus, Tempo ni Loki). Se recrean los que montan archivos (segundos).
  docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml --env-file cloud/.env up -d --no-deps --force-recreate \
    caddy otel-collector prometheus alertmanager loki tempo grafana
  docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml --env-file cloud/.env ps --format "{{.Service}}: {{.Status}}"'
