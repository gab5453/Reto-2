# Guía general · Desplegar los microservicios en una sola App Service

| | |
|---|---|
| Objetivo | Publicar todos los microservicios (Gateway, ESB, GraphQL, Partner API y servicios `ms-*`) en **una** App Service Linux B1 |
| Motivo | Una app por servicio agota la memoria del plan y los despliegues se cuelgan (Kudu en 503) |
| Qué no cambia | Cada servicio sigue siendo un proceso con su base, su puerto y su contrato; solo comparten contenedor |
| Dónde se ejecuta | **Azure Cloud Shell (Bash)**: ya trae `az`, `gh`, `node`, `jq` y `openssl` con tu sesión iniciada |

> Todo lo que aparece entre `<...>` lo defines tú. Los pasos explican cómo generarlo o dónde encontrarlo.
> **No** escribas contraseñas, claves ni URL con credenciales en archivos del repositorio.

---

## Paso 0 · Definir los nombres del despliegue

Abre Cloud Shell (portal de Azure → icono `>_` → **Bash**) y define estas variables. Se usan en todos los pasos; si cierras la
sesión, vuelve a pegarlas.

```bash
RG=<grupo-de-recursos>            # p. ej. rg-<equipo>
REGION=<region-app>               # región con cuota para App Service (ver Paso 1.2)
DB_REGION=<region-base>           # puede ser la misma que REGION
PLAN=<plan-app-service>           # p. ej. asp-<equipo>-b1
APP=<nombre-app>                  # único en todo Azure: la URL será https://<nombre-app>.azurewebsites.net
DB_SERVER=<servidor-postgres>     # único en todo Azure: <servidor-postgres>.postgres.database.azure.com
DB_ADMIN=<usuario-admin-base>     # no puede ser admin, postgres, root ni azure_superuser
REPO=<usuario-github>/<repositorio>
PREFIX=<prefijo-equipo>           # en minúsculas; prefijo de las colas y claves en RabbitMQ
```

**Reglas de nombres:** solo minúsculas, números y guiones. Para saber si un nombre de app está libre:

```bash
az webapp list --query "[?name=='$APP']" -o tsv; curl -s -o /dev/null -w '%{http_code}\n' https://$APP.azurewebsites.net
```

Si `curl` devuelve `000` o error de DNS, el nombre está libre.

---

## Parte 1 · Borrar un despliegue anterior (solo si existe)

Sáltala si es el primer despliegue. **Nunca borres el grupo completo** si la base de datos está dentro: se borra recurso por
recurso.

**1.1 Ver qué hay en el grupo**

```bash
az resource list -g $RG --query "[].{nombre:name, tipo:type, region:location}" -o table
```

**1.2 Detener los despliegues automáticos viejos** (si no, cada `push` intenta publicar en apps que ya no existen)

```bash
gh auth status || gh auth login
gh workflow list -R $REPO                       # busca el nombre del workflow viejo
for id in $(gh run list -R $REPO -s in_progress --json databaseId -q '.[].databaseId'); do gh run cancel $id -R $REPO; done
gh workflow disable <archivo-workflow-viejo>.yml -R $REPO
```

**1.3 Borrar las apps y el plan viejos**

```bash
az webapp list -g $RG --query "[].name" -o tsv      # revisa la lista antes de borrar
for app in $(az webapp list -g $RG --query "[].name" -o tsv); do
  az webapp delete -g $RG -n $app --keep-empty-plan && echo "borrada $app"
done
az appservice plan list -g $RG --query "[].name" -o tsv
az appservice plan delete -g $RG -n <plan-viejo> -y
```

**1.4 Borrar máquinas virtuales y lo que crearon con ellas** (disco, interfaz de red, IP pública, grupo de seguridad, red virtual)

```bash
az vm list -g $RG --query "[].name" -o tsv
az vm delete -g $RG -n <nombre-vm> -y
for tipo in Microsoft.Compute/disks Microsoft.Network/networkInterfaces Microsoft.Network/publicIPAddresses Microsoft.Network/networkSecurityGroups Microsoft.Network/virtualNetworks Microsoft.Compute/sshPublicKeys; do
  for id in $(az resource list -g $RG --resource-type $tipo --query "[].id" -o tsv); do
    az resource delete --ids $id && echo "borrado $(basename $id)"
  done
done
```

**1.5 Borrar otros grupos que ya no se usan.** Antes, confirma que no tengan un servidor PostgreSQL:

```bash
az resource list -g <otro-grupo> --query "[].{nombre:name, tipo:type}" -o table
# Si NO aparece Microsoft.DBforPostgreSQL/flexibleServers:
az group delete -n <otro-grupo> -y --no-wait
```

**1.6 Limpiar secretos viejos de GitHub**

```bash
gh secret list -R $REPO
gh variable list -R $REPO
gh secret delete <SECRETO_VIEJO> -R $REPO        # repite por cada secreto que ya no sirva
```

---

## Parte 2 · Qué debe tener el repositorio

Cada servicio es un **proceso Node independiente**. Los procesos corren dentro del **mismo contenedor**: un lanzador los arranca,
les da su puerto y su base, y reinicia el que se caiga. Solo el Gateway queda expuesto a internet; los demás se hablan por
`localhost`.

```
App Service: <nombre-app> (B1)
└─ lanzador (node tools/launcher.mjs)
   ├─ gateway        :$PORT  ← único puerto público
   ├─ partner-api, graphql, esb   (puertos locales)
   └─ servicios ms-*              (un puerto local cada uno)
```

Antes de desplegar, revisa que el repositorio tenga:

- [ ] **Lanzador** `tools/launcher.mjs`: arranca cada `main.js` con su puerto; arma la URL de cada base a partir de
      `DATABASE_SERVER_URL`; reinicia procesos caídos; arranca el Gateway al final; limita memoria por proceso.
- [ ] **Identidad del nodo** (`NODE_ID` y `NODE_CODE` de la Partner API): **los asigna Booking** al registrar el nodo. Búscalos
      en la ficha o el correo de registro y colócalos en el lanzador:
      ```bash
      grep -n "NODE_ID\|NODE_CODE" tools/launcher.mjs
      ```
- [ ] **Empaquetado** `tools/package-microservices.mjs`: genera un solo `.zip` con todo lo compilado y el lanzador.
- [ ] **Workflow** `.github/workflows/deploy-azure.yml`: compila, empaqueta y publica una vez en `<nombre-app>` usando el secreto
      `AZURE_WEBAPP_PUBLISH_PROFILE`. Revisa que el campo `app-name` coincida con tu `$APP`:
      ```bash
      grep -n "app-name" .github/workflows/deploy-azure.yml
      ```
- [ ] **Script de configuración** `tools/azure-configurar-app-unica.sh` (opcional): si lo usas, edita las variables de las
      primeras líneas (`RG`, `PLAN`, `APP`, `REGION`, `DB_HOST`, `ADMIN`, `RABBIT`, `WEB`) con tus valores. Si no, usa los
      comandos del Paso 4.

---

## Parte 3 · Preparar Azure

### Paso 1 · Suscripción, proveedores y región

**1.1 Comprobar la suscripción**

```bash
az account show --query "{suscripcion:name, estado:state, id:id}" -o table
az account list -o table                        # si tienes varias
az account set --subscription "<nombre-o-id>"
```

**1.2 Registrar proveedores y elegir región**

```bash
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.DBforPostgreSQL
az provider show -n Microsoft.Web --query registrationState -o tsv     # debe decir Registered
```

Las suscripciones de estudiante solo permiten algunas regiones. Para ver cuáles aceptan App Service:

```bash
az appservice list-locations --sku B1 --linux-workers-enabled -o table
```

Si al crear el plan aparece un error de cuota (`quota` o `SubscriptionIsOverQuotaForSku`), prueba otra región de esa lista.

**1.3 Crear el grupo de recursos** (si no existe)

```bash
az group create -n $RG -l $REGION
```

### Paso 2 · Base de datos PostgreSQL

Sáltalo si ya tienes un servidor PostgreSQL Flexible con las bases creadas; solo enciéndelo:

```bash
az postgres flexible-server start -g $RG -n $DB_SERVER
```

**2.1 Generar la contraseña del administrador** (sin caracteres especiales para no tener que codificarla en la URL):

```bash
DB_PASS=$(openssl rand -hex 24); echo "Contraseña de la base: $DB_PASS"
```

Guárdala en un gestor de contraseñas: se usa en el Paso 4 y en el Paso 7.

**2.2 Crear el servidor** (B1ms, el más barato con 50 conexiones):

```bash
az postgres flexible-server create -g $RG -n $DB_SERVER -l $DB_REGION \
  --admin-user $DB_ADMIN --admin-password "$DB_PASS" \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
  --public-access 0.0.0.0 --yes
```

`--public-access 0.0.0.0` permite el acceso desde servicios de Azure (la App Service y Cloud Shell).

**2.3 Permitir tu IP** (si vas a conectarte desde tu PC):

```bash
MI_IP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create -g $RG -n $DB_SERVER -r mi-pc --start-ip-address $MI_IP --end-ip-address $MI_IP
```

**2.4 Crear las bases y aplicar migraciones.** Cada servicio usa su propia base (`ms_identity`, `ms_catalog`, …). Las migraciones
también se aplican solas al arrancar, pero conviene crearlas antes:

```bash
gh repo clone $REPO ~/repo 2>/dev/null || (cd ~/repo && git pull -q)
cd ~/repo && npm ci --silent && npm run build
SERVICES_DATABASE_URL="postgres://$DB_ADMIN:$DB_PASS@$DB_SERVER.postgres.database.azure.com:5432/" DATABASE_SSL=true \
node tools/migrate-services.mjs
```

Debe mostrar una línea por servicio con `Base de datos ms_... creada` o las migraciones aplicadas.

**2.5 Recuperar el host o la contraseña más tarde**

- Host: `az postgres flexible-server show -g $RG -n $DB_SERVER --query fullyQualifiedDomainName -o tsv`
- Contraseña olvidada: `az postgres flexible-server update -g $RG -n $DB_SERVER --admin-password "<nueva>"` (y actualiza la
  variable `DATABASE_SERVER_URL` de la app).

### Paso 3 · Generar secretos y obtener credenciales

**3.1 Los 5 secretos internos** (deben tener **al menos 32 caracteres**; los servicios no arrancan si son más cortos):

```bash
INTERNAL_TOKEN_SECRET=$(openssl rand -hex 32)
SERVICE_TOKEN=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)
VOUCHER_SECRET=$(openssl rand -hex 32)
printf '%s\n' "INTERNAL_TOKEN_SECRET=$INTERNAL_TOKEN_SECRET" "SERVICE_TOKEN=$SERVICE_TOKEN" "JWT_SECRET=$JWT_SECRET" \
  "WEBHOOK_SECRET=$WEBHOOK_SECRET" "VOUCHER_SECRET=$VOUCHER_SECRET"
```

| Secreto | Para qué sirve |
|---|---|
| `INTERNAL_TOKEN_SECRET` | Firma de las llamadas internas entre servicios |
| `SERVICE_TOKEN` | Token de servicio que valida el ESB |
| `JWT_SECRET` | Firma de los tokens de sesión de usuarios |
| `WEBHOOK_SECRET` | Firma de los webhooks de la pasarela de pago |
| `VOUCHER_SECRET` | Firma de los vouchers de reserva |

Guárdalos en un gestor de contraseñas. **Si los cambias después, se invalidan las sesiones y vouchers emitidos.**

Si ya están configurados en una app existente, se leen así:

```bash
az webapp config appsettings list -g $RG -n $APP --query "[?ends_with(name,'SECRET') || name=='SERVICE_TOKEN'].{n:name,v:value}" -o table
```

**3.2 URL del broker RabbitMQ (`RABBITMQ_URL`)**

- **Broker central de la clase:** la URL `amqps://usuario:clave@host/vhost` la entrega el coordinador de Booking. Búscala en el
  canal o documento de integración.
- **Instancia propia (CloudAMQP):** en [customer.cloudamqp.com](https://customer.cloudamqp.com) → **Create new instance** → plan
  *Little Lemur* (gratis) → abre la instancia → **AMQP details → URL**. Usa la que empieza por `amqps://`.

**3.3 X-API-Key para Booking (`BOOKING_API_KEY`)**

Es la clave que identifica a Booking ante tu Partner API y la que tu nodo envía al reportar stock. Se emite **una sola vez** con
la base `ms_identity` ya migrada:

```bash
cd ~/repo
DATABASE_URL="postgres://$DB_ADMIN:$DB_PASS@$DB_SERVER.postgres.database.azure.com:5432/ms_identity" DATABASE_SSL=true \
node tools/create-api-key.mjs --codigo BOOKING_PROTOTIPO --nombre "Booking Prototipo"
```

Copia la clave que muestra: **no se puede volver a ver** (en la base solo queda su hash). Envíala a Booking por un canal privado,
en la ficha de registro del nodo. Si la pierdes, emite una nueva y avisa a Booking.

**3.4 Administrador del sistema**

Se crea una sola vez (solo funciona si aún no hay ningún ADMIN). Elige un correo y genera la contraseña:

```bash
ADMIN_PASSWORD=$(openssl rand -base64 18); echo "Contraseña ADMIN: $ADMIN_PASSWORD"
ADMIN_EMAIL=<correo-admin> ADMIN_PASSWORD="$ADMIN_PASSWORD" \
DATABASE_URL="postgres://$DB_ADMIN:$DB_PASS@$DB_SERVER.postgres.database.azure.com:5432/ms_identity" DATABASE_SSL=true \
node tools/create-admin.mjs
```

**3.5 URL del portal web (`PORTAL_URL` y `CORS_ORIGINS`)**

Si el portal está en una Static Web App:

```bash
az staticwebapp list --query "[].{nombre:name, url:defaultHostname}" -o table
WEB=https://$(az staticwebapp show -n <nombre-static-web-app> --query defaultHostname -o tsv); echo $WEB
```

Si no tienes portal todavía, usa `WEB=https://$APP.azurewebsites.net` y actualízalo después.

### Paso 4 · Crear y configurar la App Service

**4.1 Crear el plan B1 y la app**

```bash
az appservice plan create -g $RG -n $PLAN --is-linux --sku B1 -l $REGION
az webapp create -g $RG -p $PLAN -n $APP --runtime "NODE:22-lts"
```

**4.2 Configuración general** (HTTPS obligatorio, TLS 1.2, Always On, comando de inicio y comprobación de estado):

```bash
az webapp update -g $RG -n $APP --https-only true --output none
az webapp config set -g $RG -n $APP --always-on true --min-tls-version 1.2 --startup-file "node tools/launcher.mjs" \
  --generic-configurations '{"healthCheckPath": "/health"}' --output none
```

**4.3 Habilitar la publicación básica (SCM)**, necesaria para descargar el perfil de publicación:

```bash
az resource update --ids "$(az webapp show -g $RG -n $APP --query id -o tsv)/basicPublishingCredentialsPolicies/scm" \
  --set properties.allow=true --output none
```

En el portal: app → **Configuración → Configuración general → Credenciales de publicación básica de SCM → Activado**.

**4.4 Variables de entorno.** Necesitas en la sesión `DB_PASS`, los 5 secretos, `WEB`, y además:

```bash
RABBIT='<URL amqps del Paso 3.2>'
BOOKING_KEY='<X-API-Key del Paso 3.3>'
```

```bash
az webapp config appsettings set -g $RG -n $APP --output none --settings \
  "DATABASE_SERVER_URL=postgres://$DB_ADMIN:$DB_PASS@$DB_SERVER.postgres.database.azure.com:5432" DATABASE_SSL=true DB_POOL_MAX=2 \
  "RABBITMQ_URL=$RABBIT" RABBITMQ_EXCHANGE=booking.events "RABBITMQ_PREFIX=$PREFIX" \
  "BOOKING_REST_STOCK_URL=https://booking-puce.eastus.cloudapp.azure.com/api/v3/inventory/stock" \
  "BOOKING_GRPC_URL=booking-puce.eastus.cloudapp.azure.com:50051" "BOOKING_API_KEY=$BOOKING_KEY" \
  "INTERNAL_TOKEN_SECRET=$INTERNAL_TOKEN_SECRET" "SERVICE_TOKEN=$SERVICE_TOKEN" "JWT_SECRET=$JWT_SECRET" \
  "WEBHOOK_SECRET=$WEBHOOK_SECRET" "VOUCHER_SECRET=$VOUCHER_SECRET" \
  "PORTAL_URL=$WEB" "CORS_ORIGINS=$WEB" "PUBLIC_BASE_URL=https://$APP.azurewebsites.net/api/v3" \
  ESB_TIMEOUT_FACTOR=1 HEALTH_TIMEOUT_MS=4000 HEALTH_UP_MS=1500 HEALTH_DOWN_MS=4500 HEALTH_CACHE_MS=10000 \
  NODE_ENV=production SCM_DO_BUILD_DURING_DEPLOYMENT=false WEBSITES_CONTAINER_START_TIME_LIMIT=600 \
  && echo "OK variables de entorno"
```

| Variable | Valor | De dónde sale |
|---|---|---|
| `DATABASE_SERVER_URL` | `postgres://<usuario>:<contraseña>@<servidor>.postgres.database.azure.com:5432` | Paso 2. **Sin** nombre de base: el lanzador agrega `/ms_*` |
| `DATABASE_SSL` | `true` | Azure PostgreSQL exige TLS |
| `DB_POOL_MAX` | `2` | Conexiones por servicio; servicios × 2 debe quedar bajo 50 (B1ms) |
| `RABBITMQ_URL` | `amqps://...` | Paso 3.2 |
| `RABBITMQ_EXCHANGE` | `booking.events` | Exchange de Booking |
| `RABBITMQ_PREFIX` | Tu prefijo | Paso 0; tus colas y claves serán `<prefijo>.*` |
| `BOOKING_REST_STOCK_URL` | `https://booking-puce.eastus.cloudapp.azure.com/api/v3/inventory/stock` | Envío de stock a Booking por REST |
| `BOOKING_GRPC_URL` | `booking-puce.eastus.cloudapp.azure.com:50051` | Informativo: el stock va por REST |
| `BOOKING_API_KEY` | La X-API-Key | Paso 3.3 |
| Los 5 secretos | 64 caracteres hex | Paso 3.1 |
| `PORTAL_URL`, `CORS_ORIGINS` | URL del portal | Paso 3.5 |
| `PUBLIC_BASE_URL` | `https://<nombre-app>.azurewebsites.net/api/v3` | Paso 0 |
| `ESB_TIMEOUT_FACTOR` | `1`; usa `3` si la base está en otra región que la app | Plazos del ESB |
| `HEALTH_*` | `4000`, `1500`, `4500`, `10000` | Semáforo de salud para Booking |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` | El código llega compilado |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `600` | Margen para arrancar todos los procesos |

**4.5 Comprobar**

```bash
az appservice plan show -g $RG -n $PLAN --query "{plan:name, sku:sku.name, region:location}" -o table
az webapp show -g $RG -n $APP --query "{app:name, estado:state, httpsOnly:httpsOnly, dominio:defaultHostName}" -o table
az webapp config show -g $RG -n $APP --query "{alwaysOn:alwaysOn, tls:minTlsVersion, inicio:appCommandLine, health:healthCheckPath}" -o table
```

Debe mostrar `B1`, tu región, `Running`, `True`, `1.2`, `node tools/launcher.mjs` y `/health`.

### Paso 5 · Publicar el código con GitHub Actions

**5.1 Guardar el perfil de publicación en GitHub**

```bash
gh auth status || gh auth login
az webapp deployment list-publishing-profiles -g $RG -n $APP --xml | gh secret set AZURE_WEBAPP_PUBLISH_PROFILE -R $REPO
gh secret list -R $REPO | grep AZURE_WEBAPP_PUBLISH_PROFILE
```

Si `list-publishing-profiles` falla, falta el Paso 4.3. Alternativa manual: portal → app → **Información general → Descargar
perfil de publicación**, y pega el contenido del `.PublishSettings` en GitHub → repositorio → **Settings → Secrets and variables
→ Actions → New repository secret** con el nombre `AZURE_WEBAPP_PUBLISH_PROFILE`.

Si cambias el nombre de la app o la vuelves a crear, **repite este paso**: el perfil anterior deja de servir.

**5.2 Lanzar el despliegue y seguirlo**

```bash
gh workflow enable deploy-azure.yml -R $REPO
gh workflow run deploy-azure.yml -R $REPO
sleep 20
gh run watch -R $REPO
```

Debe terminar con `completed with 'success'`. Mientras corre, **no cambies la configuración de la app**: reiniciarla corta la
subida.

**5.3 Si falla**

```bash
gh run view -R $REPO --log-failed | grep -E "##\[error\]" | head -10
```

### Paso 6 · Comprobar que todo arrancó

**6.1 Esperar el arranque** (1–3 minutos):

```bash
sleep 120
az webapp show -g $RG -n $APP --query state -o tsv
```

**6.2 Probar las rutas públicas**

```bash
G=https://$APP.azurewebsites.net
for p in /health /api/v3/health /api/v3/atracciones/health /api/v3/atracciones; do
  echo "== $p"; curl -s -m 120 -w '\nHTTP %{http_code}\n' "$G$p" | tail -c 400
done
```

| Ruta | Resultado esperado |
|---|---|
| `/health` | `HTTP 200`, `{"status":"UP","service":"gateway"}` |
| `/api/v3/health` y `/api/v3/atracciones/health` | `HTTP 200`, `status` `UP` o `DEGRADED`, `database_connected: true` |
| `/api/v3/atracciones` | `HTTP 200`, un arreglo (vacío `[]` hasta el Paso 7) |

**6.3 Si alguna falla**, ver qué proceso no arrancó:

```bash
az webapp log config -g $RG -n $APP --docker-container-logging filesystem --output none
az webapp log download -g $RG -n $APP --log-file app.zip
unzip -p app.zip $(unzip -l app.zip | grep -oE "LogFiles/[^ ]*default_docker\.log" | sort | tail -1) | grep -aiE "error|reinicia|exit" | tail -20
```

Cada línea empieza con el nombre del servicio (`[ms-catalog]`, `[esb]`…). Errores típicos:

| Mensaje | Causa |
|---|---|
| `password authentication failed` | Contraseña mal escrita en `DATABASE_SERVER_URL` |
| `no pg_hba.conf entry` / `timeout` a la base | Falta la regla de firewall `0.0.0.0` (Paso 2.2) o la base está detenida |
| `debe tener al menos 32 caracteres` | Un secreto del Paso 3.1 es demasiado corto |
| `ACCESS_REFUSED` en RabbitMQ | `RABBITMQ_URL` incorrecta o vhost equivocado |

### Paso 7 · Cargar el catálogo

```bash
cd ~/repo && git pull -q && npm ci --silent
GATEWAY_URL=https://$APP.azurewebsites.net \
LOCATION_DATABASE_URL="postgres://$DB_ADMIN:$DB_PASS@$DB_SERVER.postgres.database.azure.com:5432/ms_location" \
node tools/seed-atracciones.mjs
```

Pide el correo y la contraseña del ADMIN (Paso 3.4). Se puede repetir: lo que ya existe se omite. Comprobar:

```bash
curl -s -m 120 https://$APP.azurewebsites.net/api/v3/atracciones | jq 'length, .[0]'
```

### Paso 8 · Reporte a Booking

**8.1 Obtener los datos**

```bash
G=https://$APP.azurewebsites.net/api/v3
echo "Cantidad: $(curl -s -m 120 $G/atracciones | jq length)"
ID=$(curl -s -m 120 $G/atracciones | jq -r '.[0].id'); echo "ID: $ID"
F=$(date -d '+3 days' +%F)
curl -s -m 120 "$G/atracciones/$ID/disponibilidad?date=$F" | jq -r --arg f "$F" '"Fecha: \($f)  Turno: \(.time_slots[0].slot_id)  Hora: \(.time_slots[0].time)"'
```

**8.2 Completar y enviar al coordinador de Booking**

```
📋 REPORTE DE RESOLUCIÓN - <EQUIPO> (<NODE_CODE>)
1. Atracciones en GET /api/v3/atracciones: <Cantidad>
2. POST /api/v3/atracciones/reservas acepta atraccion_id o attraction_id con Idempotency-Key: SÍ
3. Broker conectado (exchange booking.events, claves <prefijo>.booking.*): SÍ
4. Atracción de prueba: <ID> · <Fecha> · <Turno y hora>
URL base: https://<nombre-app>.azurewebsites.net/api/v3
Health:   https://<nombre-app>.azurewebsites.net/api/v3/atracciones/health
```

La X-API-Key **no** va en el reporte: se envía aparte por un canal privado.

### Paso 9 · Vigilar la memoria del plan

```bash
az monitor metrics list --resource $(az appservice plan show -g $RG -n $PLAN --query id -o tsv) \
  --metric MemoryPercentage --interval PT5M --query "value[0].timeseries[0].data[-12:].average" -o tsv
```

| Memoria sostenida | Qué hacer |
|---|---|
| Menos de 80 % | Nada: B1 alcanza |
| 80–90 % | Vigilar; los despliegues pueden tardar más |
| Más de 90 % o reinicios en el log | Subir a B2: `az appservice plan update -g $RG -n $PLAN --sku B2` |

### Ahorro cuando no se usa

```bash
az webapp stop -g $RG -n $APP                          # la app deja de responder; el plan sigue cobrando
az postgres flexible-server stop -g $RG -n $DB_SERVER  # no cobra cómputo; Azure la enciende sola a los 7 días
```

Para volver: `az postgres flexible-server start ...` primero y luego `az webapp start ...`.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un proceso consume demasiada memoria y tumba el contenedor | Límite de memoria por proceso y reinicio individual en el lanzador |
| Arrancar todos los procesos tarda más que el límite de App Service | `WEBSITES_CONTAINER_START_TIME_LIMIT=600` y el Gateway abre su puerto al final |
| El nombre de la app no queda libre enseguida tras borrarla | Esperar unos minutos; si no, usar otro nombre, repetir el Paso 5.1 y avisar a Booking de la URL nueva |
| Secretos o contraseñas filtrados en el repositorio | Solo viven en las variables de la app y en GitHub Secrets; si se filtran, regenerarlos (Paso 3) y reconfigurar (Paso 4.4) |
| Base en otra región que la app | Mayor latencia y salud en `DEGRADED`; subir `ESB_TIMEOUT_FACTOR` a `3` |
