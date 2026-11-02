"""Arquitectura de microservicios v4 de EcoAirlines (Reto 2): integración con Booking según el contrato de Vuelos v2.
Cada línea conserva el color de su grupo. En rojo, lo nuevo o corregido por el contrato v2."""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Ellipse, Rectangle

OUT = sys.argv[1]
NEW = "#d32f2f"      # nuevo o corregido en v4
BLUE = "#1f5fa6"
ORANGE = "#d35400"
PURPLE = "#5b3fb0"
TEAL = "#138a72"
BROWN = "#795548"    # integración con Booking (sistema externo)
GRAYL = "#555555"
DASH = (0, (4, 3))
DOT = (0, (2, 2))
DASHDOT = (0, (6, 2, 1.5, 2))

fig, ax = plt.subplots(figsize=(31, 23))
ax.set_xlim(0, 131)
ax.set_ylim(-8.8, 92)
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


def txt(x, y, s, new=False, **kw):
    kw.setdefault("fontsize", 8.5)
    kw.setdefault("ha", "center")
    ax.text(x, y, s, color=NEW if new else kw.pop("color", "#222222"), fontweight="bold" if new else kw.pop("fontweight", "normal"),
            zorder=kw.pop("zorder", 4), **kw)


ax.text(65.5, 90.6, "EcoAirlines — Arquitectura de microservicios (v4): integración con Booking según el contrato de Vuelos v2",
        ha="center", fontsize=20, fontweight="bold")
ax.text(65.5, 88.7, "Base: la v3. En rojo, lo nuevo o corregido por el contrato v2: /api/v2/vuelos · token de partner · Booking cobra · emisión de boletos aparte · "
        "CloudEvents · stock por gRPC · X-Correlation-Id · operaciones · health · promociones", ha="center", fontsize=11.5, color=NEW)

# ================= 1. Datos y 2. MS.G =================
TOPC = 85.5
box(0.5, 19.5, 11, TOPC - 19.5, "#f7f6f0", "#999999")
ax.text(6, TOPC - 1.4, "1. Datos", ha="center", fontsize=14, fontweight="bold")
ax.text(6, TOPC - 2.6, "una base por servicio", ha="center", fontsize=9)
box(13, 19.5, 20.8, TOPC - 19.5, "#f7f9fc", "#999999")
ax.text(23.4, TOPC - 1.4, "2. Microservicios de gestión (MS.G)", ha="center", fontsize=13.5, fontweight="bold")
ax.text(23.4, TOPC - 2.6, "dueños de sus datos · nunca se llaman entre sí", ha="center", fontsize=9)

msg = [  # clave, nombre, protocolo, detalle (2 líneas), relleno, borde, cambiado en v4
    ("identity", "MS.G.Identity", "REST", ("usuarios · un rol · JWT de la web (JWKS)", "+ CLIENTES PARTNER: token client_credentials"), "#e3f0fa", BLUE, True),
    ("webhooks", "MS.G.Webhooks", "REST", ("entrega CLOUDEVENTS firmados (X-Webhook-Signature)", "+ FEED GET /vuelos/eventos (cursor)"), "#e3f0fa", BLUE, True),
    ("schedule", "MS.G.Schedule", "REST", ("rutas · flota · horario · precios por clase", "+ DESCUENTO MÁXIMO DE PROMOCIONES (≤ 50 %)"), "#e3f0fa", BLUE, True),
    ("offers", "MS.G.Offers", "gRPC", ("inventario · ESTADO POR ASIENTO · PUBLICA hold.*", "+ ENVÍA EL STOCK A BOOKING (cliente gRPC)"), "#ddf3e6", "#1d7a46", True),
    ("flight_status", "MS.G.FlightStatus", "REST", ("estado · CONSUME schedule.published", "+ TRANSICIONES VÁLIDAS · puerta · historial"), "#e3f0fa", BLUE, True),
    ("customers", "MS.G.Customers", "REST", ("perfil · asistencia predeterminada", ""), "#e3f0fa", BLUE, False),
    ("bookings", "MS.G.Bookings", "REST", ("reservas · tickets · asistencia médica", "+ CANAL DE VENTA · PAGOS RECIBIDOS · REEMBOLSOS"), "#e3f0fa", BLUE, True),
    ("post_sale", "MS.G.PostSale", "SOA · SOAP/WSDL", ("cotizaciones · ofertas de cambio · maletas", "+ reasonCode (compensación sin penalidad)"), "#f6ead2", "#8a5300", True),
    ("check_in", "MS.G.CheckIn", "REST", ("check-in · pases · aviso de asistencia", "+ EXIGE BOLETOS EMITIDOS (TICKETED)"), "#e3f0fa", BLUE, True),
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
    ax.text(23.4, yc - 0.75, detail[0], ha="center", fontsize=7.2, color="#333333", zorder=3)
    if detail[1]:
        ax.text(23.4, yc - 1.8, detail[1], ha="center", fontsize=7.2, color=NEW, fontweight="bold", zorder=3)
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
    ("Registro · login · TOKEN DE PARTNER (client_credentials) → Identity", True),
    ("Admin: usuarios y rol · bloquear (+ evento user.*) → Identity", False),
    ("Buscar · mapa de asientos CON ESTADO · hold (crear / ver / liberar) → Offers", True),
    ("Admin: precios por clase («Rellenar», historial) → Schedule", False),
    ("ACUERDO DE PROMOCIONES (GET /vuelos/promociones/contrato) → Schedule", True),
    ("Estado de vuelo (GET) → FlightStatus · Perfil → Customers", False),
    ("Suscripciones de webhooks → Webhooks", False),
    ("FEED DE EVENTOS (GET /vuelos/eventos, outbox) → Webhooks", True),
    ("Reservas y boletos (consulta) · asistencia médica → Bookings · Pases → CheckIn", False),
    ("Admin: flota y tipos de avión → Schedule", False),
], fs=8.0)
panel(*ORQ, "Orquestador (Saga)", "varios MS.G en orden + compensación · estado en saga_log", ORANGE, [
    ("Crear reserva: Offers (hold, descuento) → Bookings → pago* → Offers → Bookings", True),
    ("EMITIR BOLETOS (/tickets o payment.confirmed): Bookings → Offers → Bookings", True),
    ("PAGO FALLIDO (payment.failed): Offers (liberar hold) → Bookings (FAILED)", True),
    ("Cambiar asientos (atómico): Bookings → Offers → pago* → Bookings", True),
    ("Check-in: Bookings → FlightStatus → Offers → CheckIn → Bookings", False),
    ("Cancelar (reasonCode): Bookings → PostSale → Offers → reembolso → Bookings", True),
    ("COMBO CANCELADO (package.cancelled) → Cancelar con SAGA_COMPENSATION", True),
    ("Cambiar fecha: Bookings → Offers → PostSale → pago* → Offers → Bookings", False),
    ("Agregar maletas: Bookings → PostSale → pago* → Bookings", False),
    ("VUELO CANCELADO (PATCH): FlightStatus → Offers (cierra venta) → Cancelar c/u", True),
    ("Guardar PRECIOS Y DESCUENTO MÁX.: Schedule → Offers · Publicar horario", True),
    ("pago* = Booking ya cobró: validar referencia y monto · web: Payment API", True),
], fs=7.9, step=1.4)
panel(*COMP, "Composición (solo lectura)", "varios MS.G en paralelo, sin escribir", TEAL, [
    ("HEALTH DEL NODO (semáforo de Booking): MS.G, BD y bus · < 1 s", True),
    ("OPERACIONES: ocupación por vuelo y cabina · holds activos · alertas", True),
    ("Panel admin: indicadores · ventas por ruta · usuarios por rol", False),
    ("Pasajeros con asistencia por vuelo (para el aeropuerto)", False),
    ("Telemetría por correlation_id: trazas, logs y métricas", True),
    ("Historial de eventos y entregas (Webhooks)", False),
], fs=8.4)
panel(*ADP, "Integración con Booking (entrada de eventos)", "un evento repetido nunca cobra ni vende dos veces", BROWN, [
    ("ENTRADA: payment.confirmed / failed · package.cancelled → sagas", True),
    ("SIN DUPLICADOS: inbound_events (id) + sagas idempotentes", True),
], fs=8.4, title_new=True)
box(PL, 7.9, PR - PL, 6.6, "white", GRAYL, lw=2, r=0.3, z=2)
ax.text(PC - 3.3, 13.5, "Transversal", ha="center", fontsize=11, fontweight="bold", color=GRAYL, zorder=4)
ax.text(PC - 2.8, 12.2, "X-CORRELATION-ID INTACTO en HTTP · gRPC · SOAP · AMQP", ha="center", fontsize=7.5, color=NEW, fontweight="bold", zorder=4)
ax.text(PC - 2.8, 10.9, "X-Request-Id por salto · Idempotency-Key 24 h (Idempotent-Replayed)", ha="center", fontsize=7.5, color=NEW, fontweight="bold", zorder=4)
ax.text(PC - 2.8, 9.6, "gRPC / SOAP Fault → ProblemDetails v2 · OTLP", ha="center", fontsize=7.9, zorder=4)
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
ax.text(EBC, 2.85, "publican: ESB (booking.*, flight.status_changed, schedule.published; outbox) · Offers (hold.created, hold.expired)", ha="center", fontsize=7.7, color=PURPLE)
ax.text(EBC, 1.45, "nuevos v4: hold.created · booking.seat_changed · booking.ticket_issued / ticket_failed · flight.status_changed", ha="center", fontsize=7.7, color=NEW, fontweight="bold")
ax.text(EBC, 0.05, "consumen: Webhooks (entrega a Booking + feed) · FlightStatus (proyección del horario)", ha="center", fontsize=7.7, color=PURPLE)
ax.text(EBC, -1.35, "internos, nunca salen: schedule.published · pricing.changed · user.* · asistencia · dead letter", ha="center", fontsize=7.7, color=PURPLE)
path([(60, 7.0), (60, 5.5)], PURPLE, ls=DASH, lw=1.8, both=True)

# Payment API (canal web propio)
box(14.3, 0.4, MSG_R - 14.3, 8.0, "#fbe9f0", "#c2185b", lw=2.0, ls="--")
ax.text(23.4, 7.2, "Payment API · tarjeta (simulada)", ha="center", fontsize=10.5, fontweight="bold", color="#c2185b")
ax.text(23.4, 5.8, "Luhn · vencimiento · CVV · tarjetas de prueba", ha="center", fontsize=8.0, color="#333333")
ax.text(23.4, 4.5, "recibe la tarjeta DIRECTO del navegador", ha="center", fontsize=8.0, color="#333333")
ax.text(23.4, 3.0, "SOLO CANAL WEB (provider AIRLINE_DIRECT)", ha="center", fontsize=8.0, color=NEW, fontweight="bold")
ax.text(23.4, 1.7, "en ventas de Booking NO se usa: cobra Booking", ha="center", fontsize=8.0, color=NEW, fontweight="bold")
path([(PL, 9.0), (23.4, 9.0), (23.4, 8.4)], GRAYL, lw=1.6, label="capturar (monto exacto, una vez)", lseg=0, lfrac=0.32)

# ================= 4. Microservicios de respuesta =================
RL, RR = 80.4, 96.6
RCX = (RL + RR) / 2
box(79.2, 23.5, 19.2, TOPC - 23.5, "#f6f4fd", "#6655aa")
ax.text(88.8, TOPC - 1.4, "4. Microservicios de respuesta", ha="center", fontsize=13, fontweight="bold", color="#3b2f86")
ax.text(88.8, TOPC - 2.6, "token · scopes · DTOs · ProblemDetails v2", ha="center", fontsize=8.5, color="#3b2f86")
resp = [  # clave, centro, alto, nombre, líneas (texto, nuevo), borde, relleno, cambiado
    ("vuelos", 75.6, 8.6, "MS.Vuelos", [("búsqueda · asientos · estado", False), ("OPERACIONES · CAMBIAR ESTADO", True),
                                       ("HEALTH · EVENTOS · PROMOCIONES", True), ("9 operaciones del contrato", True)], BLUE, "#e3f0fa", True),
    ("clientes", 66.6, 4.8, "MS.Clientes", [("registro · login · perfil · webhooks", False)], BLUE, "#e3f0fa", False),
    ("reservas", 57.5, 7.4, "MS.Reservas", [("hold · reserva · EMITIR BOLETOS", True), ("CAMBIAR ASIENTOS · check-in · pases", True),
                                           ("asistencia · 12 operaciones", False)], ORANGE, "#fbeae0", True),
    ("postventa", 48.0, 6.0, "MS.Postventa", [("maletas · cambio de fecha", False), ("cotizar · cancelar (reasonCode)", True)], ORANGE, "#fbeae0", True),
    ("admin", 33.0, 11.0, "MS.Admin", [("usuarios · precios y DESCUENTO MÁX.", True), ("rutas · flota · asistencia por vuelo", False),
                                      ("telemetría · alertas · eventos", False), ("estado y ocupación de vuelos", True),
                                      ("→ los usa vía MS.Vuelos", True)], TEAL, "#e2f4ef", True),
]
RY = {}
for key, yc, h, name, lines, ec, fc, changed in resp:
    RY[key] = yc
    box(RL, yc - h / 2, RR - RL, h, fc, NEW if changed else ec, lw=2.2, z=2)
    ax.text(RCX, yc + h / 2 - 1.3, name, ha="center", fontsize=11, fontweight="bold", zorder=3)
    for i, (line, new) in enumerate(lines):
        ax.text(RCX, yc + h / 2 - 2.8 - i * 1.3, line, ha="center", fontsize=7.8, zorder=3,
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
for yy, t, kw in [
    (78.4, "REST  /api/v2/vuelos/*", dict(fontsize=10.5, fontweight="bold", color=NEW)),
    (77.0, "contrato v2 de Booking", dict(fontsize=8.5, color=NEW, fontweight="bold")),
    (75.8, "30 operaciones · Swagger /api/docs", dict(fontsize=8.3)),
    (74.6, "sin /api/v1: lo reemplaza el v2", dict(fontsize=8.3, color=NEW, fontweight="bold")),
    (69.5, "GraphQL  /api/graphql", dict(fontsize=10.5, fontweight="bold")),
    (68.1, "única entrada de la web", dict(fontsize=8.5)),
    (62.0, "TOKEN DE PARTNER", dict(fontsize=8.6, color=NEW, fontweight="bold")),
    (60.8, "OAuth2 client_credentials", dict(fontsize=8.3, color=NEW, fontweight="bold")),
    (59.6, "/api/v2/oauth2/token → Identity", dict(fontsize=8.3, color=NEW, fontweight="bold")),
    (58.4, "+ X-User-Id del usuario final", dict(fontsize=8.3, color=NEW, fontweight="bold")),
    (53.5, "JWT de la web: JWKS", dict(fontsize=8.3)),
    (52.3, "de Identity · scopes por rol", dict(fontsize=8.3)),
    (51.1, "(CLIENTE · ADMIN)", dict(fontsize=8.3)),
    (45.0, "X-CORRELATION-ID:", dict(fontsize=8.5, color=NEW, fontweight="bold")),
    (43.8, "lo recibe de Booking o lo crea;", dict(fontsize=8.3, color=NEW, fontweight="bold")),
    (42.6, "lo devuelve siempre", dict(fontsize=8.3, color=NEW, fontweight="bold")),
    (36.5, "rate limit · CORS · helmet", dict(fontsize=8.3)),
    (35.3, "OTLP · min. 1 réplica", dict(fontsize=8.3, color=NEW, fontweight="bold")),
    (34.1, "(Booking: timeout 5 s)", dict(fontsize=8.3, color=NEW, fontweight="bold")),
]:
    ax.text(GC, yy, t, ha="center", **kw)
for key, yc in RY.items():
    path([(GL, yc), (RR, yc)], "#444444", lw=1.5)

# UI · PWA (web propia)
box(115.6, 57, 12, 26.5, "#fbe9f0", "#c2185b", lw=2.0)
ax.text(121.6, 80.8, "UI · PWA", ha="center", fontsize=14, fontweight="bold")
ax.text(121.6, 79.0, "ecoairlines-web (React)", ha="center", fontsize=8.8)
for i, (line, new) in enumerate([("manifest · instalable", False), ("service worker (Workbox)", False), ("offline: pases y «Mis viajes»", False),
                                 ("", False), ("pago: tarjeta → Payment API", False), ("(canal directo: AIRLINE_DIRECT)", True), ("", False),
                                 ("admin: usuarios, precios y", False), ("descuento, operaciones,", True), ("asistencia, telemetría", False)]):
    ax.text(121.6, 76.6 - i * 1.6, line, ha="center", fontsize=8.3, color=NEW if new else "#333333", fontweight="bold" if new else "normal")
path([(115.6, 69.5), (GR, 69.5)], "#333333", lw=1.9, label="GraphQL", lfrac=0.5)

# Booking Prototipo (sistema externo)
BKL, BKR = 115.6, 127.6
box(BKL, 24.5, BKR - BKL, 29.5, "#efebe9", NEW, lw=2.6)
ax.text(121.6, 51.6, "Booking Prototipo", ha="center", fontsize=12.5, fontweight="bold", color=BROWN)
ax.text(121.6, 50.1, "agregador del grupo (RDA2)", ha="center", fontsize=8.5)
for i, (line, new) in enumerate([("cobra al cliente: envía", True), ("paymentReference", True), ("",False),
                                 ("→ llama al contrato v2", False), ("← recibe webhooks CloudEvents", False),
                                 ("← recibe stock (gRPC, Offers)", False), ("→ publica payment.* y", False), ("   package.cancelled", False),
                                 ("", False), ("Autos · Alojamientos ·", False), ("Facturación consumen", False), ("nuestros eventos", False)]):
    ax.text(121.6, 48.0 - i * 1.4, line, ha="center", fontsize=8.0, color=NEW if new else "#333333", fontweight="bold" if new else "normal")
path([(BKL, 45.0), (GR, 45.0)], "#333333", lw=1.9, label="REST", lfrac=0.5)

# ================= Integración con Booking (marrón): carriles por debajo de todo =================
ADP_Y2 = 18.6
# stock: MS.G.Offers → Booking (gRPC, D33)
SY = Y["offers"] - 1.9
path([(14.3, SY), (12.8, SY), (12.8, -5.0), (128.5, -5.0), (128.5, 30.0), (BKR, 30.0)], BROWN, ls=DASHDOT, lw=2.0,
     label="gRPC desde Offers: inventory.InventoryStockService/PushStockUpdate (item_id = vuelo-cabina, available_units)", lseg=2, lfrac=0.5, fs=8.3)
# eventos de Booking → ESB
path([(BKR, 32.5), (129.3, 32.5), (129.3, -6.1), (76.3, -6.1), (76.3, ADP_Y2), (PR, ADP_Y2)], BROWN, ls=DASHDOT, lw=2.0,
     label="eventos de Booking → ESB: payment.confirmed · payment.failed · package.cancelled", lseg=2, lfrac=0.5, fs=8.3)
# webhooks: MS.G.Webhooks → Booking
WY = Y["webhooks"] - 1.9
path([(14.3, WY), (12.25, WY), (12.25, -7.2), (130.1, -7.2), (130.1, 35.0), (BKR, 35.0)], BROWN, ls=DASHDOT, lw=2.0,
     label="webhooks: POST de CloudEvents firmados (HMAC-SHA256) · reintentos 1 min → 6 h · respaldo: GET /vuelos/eventos", lseg=2, lfrac=0.42, fs=8.3)

# ================= 6. Observabilidad =================
box(79.2, -3, 19.2, 23.6, "#eceff1", "#455a64", lw=2.0, ls="--")
ax.text(88.8, 19.0, "6. Observabilidad", ha="center", fontsize=11.5, fontweight="bold", color="#263238")
for i, (line, bold, new) in enumerate([
    ("OpenTelemetry Collector", True, False), ("recibe OTLP de TODOS los servicios", False, False),
    ("cada log: correlation_id · request_id ·", False, True), ("service · operation · status · latency_ms", False, True),
    ("(como api_request_logs de Booking)", False, True),
    ("", False, False), ("Prometheus · métricas", False, False), ("Tempo / Jaeger · trazas", False, False), ("Loki · logs", False, False),
    ("Alertmanager · alertas", False, False), ("Grafana · tableros", False, False), ("En Azure: Application Insights", True, False),
]):
    ax.text(88.8, 17.2 - i * 1.4, line, ha="center", fontsize=8.2, fontweight="bold" if (bold or new) else "normal",
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
                                 ("#f6ead2", "#8a5300", "MS.G SOA (PostSale)"), ("white", NEW, "Borde rojo: nuevo o modificado en v4")]):
    yy = 7.4 - i * 1.5
    ax.add_patch(Rectangle((101.7, yy - 0.55), 3.5, 1.1, fc=fc, ec=ec, lw=1.8))
    ax.text(106.0, yy, t, fontsize=9, va="center")
ax.text(101.7, 1.0, "Cada línea conserva el color de su grupo · • = unión con su bus", fontsize=7.8, color="#555555")
ax.text(101.7, -0.3, "Morado: flecha HACIA el bus = publica · DESDE el bus = consume", fontsize=7.8, color=PURPLE, fontweight="bold")
ax.text(101.7, -1.6, "Booking entra solo por /api/v2/vuelos · le hablan Offers, Webhooks y ESB", fontsize=7.8, color=NEW, fontweight="bold")

fig.savefig(OUT, dpi=100, bbox_inches="tight", facecolor="white")
print("ok", OUT)
