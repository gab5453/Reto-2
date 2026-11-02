#!/bin/sh
# Una base y un usuario de PostgreSQL por servicio (D10, CLAUDE.md): cada usuario es dueño SOLO de su base y no puede
# conectarse a las de los demás, así un servicio no lee la base de otro aunque quiera.
# Lo ejecuta la imagen oficial de postgres la primera vez que arranca (docker-entrypoint-initdb.d).
# Contraseñas: variables PG_PASSWORD_<BASE> (en mayúsculas); en local tienen un valor de desarrollo (infra/.env.example).
set -eu

for base in identity customers webhooks schedule offers flight_status bookings post_sale check_in esb payment; do
  variable="PG_PASSWORD_$(echo "$base" | tr '[:lower:]' '[:upper:]')"
  password="$(printenv "$variable" || true)"
  if [ -z "$password" ]; then
    echo "Falta $variable" >&2
    exit 1
  fi
  usuario="${base}_svc"
  echo "Creando la base '$base' con su usuario '$usuario'"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v usuario="$usuario" -v base="$base" -v clave="$password" <<'SQL'
CREATE ROLE :"usuario" LOGIN PASSWORD :'clave';
CREATE DATABASE :"base" OWNER :"usuario";
REVOKE ALL ON DATABASE :"base" FROM PUBLIC;
SQL
done

# Nadie salvo el administrador entra a las bases del sistema.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL
