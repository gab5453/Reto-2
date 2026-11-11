"""Arquitectura de microservicios v6 de EcoAirlines (Reto 2): como está implementada y desplegada (11/11/2026).
Base: la v5 (03/11). Cada línea conserva el color de su grupo. En rojo, lo nuevo desde la v5: O-1..O-4, C-1..C-3, P-1 (provincias),
T-1, R-1, P-1 (precios), T-2, M-1, M-2, T-3, T-4, T-5 y los arreglos de estabilidad del 10/11."""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Ellipse, Rectangle

OUT = sys.argv[1]
NEW = "#d32f2f"      # nuevo desde la v5
BLUE = "#1f5fa6"
ORANGE = "#d35400"
PURPLE = "#5b3fb0"
TEAL = "#138a72"
BROWN = "#795548"    # integración con Booking (sistema externo)
GRAYL = "#555555"
DASH = (0, (4, 3))
DOT = (0, (2, 2))
DASHDOT = (0, (6, 2, 1.5, 2))

fig, ax = plt.subplots(figsize=(31, 25.9))
ax.set_xlim(0, 131)
ax.set_ylim(-21.3, 92)
ax.axis("off")


def box(x, y, w, h, fc, ec, lw=1.6, ls="-", r=0.8, z=1):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={r}", fc=fc, ec=ec, lw=lw, ls=ls, zorder=z))


def path(points, color, ls="-", lw=1.7, arrow=True, both=False, label="", lseg=0, lfrac=0.5, fs=8.5):
    xs, ys = zip(*points)
    ax.plot(xs, ys, color=color, lw=lw, ls=ls, zorder=3)
    for tip, tail, on in ((points[-1], points[-2], arrow), (points[0], points[1], both)):
        if on:
            ax.annotate("", xy=tip, xytext=tail, zorder=4,
                        arrowprops=dict(arrowstyle="-|>", color=color, lw=lw, shrinkA=0, shrinkB=0, mutation_scale=15))
    if label:
        (x1, y1), (x2, y2) = points[lseg], points[lseg + 1]
        ax.text(x1 + (x2 - x1) * lfrac, y1 + (y2 - y1) * lfrac, label, fontsize=fs, color=color, ha="center", va="center",
                zorder=6, bbox=dict(fc="white", ec="none", pad=0.4))


def cylinder(x, y, w, h, label):
    ec = "#555555"
    ax.add_patch(Rectangle((x, y), w, h, fc="#efeee6", ec="none", zorder=2))
    ax.plot([x, x], [y, y + h], color=ec, lw=1.3, zorder=2)
    ax.plot([x + w, x + w], [y, y + h], color=ec, lw=1.3, zorder=2)
    ax.add_patch(Ellipse((x + w / 2, y), w, 0.9, fc="#efeee6", ec=ec, lw=1.3, zorder=2))
    ax.add_patch(Ellipse((x + w / 2, y + h), w, 0.9, fc="#f7f6f0", ec=ec, lw=1.3, zorder=2))
    ax.text(x + w / 2, y + h / 2 - 0.1, label, ha="center", va="center", fontsize=9.5, fontweight="bold", zorder=3)


def lines_at(x, y0, step, items, fs, base="#333333"):
    for i, (t, new) in enumerate(items):
        ax.text(x, y0 - i * step, t, ha="center", fontsize=fs, zorder=4,
                color=NEW if new else base, fontweight="bold" if new else "normal")


ax.text(65.5, 90.6, "EcoAirlines — Arquitectura de microservicios (v6): como está implementada y desplegada en Azure (11/11/2026)",
        ha="center", fontsize=20, fontweight="bold")
ax.text(65.5, 88.7, "Base: la v5. En rojo, lo nuevo desde la v5: asiento validado antes de cobrar · retrasos · precios editables · aeropuertos y tipos de avión "
        "administrables · reservas y reportes en el panel · telemetría en vivo (recorrido y mapa) · despliegue más liviano", ha="center", fontsize=11.5, color=NEW)

# ================= 1. Datos y 2. MS.G =================
TOPC = 85.5
box(0.5, 19.5, 11, TOPC - 19.5, "#f7f6f0", "#999999")
ax.text(6, TOPC - 1.4, "1. Datos", ha="center", fontsize=14, fontweight="bold")
ax.text(6, TOPC - 2.6, "una base por servicio", ha="center", fontsize=9)
ax.text(6, TOPC - 3.7, "PostgreSQL 17 · un usuario c/u", ha="center", fontsize=8.2)
box(13, 19.5, 20.8, TOPC - 19.5, "#f7f9fc", "#999999")
ax.text(23.4, TOPC - 1.4, "2. Microservicios de gestión (MS.G)", ha="center", fontsize=13.5, fontweight="bold")
ax.text(23.4, TOPC - 2.6, "dueños de sus datos · nunca se llaman entre sí", ha="center", fontsize=9)

msg = [  # clave, nombre, protocolo, detalle [(línea, nueva en v6)], relleno, borde, cambiado en v6
    ("identity", "MS.G.Identity", "REST", (("usuarios · un rol · partners (client_credentials) · JWKS", False),
     ("tokens de servicio: ESB y MS respuesta (D41, D44)", False)), "#e3f0fa", BLUE, False),
    ("webhooks", "MS.G.Webhooks", "REST", (("CloudEvents firmados · reintentos 1 min → 6 h", False),
     ("+ HISTORIAL POR RESERVA (O-2) · feed /vuelos/eventos", True)), "#e3f0fa", BLUE, True),
    ("schedule", "MS.G.Schedule", "REST", (("rutas · flota · horario · precios · acuerdo B2B", False),
     ("+ AEROPUERTOS · TIPOS DE AVIÓN · TARIFA BASE (M, P-1)", True)), "#e3f0fa", BLUE, True),
    ("offers", "MS.G.Offers", "gRPC", (("inventario · asientos · holds (TTL) · stock a Booking (REST)", False),
     ("+ ASIENTO VALIDADO ANTES DE COBRAR (T-1) · copias", True)), "#ddf3e6", "#1d7a46", True),
    ("flight_status", "MS.G.FlightStatus", "REST", (("estado · transiciones válidas · puerta · historial", False),
     ("+ RETRASOS: impacto en el siguiente vuelo (R-1)", True)), "#e3f0fa", BLUE, True),
    ("customers", "MS.G.Customers", "REST", (("perfil · asistencia predeterminada", False), ("", False)), "#e3f0fa", BLUE, False),
    ("bookings", "MS.G.Bookings", "REST", (("reservas · boletos · asistencia médica · pagos", False),
     ("+ BÚSQUEDA POR PNR/ORDEN/PAGO · REPORTE (O-1, O-3)", True)), "#e3f0fa", BLUE, True),
    ("post_sale", "MS.G.PostSale", "SOA · SOAP/WSDL", (("cotizaciones · ofertas de cambio · maletas", False),
     ("combo cancelado: 100 % sin penalidad (D42)", False)), "#f6ead2", "#8a5300", False),
    ("check_in", "MS.G.CheckIn", "REST", (("check-in (exige boletos) · pases QR · asistencia", False), ("", False)), "#e3f0fa", BLUE, False),
]
Y = {}
MSG_R = 32.5
for i, (key, name, proto, detail, fc, ec, changed) in enumerate(msg):
    yc = 79 - i * 6.85
    Y[key] = yc
    cylinder(1.5, yc - 1.4, 9, 2.8, key)
    box(14.3, yc - 2.5, MSG_R - 14.3, 5.0, fc, NEW if changed else ec, lw=2.4, z=2)
    ax.text(23.4, yc + 1.45, name, ha="center", fontsize=11, fontweight="bold", zorder=3)
    ax.text(23.4, yc + 0.35, proto, ha="center", fontsize=8.5, color=ec, fontweight="bold", zorder=3)
    for j, (line, new) in enumerate(detail):
        if line:
            ax.text(23.4, yc - 0.75 - j * 1.05, line, ha="center", fontsize=7.2, zorder=3,
                    color=NEW if new else "#333333", fontweight="bold" if new else "normal")
    ax.plot([10.5, 14.3], [yc, yc], color="#777777", lw=1.2, zorder=1)

# ================= 3. ESB =================
ESB_L, ESB_R = 41.8, 75.0
PL, PR = 43.3, 73.5
PC = (PL + PR) / 2
box(ESB_L, 7.0, ESB_R - ESB_L, TOPC - 7.0, "#eeeee8", "#888888")
ax.text((ESB_L + ESB_R) / 2, TOPC - 1.4, "3. ESB", ha="center", fontsize=15, fontweight="bold")
ax.text((ESB_L + ESB_R) / 2, TOPC - 2.6, "lógica de negocio", ha="center", fontsize=9)


def panel(y, h, title, subtitle, color, lines, fs=8.6, step=1.42, title_new=False):
    box(PL, y, PR - PL, h, "white", NEW if title_new else color, lw=2.2 if title_new else 2, r=0.3, z=2)
    ax.add_patch(Rectangle((PL + 0.5, y + h - 2.1), PR - PL - 1, 1.7, fc=color, ec="none", zorder=3))
    ax.text(PC, y + h - 1.25, title, ha="center", va="center", fontsize=11.5, fontweight="bold", color="white", zorder=4)
    ax.text(PC, y + h - 3.0, subtitle, ha="center", va="center", fontsize=8.5, color=color, style="italic", zorder=4)
    for i, (t, new) in enumerate(lines):
        ax.text(PL + 0.8, y + h - 4.6 - i * step, t, fontsize=fs, va="center", zorder=4,
                color=NEW if new else "black", fontweight="bold" if new else "normal")


ENR, ORQ, COMP, ADP = (62.6, 19.4), (39.6, 22.4), (25.0, 13.9), (15.3, 9.0)
panel(*ENR, "Enrutador", "un solo MS.G, sin coordinación", BLUE, [
    ("/router/<servicio>/<ruta del MS.G>: tabla cerrada de rutas (D43) · 57 rutas", False),
    ("Registro · login · token de partner · usuarios y partners → Identity", False),
    ("Buscar · mapa de asientos · hold → Offers (JSON del proto → gRPC)", False),
    ("Admin: precios por clase · TARIFA BASE y PRECIO POR RUTA → Schedule", True),
    ("Admin: flota · AEROPUERTOS · TIPOS DE AVIÓN → Schedule (M-1, M-2)", True),
    ("Acuerdo de promociones (GET /vuelos/promociones/contrato) → Schedule", False),
    ("Estado de vuelo (GET) · RETRASO → FlightStatus · Perfil → Customers", True),
    ("Suscripciones de webhooks · feed GET /vuelos/eventos → Webhooks", False),
    ("Reservas · asistencia · BUSCAR POR PNR · REPORTE DE VENTAS → Bookings", True),
    ("Pases de abordar · asistencia lista → CheckIn", False),
], fs=8.0)
panel(*ORQ, "Orquestador (Saga) · 11 sagas", "varios MS.G en orden + compensación · estado en saga_log", ORANGE, [
    ("Crear reserva: Offers (hold + ASIENTOS PEDIDOS, T-1) → Bookings → pago* → Offers", True),
    ("Emitir boletos (/tickets o payment.confirmed) · Pago fallido (payment.failed)", False),
    ("Cambiar asientos (atómico): Bookings → Offers → pago* → Bookings", False),
    ("Check-in: Bookings → FlightStatus → Offers → CheckIn → Bookings", False),
    ("Cancelar (reasonCode) · combo (D42) · POR EL ADMINISTRADOR (con motivo)", True),
    ("Cambiar fecha · Agregar maletas: Bookings → PostSale → pago* → Bookings", False),
    ("Vuelo cancelado (PATCH): FlightStatus → Offers (cierra venta) → Cancelar c/u", False),
    ("Guardar precios → Offers · Publicar horario + AEROPUERTOS y TIPOS (M-1, M-2)", True),
    ("pago* Booking: validar referencia (única) y monto; NO se cobra", False),
    ("pago* web: capturar · anular · reembolsar en la Payment API (sk_test, D49)", False),
    ("Plazo 3,5 s: si no alcanza → 202 y termina en la cola esb.deferred", False),
    ("(esperas con TTL + dead letter) · pago pendiente: espera hasta 45 s", False),
], fs=7.9, step=1.4)
panel(*COMP, "Composición (solo lectura)", "varios MS.G en paralelo, sin escribir", TEAL, [
    ("Health del nodo (semáforo de Booking): desde caché, < 1 s", False),
    ("Operaciones: ocupación por vuelo y cabina · holds activos · alertas", False),
    ("Panel admin: indicadores · ventas · eventos y entregas (Webhooks)", False),
    ("HISTORIAL DE LA RESERVA: cambios + sagas + eventos (O-2)", True),
    ("IMPACTO DE UN RETRASO: avión y reservas afectadas (R-1)", True),
    ("Pasajeros con asistencia por vuelo (para el aeropuerto)", False),
    ("Telemetría: Prometheus · Loki · VENTANA AUTOMÁTICA (T-2)", True),
    ("RECORRIDO (trazas de Tempo) · MAPA EN VIVO (T-3, T-4)", True),
], fs=7.9, step=1.22)
panel(*ADP, "Integración con Booking (entrada de eventos)", "un evento repetido nunca cobra ni vende dos veces", BROWN, [
    ("webhook: POST /integraciones/booking/eventos (firma HMAC)", False),
    ("o AMQP booking.events (opcional: BOOKING_BUS_URL)", False),
    ("sin duplicados: inbound_events (id) + sagas idempotentes", False),
], fs=8.2, step=1.3)
box(PL, 7.9, PR - PL, 6.6, "white", GRAYL, lw=2, r=0.3, z=2)
ax.text(PC - 3.3, 13.7, "Transversal", ha="center", fontsize=11, fontweight="bold", color=GRAYL, zorder=4)
ax.text(PC - 2.8, 12.5, "X-Correlation-Id intacto en HTTP · gRPC · SOAP · AMQP", ha="center", fontsize=7.4, zorder=4)
ax.text(PC - 2.8, 11.4, "X-Request-Id por salto · Idempotency-Key 24 h (Idempotent-Replayed)", ha="center", fontsize=7.4, zorder=4)
ax.text(PC - 2.8, 10.3, "token de servicio a los MS.G (D41) · X-Owner-Id · X-Actor-Id", ha="center", fontsize=7.4, zorder=4)
ax.text(PC - 2.8, 9.2, "gRPC / SOAP Fault → ProblemDetails v2 · OTLP", ha="center", fontsize=7.4, zorder=4)
cylinder(PR - 4.6, 9.4, 3.8, 2.2, "esb")

# --------- buses verticales entre MS.G y ESB ---------
BARS = {"event": 34.6, "enr": 36.4, "orq": 38.2, "comp": 40.0}
OFF = {"enr": 1.5, "orq": 0.5, "comp": -0.5, "event": -1.5}
COLORS = {"enr": BLUE, "orq": ORANGE, "comp": TEAL}
STYLE = {"enr": ("-", 1.7), "orq": ("-", 1.7), "comp": (DOT, 1.2)}
targets = {
    "enr": ["identity", "webhooks", "schedule", "offers", "flight_status", "customers", "bookings", "check_in"],
    "orq": ["schedule", "offers", "flight_status", "bookings", "post_sale", "check_in"],
    "comp": ["identity", "webhooks", "schedule", "offers", "flight_status", "bookings", "check_in"],
}
source_y = {k: y + h / 2 for k, (y, h) in {"enr": ENR, "orq": ORQ, "comp": COMP}.items()}
for bus, keys in targets.items():
    x, c = BARS[bus], COLORS[bus]
    ls, lw = STYLE[bus]
    ys = [Y[k] + OFF[bus] for k in keys] + [source_y[bus]]
    ax.plot([x, x], [min(ys), max(ys)], color=c, lw=lw + 0.6, ls=ls, zorder=3)
    path([(PL, source_y[bus]), (x, source_y[bus])], c, ls=ls, lw=lw, arrow=False)
    ax.plot([x], [source_y[bus]], "o", color=c, ms=5, zorder=4)
    for k in keys:
        path([(x, Y[k] + OFF[bus]), (MSG_R, Y[k] + OFF[bus])], c, ls=ls, lw=lw)

# eventos (morado): Webhooks y FlightStatus consumen; Offers publica
EX = BARS["event"]
ax.plot([EX, EX], [5.5, Y["webhooks"] + OFF["event"]], color=PURPLE, lw=2, ls=DASH, zorder=3)
for k in ("webhooks", "flight_status"):
    path([(EX, Y[k] + OFF["event"]), (MSG_R, Y[k] + OFF["event"])], PURPLE, ls=DASH, lw=1.7)
path([(MSG_R, Y["offers"] + OFF["event"]), (EX, Y["offers"] + OFF["event"])], PURPLE, ls=DASH, lw=1.7)

box(EX - 0.6, -3, ESB_R - EX + 0.6, 8.5, "#ebe6fb", PURPLE, lw=2)
EBC = (EX - 0.6 + ESB_R) / 2
ax.text(EBC, 4.3, "Event Bus interno (RabbitMQ) · «ecoairlines.events» · formato CloudEvents 1.0", ha="center", fontsize=10.5, fontweight="bold", color=PURPLE)
ax.text(EBC, 2.85, "publican (con outbox): ESB (booking.*, flight.status_changed, schedule.published, pricing.changed, user.*, partner.*) · Offers (hold.*)",
        ha="center", fontsize=7.4, color=PURPLE)
ax.text(EBC, 1.45, "colas: webhooks.events · flight-status.schedule · esb.deferred (+ esperas con TTL) · fallidos: ecoairlines.dlx",
        ha="center", fontsize=7.6, color=PURPLE)
ax.text(EBC, 0.05, "consumen: Webhooks (entrega a Booking + feed) · FlightStatus (proyección del horario) · ESB (sagas diferidas)",
        ha="center", fontsize=7.6, color=PURPLE)
ax.text(EBC, -1.35, "internos, nunca salen: schedule.published · pricing.changed · user.* · partner.* · asistencia médica",
        ha="center", fontsize=7.6, color=PURPLE)
path([(60, 7.0), (60, 5.5)], PURPLE, ls=DASH, lw=1.8, both=True)

# Payment API (canal web propio)
box(14.3, 0.4, MSG_R - 14.3, 8.0, "#fbe9f0", "#c2185b", lw=2.0, ls="--")
ax.text(23.4, 7.2, "Payment API · tarjeta (simulada)", ha="center", fontsize=10.5, fontweight="bold", color="#c2185b")
lines_at(23.4, 5.9, 1.2, [("Luhn · CVV · tarjetas de prueba · solo web", False),
                          ("navegador: tokenizar + autorizar (pk_test)", False),
                          ("ESB: capturar · anular · reembolsar (sk_test)", False),
                          ("nube: misma VM, Caddy /payment-api (D49)", False),
                          ("en ventas de Booking NO se usa: cobra Booking", False)], 7.8)
path([(PL, 9.0), (23.4, 9.0), (23.4, 8.4)], GRAYL, lw=1.6, label="capturar · anular · reembolsar", lseg=0, lfrac=0.32)

# ================= 4. Microservicios de respuesta =================
RL, RR = 80.4, 96.6
RCX = (RL + RR) / 2
box(79.2, 23.5, 19.2, TOPC - 23.5, "#f6f4fd", "#6655aa")
ax.text(88.8, TOPC - 1.4, "4. Microservicios de respuesta", ha="center", fontsize=13, fontweight="bold", color="#3b2f86")
ax.text(88.8, TOPC - 2.6, "token · scopes · DTOs · ProblemDetails v2", ha="center", fontsize=8.5, color="#3b2f86")
ax.text(88.8, TOPC - 3.8, "token propio hacia el ESB (D44)", ha="center", fontsize=8.3, color="#3b2f86")
resp = [  # clave, centro, alto, nombre, líneas (texto, nuevo), borde, relleno, cambiado
    ("vuelos", 75.6, 8.6, "MS.Vuelos", [("búsqueda · asientos · estado", False), ("operaciones · cambiar estado", False),
                                       ("health · eventos · promociones", False), ("9 operaciones del contrato", False),
                                       ("+ CATÁLOGO DE AEROPUERTOS (M-1)", True)], BLUE, "#e3f0fa", True),
    ("clientes", 66.6, 4.8, "MS.Clientes", [("registro · login · perfil · webhooks", False)], BLUE, "#e3f0fa", False),
    ("reservas", 57.5, 7.4, "MS.Reservas", [("hold · reserva · emitir boletos", False), ("cambiar asientos · check-in · pases", False),
                                           ("asistencia · 12 operaciones", False)], ORANGE, "#fbeae0", False),
    ("postventa", 48.0, 6.0, "MS.Postventa", [("maletas · cambio de fecha", False), ("cotizar · cancelar (reasonCode)", False)], ORANGE, "#fbeae0", False),
    ("admin", 33.0, 11.0, "MS.Admin", [("usuarios · partners · precios y descuento", False), ("RESERVAS · REPORTES (O-1, O-3)", True),
                                      ("rutas · flota · AEROPUERTOS · TIPOS (M)", True), ("RETRASOS · CANCELAR COMO ADMIN", True),
                                      ("telemetría · RECORRIDO · MAPA EN VIVO", True), ("estado y ocupación de vuelos", False),
                                      ("→ los usa vía MS.Vuelos", False)], TEAL, "#e2f4ef", True),
]
RY = {}
for key, yc, h, name, lines, ec, fc, changed in resp:
    RY[key] = yc
    box(RL, yc - h / 2, RR - RL, h, fc, NEW if changed else ec, lw=2.2, z=2)
    ax.text(RCX, yc + h / 2 - 1.3, name, ha="center", fontsize=11, fontweight="bold", zorder=3)
    for i, (line, new) in enumerate(lines):
        ax.text(RCX, yc + h / 2 - 2.8 - i * (1.15 if len(lines) > 5 else 1.3), line, ha="center", fontsize=7.8, zorder=3,
                color=NEW if new else "#333333", fontweight="bold" if new else "normal")

# respuesta → ESB (canales verticales en el hueco, cada línea con el color de su grupo)
path([(RL, 77.5), (PR, 77.5)], BLUE)                                    # Vuelos → enrutador
path([(RL, 74.3), (77.0, 74.3), (77.0, 59.0), (PR, 59.0)], ORANGE)     # Vuelos → orquestador (PATCH estado)
path([(RL, 72.6), (77.7, 72.6), (77.7, 36.6), (PR, 36.6)], TEAL, ls=DOT, lw=1.4)  # Vuelos → composición
path([(RL, 66.6), (PR, 66.6)], BLUE)                                    # Clientes
path([(RL, 59.8), (76.3, 59.8), (76.3, 64.2), (PR, 64.2)], BLUE)       # Reservas → enrutador
path([(RL, 55.5), (PR, 55.5)], ORANGE)                                  # Reservas → orquestador
path([(RL, 48.0), (PR, 48.0)], ORANGE)                                  # Postventa → orquestador
path([(RL, 36.0), (78.4, 36.0), (78.4, 63.2), (PR, 63.2)], BLUE)       # Admin → enrutador
path([(RL, 34.0), (79.0, 34.0), (79.0, 41.0), (PR, 41.0)], ORANGE)     # Admin → orquestador
path([(RL, 30.5), (PR, 30.5)], TEAL, ls=DOT, lw=1.4)                    # Admin → composición

# ================= 5. Gateway =================
GL, GR = 100.7, 113.2
GC = (GL + GR) / 2
box(GL, 23.5, GR - GL, TOPC - 23.5 - 1.5, "#ddf3ee", "#155e4d", lw=2.2)
ax.text(GC, 81.3, "5. Gateway", ha="center", fontsize=14, fontweight="bold", color="#155e4d")
for yy, t, new, big in [
    (78.4, "REST  /api/v2/vuelos/*", False, True),
    (77.0, "contrato v2 de Booking", False, False),
    (75.8, "30 operaciones · Swagger /api/docs", False, False),
    (69.5, "GraphQL  /api/graphql", False, True),
    (68.1, "única entrada de la web", False, False),
    (66.9, "suscripciones graphql-ws (D47)", False, False),
    (65.6, "+ EN VIVO por WebSocket (T-5):", True, False),
    (64.5, "recorrido y mapa · 1 sondeo", True, False),
    (62.0, "token de partner", False, False),
    (60.8, "OAuth2 client_credentials", False, False),
    (59.6, "/api/v2/oauth2/token → Identity", False, False),
    (58.4, "+ X-User-Id del usuario final", False, False),
    (53.5, "verifica el token (JWKS)", False, False),
    (52.3, "y lo reenvía al MS (D46)", False, False),
    (51.1, "(CLIENTE · ADMIN · partner)", False, False),
    (45.0, "X-Correlation-Id:", False, False),
    (43.8, "lo recibe de Booking o lo crea;", False, False),
    (42.6, "lo devuelve siempre", False, False),
    (36.5, "rate limit · helmet", False, False),
    (35.3, "CORS solo la web publicada", False, False),
    (34.1, "introspección apagada (nube)", False, False),
]:
    ax.text(GC, yy, t, ha="center", fontsize=10.5 if big else 8.3, fontweight="bold" if (new or big) else "normal",
            color=NEW if new else "#222222")
for key, yc in RY.items():
    path([(GL, yc), (RR, yc)], "#444444", lw=1.5)

# UI · PWA (web propia)
box(115.6, 57, 12, 26.5, "#fbe9f0", NEW, lw=2.2)
ax.text(121.6, 80.8, "UI · PWA", ha="center", fontsize=14, fontweight="bold")
ax.text(121.6, 79.0, "ecoairlines-web (React 19)", ha="center", fontsize=8.8)
lines_at(121.6, 76.6, 1.55, [("manifest · instalable", False), ("service worker: solo la app", False), ("pases offline: copia mínima", False),
                             ("local; «Salir» la borra (D52)", False), ("GraphQL con fetch propio (D51)", False), ("pago: tarjeta → Payment API", False),
                             ("Static Web App (Azure, Free)", False), ("admin: usuarios, partners, precios,", False),
                             ("RESERVAS · REPORTES · RETRASOS", True), ("AEROPUERTOS · TIPOS DE AVIÓN", True),
                             ("RECORRIDO Y MAPA EN VIVO", True)], 8.0)
path([(115.6, 69.5), (GR, 69.5)], "#333333", lw=1.9, label="GraphQL", lfrac=0.5)

# Booking Prototipo (sistema externo)
BKL, BKR = 115.6, 127.6
box(BKL, 24.5, BKR - BKL, 29.5, "#efebe9", NEW, lw=2.6)
ax.text(121.6, 51.6, "Booking Prototipo", ha="center", fontsize=12.5, fontweight="bold", color=BROWN)
ax.text(121.6, 50.1, "agregador del grupo (RDA2)", ha="center", fontsize=8.5)
lines_at(121.6, 48.0, 1.4, [("en Azure: booking-core-api", False), ("nuestro nodo: NODE_VUE_EQ5", False), ("", False),
                            ("cobra al cliente: envía", False), ("paymentReference", False),
                            ("→ llama al contrato v2 (OAuth2)", False), ("← recibe stock (REST, Offers)", False),
                            ("← webhooks CloudEvents", False), ("→ payment.* · package.cancelled", False),
                            ("← SEAT_TAKEN antes de cobrar", True), ("← RETRASOS (estado de vuelo)", True),
                            ("Autos · Alojamientos · Atracciones", False)], 8.0)
path([(BKL, 45.0), (GR, 45.0)], "#333333", lw=1.9, label="REST", lfrac=0.5)

# ================= Integración con Booking (marrón): carriles por debajo de todo =================
ADP_Y2 = 18.6
# stock: MS.G.Offers → Booking (REST, D53; el gRPC de D33 queda como alternativa)
SY = Y["offers"] - 1.9
path([(14.3, SY), (12.8, SY), (12.8, -5.0), (128.5, -5.0), (128.5, 30.0), (BKR, 30.0)], BROWN, ls=DASHDOT, lw=2.0,
     label="stock por REST desde Offers (D53): POST booking-core-api.azurewebsites.net/api/v2/inventory/stock · service_id NODE_VUE_EQ5 · item_id = vuelo-cabina · reintentos",
     lseg=2, lfrac=0.5, fs=8.3)
# eventos de Booking → ESB
path([(BKR, 32.5), (129.3, 32.5), (129.3, -6.1), (76.3, -6.1), (76.3, ADP_Y2), (PR, ADP_Y2)], BROWN, ls=DASHDOT, lw=2.0,
     label="eventos de Booking → Caddy → ESB: POST /integraciones/booking/eventos (HMAC) · payment.confirmed · payment.failed · package.cancelled",
     lseg=2, lfrac=0.5, fs=8.3)
# webhooks: MS.G.Webhooks → Booking
WY = Y["webhooks"] - 1.9
path([(14.3, WY), (12.25, WY), (12.25, -7.2), (130.1, -7.2), (130.1, 35.0), (BKR, 35.0)], BROWN, ls=DASHDOT, lw=2.0,
     label="webhooks: POST de CloudEvents firmados (HMAC-SHA256) · reintentos 1 min → 6 h · respaldo: GET /vuelos/eventos", lseg=2, lfrac=0.42, fs=8.3)

# ================= 6. Observabilidad =================
box(79.2, -3, 19.2, 23.6, "#eceff1", NEW, lw=2.2, ls="--")
ax.text(88.8, 19.0, "6. Observabilidad", ha="center", fontsize=11.5, fontweight="bold", color="#263238")
for i, (line, bold, new) in enumerate([
    ("OpenTelemetry Collector", True, False), ("recibe OTLP de los 18 servicios", False, False),
    ("logs: correlation_id · request_id · trace_id", False, False), ("(sin tokens, tarjetas ni salud)", False, False),
    ("la misma pila en local y en la VM (D50):", False, False),
    ("Prometheus · métricas", False, False), ("Tempo · trazas (1 compra = 1 traza)", False, False), ("Loki · logs", False, False),
    ("Alertmanager · 12 reglas · Grafana /grafana/", False, False),
    ("TEMPO → GRAFO DE SERVICIOS → PROMETHEUS", False, True), ("tablero «Mapa del sistema en vivo» (T-3)", False, True),
    ("LÍMITES DE TEMPO: no satura la VM (10/11)", False, True),
]):
    ax.text(88.8, 17.2 - i * 1.4, line, ha="center", fontsize=8.0, fontweight="bold" if (bold or new) else "normal",
            color=NEW if new else "#263238")
path([(PR, 26.2), (78.4, 26.2), (78.4, 12.0), (79.2, 12.0)], TEAL, ls=DOT, lw=1.4)

# ================= Leyenda =================
box(100.7, -3, 26.9, 23.6, "white", "#999999", r=0.3)
ax.text(101.7, 18.7, "Leyenda", fontsize=12, fontweight="bold")
for i, (c, ls, t) in enumerate([(BLUE, "-", "Flujo directo (enrutador)"), (ORANGE, "-", "Flujo orquestado (saga)"),
                                (TEAL, DOT, "Consulta compuesta (solo lectura)"), (PURPLE, DASH, "Evento asíncrono (bus interno)"),
                                (BROWN, DASHDOT, "Integración con Booking (externo)"), ("#444444", "-", "Gateway / clientes")]):
    yy = 16.9 - i * 1.5
    ax.plot([101.7, 105.2], [yy, yy], color=c, ls=ls, lw=2)
    ax.text(106.0, yy, t, fontsize=9, va="center")
for i, (fc, ec, t) in enumerate([("#e3f0fa", BLUE, "MS.G REST (7)"), ("#ddf3e6", "#1d7a46", "MS.G gRPC (Offers)"),
                                 ("#f6ead2", "#8a5300", "MS.G SOA (PostSale)"), ("white", NEW, "Borde o texto rojo: nuevo o modificado desde la v5")]):
    yy = 7.4 - i * 1.5
    ax.add_patch(Rectangle((101.7, yy - 0.55), 3.5, 1.1, fc=fc, ec=ec, lw=1.8))
    ax.text(106.0, yy, t, fontsize=9, va="center")
ax.text(101.7, 1.0, "Cada línea conserva el color de su grupo · • = unión con su bus", fontsize=7.8, color="#555555")
ax.text(101.7, -0.3, "Morado: flecha HACIA el bus = publica · DESDE el bus = consume", fontsize=7.8, color=PURPLE, fontweight="bold")
ax.text(101.7, -1.6, "Booking entra por /api/v2/vuelos y /integraciones", fontsize=7.8, color=BROWN, fontweight="bold")

# ================= 7. Despliegue =================
box(0.5, -20.6, 130.0, 12.4, "#fff8f6", NEW, lw=2.4, ls="--")
ax.text(65.5, -9.6, "7. Despliegue en Azure (D48, D49, D50)", ha="center", fontsize=13, fontweight="bold", color="#b71c1c")
for i, (line, new) in enumerate([
    ("VM B2pls_v2 (2 vCPU ARM, 4 GiB, North Central US) · Docker Compose con 26 contenedores · reinicio automático", False),
    ("Caddy + Let's Encrypt, lo ÚNICO público (443): /api/* · /oauth2/* · /health → Gateway · /integraciones/booking/eventos → ESB · /payment-api/* → Payment API · /grafana/ → Grafana", False),
    ("Web PWA: Azure Static Web App (Free) · el ESB, los MS, PostgreSQL y RabbitMQ no salen de la VM · SSH solo por el puerto 2222 desde IP permitidas", False),
    ("DESDE LA v5: healthchecks livianos (wget) · Caddy responde 503 con CORS mientras un servicio reinicia · despliegue parcial (desplegar-parcial.sh)", True),
    ("Local: el mismo docker compose (27 contenedores, + Booking simulado para probar stock, webhooks y payment.* sin Booking) · VM ≈ US$0,034/h encendida", False),
]):
    ax.text(65.5, -11.6 - i * 1.75, line, ha="center", fontsize=9.2, color=NEW if new else "#333333", fontweight="bold" if new else "normal")

fig.savefig(OUT, dpi=100, bbox_inches="tight", facecolor="white")
print("ok", OUT)
