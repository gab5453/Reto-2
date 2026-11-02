#!/usr/bin/env bash
# Publica el horario y los precios en la nube (V2.14): ejecuta scripts/cloud/publicar-horario.mjs dentro del contenedor del ESB.
#   bash scripts/cloud/publicar-horario.sh <nombre DNS o IP de la VM> [usuario]      (SSH_PORT, por defecto 2222)
# La contraseña del administrador se lee en la VM (infra/cloud/.env): no viaja en la línea de comandos local.
set -euo pipefail
HOST="${1:?uso: publicar-horario.sh <host> [usuario]}"
USER_NAME="${2:-azureuser}"
ssh -p "${SSH_PORT:-2222}" "$USER_NAME@$HOST" 'cd ~/reto2/infra
  ADMIN_PASSWORD="$(grep "^ADMIN_PASSWORD=" cloud/.env | cut -d= -f2-)"
  docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml --env-file cloud/.env exec -T -e ADMIN_PASSWORD="$ADMIN_PASSWORD" esb node --input-type=module' < scripts/cloud/publicar-horario.mjs
