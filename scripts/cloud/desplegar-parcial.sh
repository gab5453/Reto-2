#!/usr/bin/env bash
# Despliegue PARCIAL (10/11): compila solo los servicios indicados y recrea solo las piezas de configuración indicadas. El despliegue
# completo (desplegar.sh) recompila las 18 imágenes en la VM (4 GB) y la deja ~15–20 min degradada (503 para Booking); este, unos
# minutos. Se ejecuta desde la raíz del repositorio (Git Bash en Windows):
#   bash scripts/cloud/desplegar-parcial.sh <host> "<servicios a compilar>" ["<configuración a recrear>"]
# Ejemplo: bash scripts/cloud/desplegar-parcial.sh ecoairlines-reto2.northcentralus.cloudapp.azure.com "esb gateway" "tempo"
# Después de compilar, `up -d` recrea lo que cambió (imagen o compose); la configuración montada como archivo (tempo, caddy,
# otel-collector, prometheus, loki, grafana…) no se detecta sola: va en el tercer argumento.
set -euo pipefail
HOST="${1:?uso: desplegar-parcial.sh <host> \"<servicios>\" [\"<configuración>\"]}"
SERVICES="${2:-}"
CONFIG="${3:-}"
USER_NAME="${USER_NAME:-azureuser}"
PORT="${SSH_PORT:-2222}"
[ -f infra/cloud/.env ] || { echo "Falta infra/cloud/.env: genérelo con scripts/cloud/generar-env.mjs"; exit 1; }

PACKAGE="$(mktemp -d)/reto2.tgz"
tar --force-local --exclude=node_modules --exclude=dist --exclude='*.tsbuildinfo' --exclude='.env' -czf "$PACKAGE" \
  package.json package-lock.json tsconfig.base.json packages services contract infra
echo "Paquete: $(du -h "$PACKAGE" | cut -f1) · compilar: ${SERVICES:-(nada)} · recrear configuración: ${CONFIG:-(nada)}"

scp -P "$PORT" -o StrictHostKeyChecking=accept-new "$PACKAGE" "$USER_NAME@$HOST:reto2.tgz"
scp -P "$PORT" infra/cloud/.env "$USER_NAME@$HOST:reto2.env"
ssh -p "$PORT" "$USER_NAME@$HOST" "set -e
  mkdir -p ~/reto2 && tar -xzf ~/reto2.tgz -C ~/reto2 && rm ~/reto2.tgz
  install -m 600 ~/reto2.env ~/reto2/infra/cloud/.env && rm ~/reto2.env
  cd ~/reto2/infra
  C='docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml --env-file cloud/.env'
  date -u +'inicio %H:%M:%S UTC'
  if [ -n '$SERVICES' ]; then COMPOSE_PARALLEL_LIMIT=1 \$C build $SERVICES; fi
  if [ -n '$CONFIG' ]; then \$C up -d --no-deps --force-recreate $CONFIG; fi
  \$C up -d
  date -u +'fin %H:%M:%S UTC'
  \$C ps --format '{{.Service}}: {{.Status}}'"
