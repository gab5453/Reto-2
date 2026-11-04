# PASOS FINALES — Dónde se levanta el sistema y qué falta

> Documento de trabajo para la reunión con los líderes de Booking (27/10/2026). Reúne lo que consume el sistema, las
> opciones para hospedarlo con su costo, lo que hay que decidir con Booking y lo que nos falta a nosotros.
> Detalle de la nube actual: `DESPLIEGUE_AZURE.md`. Plan por fases: `PLAN/PLAN.md` (sección 6).

---

## 0. Decisión (03/11/2026)

**Cada equipo hospeda su sistema por su cuenta; EcoAirlines se queda en Azure**, en la VM actual (opción A o B de la sección 3,
según las horas que haga falta tenerla encendida). Booking ya está en Azure (`booking-core-api.azurewebsites.net`) y recibe
nuestro stock por REST con `service_id` `NODE_VUE_EQ5` (D53). Sus webhooks se activan «en unos días» (BKG-15).

---

## 1. Cuánto consume el sistema (medido el 26/10/2026)

### 1.1 Corriendo (en reposo, Docker en la laptop)

| Grupo | Contenedores | Memoria |
|-------|--------------|---------|
| Ruta de Booking y la web: gateway, 5 MS de respuesta, ESB, 9 MS.G, PostgreSQL, RabbitMQ, Payment API | 19 | **≈0,95 GiB** |
| Observabilidad (V2.16): OTel Collector, Prometheus, Alertmanager, Loki, Tempo, Grafana | 6 | **≈0,7 GiB** (Tempo solo ≈0,3). Medido de nuevo el 02/11 recién arrancado: los 26 contenedores usan ≈2,7 GiB |
| Booking simulado (solo para pruebas locales) | 1 | ≈0,03 GiB |
| **Total** | **26** | **≈1,7 GiB** |

Cada microservicio usa entre 25 y 70 MiB. **Correr el sistema no es lo pesado.**

### 1.2 Lo que de verdad agota la máquina: compilar las imágenes

- Cada imagen instala dependencias con npm y compila TypeScript. Al cambiar `packages/shared` hay que recompilar **las 20**.
- En la laptop (15,7 GB de RAM) la compilación llevó a Docker (`vmmemWSL`) a **≈6,8 GB**, dejó **0,5 GB libres** y
  **el motor de Docker se cayó** (`rpc error: EOF`). Es el mismo error que ya había aparecido antes.
- En la VM de Azure (4 GiB) pasa lo mismo, en menor escala: por eso allí se compila de a 2 imágenes.

### 1.3 Cómo trabajamos mientras tanto (en la laptop)

- **Levantar solo lo que la fase necesita.** Para la web no hacen falta la observabilidad ni el Booking simulado. Apagar el
  Collector es seguro desde el 02/11: antes esta recomendación **hacía fallar login y registro** al azar (ver CAMBIOS.md, V2.19):
  ```bash
  cd infra
  docker compose stop loki tempo prometheus alertmanager grafana otel-collector booking-simulado
  # Reiniciar un servicio sin volver a levantar el Collector (los servicios lo declaran en depends_on):
  docker compose up -d --no-deps <servicio>
  ```
- **Compilar sin el sistema levantado y de a una imagen:** `docker compose down`, luego
  `COMPOSE_PARALLEL_LIMIT=1 docker compose build`, luego `docker compose up -d`.
- **Limitar la memoria de Docker** (pendiente de aprobar): archivo `C:\Users\Gab\.wslconfig` con
  `[wsl2]` / `memory=8GB` / `processors=4` / `swap=4GB`, y después `wsl --shutdown`.
- Para liberar la memoria de golpe: cerrar Docker Desktop o ejecutar `wsl --shutdown`.

---

## 2. Qué necesita Booking de nosotros

- **Disponibilidad:** Booking usa un **timeout de 5 s**. Si el nodo está apagado o arrancando, nos ve `DOWN` (CV-21). Por
  eso no puede haber escala a cero en su ruta (D39).
- **URL pública con HTTPS:** hoy es `https://ecoairlines-reto2.northcentralus.cloudapp.azure.com/api/v2/vuelos/...`.
- **Credenciales OAuth2** (`client_id` y secreto), entregadas **por canal privado**. Están en `infra/cloud/.env` y nunca
  se suben al repositorio.
- **Webhooks:** su URL de recepción y el secreto de firma.

---

## 3. Opciones para hospedarlo

Crédito disponible: **US$90 (Azure for Students). No se puede exceder: el excedente lo paga el responsable.**
El presupuesto `presupuestodereto` solo avisa, no detiene el gasto.

| # | Opción | Costo para nosotros | A favor | En contra |
|---|--------|---------------------|---------|-----------|
| **A** | **Nuestra VM actual** (`B2pls_v2`, 2 vCPU ARM, 4 GiB) encendida 24 h | **≈US$30,6/mes** → el crédito dura **≈2,9 meses** | Ya está lista, con HTTPS y la ruta de Booking probada | Consume el crédito rápido. 4 GiB justos con la observabilidad (≈2,3 GiB en uso) y compilando dentro |
| **B** | **La misma VM solo en horarios de prueba acordados** (p. ej. 8 h en días laborables) | **≈US$12/mes** → ≈7,5 meses | Cuidamos el crédito | Booking nos ve `DOWN` fuera de horario. Hay que coordinar ventanas y el apagado automático (hoy a las 23:00 de Ecuador) |
| **C** | **Un servidor de Booking o de la EPN** (nuestro `docker compose` corre en su máquina) | **US$0** | Sin costo. Si su servidor gRPC está en la misma red, **se resuelve BKG-13** | Depende de ellos: requiere ≥4 GB de RAM, 2 CPU, Docker y un puerto HTTPS público. Perdemos control para desplegar |
| **D** | **Mixto:** la ruta de Booking en la VM y la observabilidad y la web en otro lugar (o solo en local) | ≈US$12–30/mes | La VM queda holgada (≈1,6 GiB) | Grafana y las alertas no se verían en la nube (V2.20 las pide) |

**Ahorros que valen para cualquier opción:**
1. **No compilar en el servidor.** GitHub Actions (gratis en repos públicos) compila las imágenes para ARM y amd64, las sube a
   GitHub Container Registry, y el servidor solo las descarga. Así el pico de memoria del §1.2 desaparece del servidor.
   Encaja con V2.20 («GitHub Actions por servicio»).
2. **Observabilidad desactivable:** un perfil de Compose (`--profile observabilidad`) para encenderla solo en las demos.
   Ahorra ≈0,7 GiB.
3. **Mantener el apagado automático nocturno** y apagar la VM (`az vm deallocate`) al terminar cada sesión de pruebas.

**Recomendación:** **B + ahorros 1 y 2** mientras dure el desarrollo, y **A** solo en las semanas de pruebas integradas y
de la defensa. Si Booking ofrece un servidor (C), es la mejor opción económica: preguntarlo primero.

---

## 4. Preguntas para la reunión con Booking

**Hospedaje:**
1. ¿Dónde se levantan finalmente los sistemas? ¿Tienen un servidor (EPN o propio) donde podamos correr el nuestro? ¿Con
   cuánta RAM y CPU, con Docker, y con un puerto HTTPS público?
2. ¿En qué horarios necesitan nuestro nodo encendido (pruebas integradas, ensayos, defensa)? ¿Desde qué fecha y hasta cuándo?
3. ¿Cuál es la fecha de la defensa? Para planificar cuántas horas de VM hacen falta.

**Integración (pendientes de V2.14):**
4. **BKG-13:** `booking.epn.edu.ec` no resuelve desde Internet. ¿Cuál es la dirección pública de su servidor gRPC de stock
   (puerto 50051)? ¿Usa TLS?
5. **BKG-01:** ¿por qué canal nos llegan `payment.*` y `package.cancelled`: webhook firmado hacia
   `/integraciones/booking/eventos`, RabbitMQ o Kafka?
6. **BKG-06:** ¿`PushStockUpdate` (valor absoluto) o `StreamInventoryChanges` (delta)? ¿Fechas en hora local?
7. ¿Por qué canal privado les entregamos las credenciales OAuth2 y el secreto del webhook? ¿Y su URL de webhooks?
8. **BKG-14 (nuevo, V2.17):** si nos mandan maletas extra (`extraBaggage`) al crear la reserva, ¿el `amount` del pago incluye
   su precio? Hoy no se agregan ni se cobran; para agregarlas está `POST /bookings/{id}/baggage`, que sí cobra.
9. Las demás preguntas abiertas (BKG-02, 03, 08 y 11) están en `HALLAZGOS.md`, sección 8.

**Observabilidad:**
10. ¿Quieren ver nuestros tableros (Grafana con usuario y contraseña) o les basta `GET /vuelos/health`?

---

## 5. Lo que nos falta (después de la reunión)

| Fase | Estado | Pendiente |
|------|--------|-----------|
| V2.14 Nube + Booking real | 🟡 | BKG-01, BKG-06, BKG-13 y entregar las credenciales |
| V2.16 Observabilidad | ✅ | Hecha el 02/11, también en la VM: traza única con gRPC, alerta real y Grafana con contraseña (pendiente de auditoría). Usa ≈2,2 GiB + ≈0,9 GiB de swap de 3,8 GiB: hay que vigilar la memoria |
| V2.17 Web: GraphQL y tarjeta | ✅ | Hecha el 26/10 (pendiente de auditoría) |
| V2.18 Web: pantallas nuevas | ✅ | Hecha el 02/11 (pendiente de auditoría) |
| V2.19 Web: PWA | ✅ | Hecha el 02/11 (pendiente de auditoría) |
| V2.20 Nube: todo lo demás | ✅ | Hecha el 03/11: VM, observabilidad, stock REST a Booking (D53) y web publicada. GitHub Actions diferido; falta probar la PWA en un teléfono |
| V2.21 Documentación y defensa | ✅ | Hecha el 03/11 (`ARQUITECTURA.md`, `EVENTOS.md`, `CRITERIOS.md`, `DEFENSA.md`; monolito retirado). Faltan las auditorías de Gemini de V2.2 a V2.21 |
