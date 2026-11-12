#!/usr/bin/env bash
# CD-1 (Informacion_General/Pruebas.md §10, opción B): despliega en la VM una versión EXACTA con las imágenes que compiló GitHub
# Actions (imagenes-v2.yml, solo después de una CI en verde). La VM no compila: descarga y recrea (`pull` + `up -d`), unos
# minutos en lugar de los ~15–20 de compilar las 18 imágenes. Al final corre la prueba de humo (solo lectura).
# Se ejecuta desde la raíz del repositorio (Git Bash en Windows):
#   bash scripts/cloud/desplegar-imagenes.sh <host> <commit>            p. ej. ... ecoairlines-reto2.northcentralus.cloudapp.azure.com 4452135
# Volver a la versión anterior = desplegar su commit. Lo ejecuta el responsable (aprobación manual del despliegue).
set -euo pipefail
HOST="${1:?uso: desplegar-imagenes.sh <host> <commit>}"
COMMIT="${2:?uso: desplegar-imagenes.sh <host> <commit>}"
USER_NAME="${USER_NAME:-azureuser}"
PORT="${SSH_PORT:-2222}"
OWNER="${GHCR_OWNER:-gab5453}"
[ -f infra/cloud/.env ] || { echo "Falta infra/cloud/.env: genérelo con scripts/cloud/generar-env.mjs"; exit 1; }

# Las etiquetas usan el sha completo.
SHA="$(git rev-parse --verify "$COMMIT^{commit}")"
echo "Versión: $SHA ($(git log -1 --format=%s "$SHA"))"

# Antes de tocar la VM: ¿están las 18 imágenes de ese commit? (si la CI o imagenes-v2 no terminaron, aquí se detiene).
SERVICIOS="esb gateway payment-api booking-simulado ms-g-identity ms-g-schedule ms-g-offers ms-g-bookings ms-g-check-in ms-g-post-sale ms-g-flight-status ms-g-webhooks ms-g-customers ms-vuelos ms-reservas ms-postventa ms-clientes ms-admin"
faltan=""
for s in $SERVICIOS; do
  docker manifest inspect "ghcr.io/$OWNER/ecoairlines-$s:$SHA-arm64" >/dev/null 2>&1 || faltan="$faltan $s"
done
if [ -n "$faltan" ]; then
  echo "No están en ghcr.io las imágenes de ese commit:$faltan"
  echo "¿Terminó la CI en verde y el flujo «Imágenes v2»? ¿Son públicos los paquetes (o hay docker login en la VM)?"
  exit 1
fi

# Solo la configuración (infra/): el código ya va dentro de las imágenes.
PACKAGE="$(mktemp -d)/infra.tgz"
tar --force-local --exclude='.env' -czf "$PACKAGE" infra
scp -P "$PORT" -o StrictHostKeyChecking=accept-new "$PACKAGE" "$USER_NAME@$HOST:infra.tgz"
scp -P "$PORT" infra/cloud/.env "$USER_NAME@$HOST:reto2.env"
ssh -p "$PORT" "$USER_NAME@$HOST" "set -e
  mkdir -p ~/reto2 && tar -xzf ~/infra.tgz -C ~/reto2 && rm ~/infra.tgz
  install -m 600 ~/reto2.env ~/reto2/infra/cloud/.env && rm ~/reto2.env
  cd ~/reto2/infra
  export IMAGE_TAG='$SHA' GHCR_OWNER='$OWNER'
  C='docker compose -f docker-compose.yml -f cloud/docker-compose.cloud.yml -f cloud/docker-compose.imagenes.yml --env-file cloud/.env'
  date -u +'inicio %H:%M:%S UTC'
  # Disco (30 GB): la caché de compilación de los despliegues anteriores (~10 GB) ya no sirve, porque la VM no compila. Y hacen
  # falta ~6 GB libres para descargar las imágenes nuevas mientras las actuales siguen corriendo.
  docker builder prune -af >/dev/null
  libre=\$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
  echo \"Disco libre: \${libre} GB\"
  if [ \"\$libre\" -lt 7 ]; then echo 'Menos de 7 GB libres: no se descarga (se llenaría el disco a la mitad).'; exit 1; fi
  \$C pull --quiet
  \$C up -d --no-build
  echo '$SHA' > ~/reto2/VERSION
  # Las imágenes que ningún contenedor usa (las de la versión anterior o las compiladas en la VM) se borran: volver atrás es
  # descargar la versión anterior de ghcr.io.
  docker image prune -af >/dev/null || true
  date -u +'fin %H:%M:%S UTC'
  \$C ps --format '{{.Service}}: {{.Status}}'"

node scripts/cloud/humo.mjs "https://$HOST"
