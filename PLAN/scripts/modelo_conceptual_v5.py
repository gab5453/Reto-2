"""Modelo conceptual v5 de EcoAirlines (Reto 2): las tablas que de verdad crea cada servicio (CREATE TABLE del código, 03/11/2026).
Base: la v4, que era el diseño previo. En rojo, lo nuevo o corregido al implementarlo."""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

OUT = sys.argv[1]
NEW = "#d32f2f"          # nuevo o corregido en v5 (lo implementado difiere del diseño v4)
CORR = "#e65100"         # correlation ID
REF = "#7a7a7a"          # referencias entre servicios
FK = "#333333"           # relaciones dentro del servicio
ROW_H = 1.75
HEAD_H = 2.3

fig, ax = plt.subplots(figsize=(20, 30))
ax.set_xlim(0, 200)
ax.set_ylim(298, 0)
ax.axis("off")
T = {}


def group(x, y, w, h, title, schema, color, fill, changed=False, dashed=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=1.6", fc=fill,
                                ec=NEW if changed else color, lw=2.4 if changed else 1.8, ls="--" if dashed else "-", zorder=1))
    ax.text(x + w / 2, y + 2.1, title, ha="center", va="center", fontsize=13, fontweight="bold", color=color, zorder=5)
    ax.text(x + w / 2, y + 4.1, schema, ha="center", va="center", fontsize=8.5, color=color, zorder=5)


def table(key, x, y, w, title, rows, color, new=False, doc=False):
    h = HEAD_H + ROW_H * len(rows) + 0.4
    ec = NEW if new else color
    ax.add_patch(Rectangle((x, y), w, h, fc="#fffdf5" if doc else "white", ec=ec, lw=1.8 if new else 1.2, ls="--" if doc else "-", zorder=4))
    ax.add_patch(Rectangle((x, y), w, HEAD_H, fc=ec, ec=ec, zorder=4))
    ax.text(x + w / 2, y + HEAD_H / 2, title, ha="center", va="center", fontsize=9.3, fontweight="bold", color="white", zorder=5)
    for i, (name, tag, flag) in enumerate(rows):
        ry = y + HEAD_H + 0.2 + ROW_H * (i + 0.5)
        c = CORR if flag == "corr" else (NEW if (flag or new) else "black")
        bold = bool(flag or new)
        ax.text(x + 0.8, ry, name, ha="left", va="center", fontsize=7.8, zorder=5, color=c, fontweight="bold" if bold else "normal")
        if tag:
            ax.text(x + w - 0.8, ry, tag, ha="right", va="center", fontsize=7.4, fontweight="bold", zorder=5,
                    color=c if bold else ("#555555" if tag.endswith("ref") else color))
    T[key] = (x, y, w, h)


def top(k, f=0.5):
    x, y, w, h = T[k]; return (x + w * f, y)


def bottom(k, f=0.5):
    x, y, w, h = T[k]; return (x + w * f, y + h)


def left(k, yy):
    return (T[k][0], yy)


def right(k, yy):
    return (T[k][0] + T[k][2], yy)


def path(points, cross=False, label="", lseg=0, lfrac=0.5, arrow=True, color=None):
    color = color or (REF if cross else FK)
    ls = (0, (4, 3)) if cross else "-"
    xs, ys = zip(*points)
    ax.plot(xs, ys, color=color, lw=1.3, ls=ls, zorder=2)
    if arrow:
        ax.annotate("", xy=points[-1], xytext=points[-2], zorder=3,
                    arrowprops=dict(arrowstyle="-|>", color=color, lw=1.3, shrinkA=0, shrinkB=0, mutation_scale=14))
    if label:
        (x1, y1), (x2, y2) = points[lseg], points[lseg + 1]
        ax.text(x1 + (x2 - x1) * lfrac, y1 + (y2 - y1) * lfrac, label, fontsize=7.6, color=color, ha="center", va="center",
                zorder=6, bbox=dict(fc="white", ec="none", pad=0.5))


def note(x, y, text, ha="center", color=NEW):
    ax.text(x, y, text, fontsize=7.5, color=color, ha=ha, va="center", style="italic", zorder=6)


ax.text(100, 2.3, "EcoAirlines — Modelo de datos por microservicio (v5 · las tablas que crea el código, 03/11/2026)", ha="center", fontsize=17, fontweight="bold")
ax.text(100, 5.0, "Base: la v4 (el diseño). En rojo, lo que cambió al implementarlo: agregados como documento JSONB · asientos por reserva · "
        "contadores por estado · idempotencia de sagas y consumidores", ha="center", fontsize=10, color=NEW)
ax.text(100, 7.0, "En naranja: correlation_id = X-Correlation-Id del proceso (lo crea Booking o nuestro gateway; nunca cambia)",
        ha="center", fontsize=10, color=CORR, fontweight="bold")

# ===================== columna izquierda =====================
C = "#455a64"
group(3, 9, 40, 61, "Identity · usuarios y partners", "base: identity · REST", C, "#eef2f4", changed=True)
table("users", 9, 15.5, 28, "users", [("sub", "PK", False), ("email", "UK", False), ("password_hash (scrypt)", "", False),
      ("full_name", "", False), ("role_id (un solo rol)", "FK", False), ("status (ACTIVO / BLOQUEADO)", "", False),
      ("created_by · updated_by", "ref", False), ("last_login_at", "", True)], C)
table("roles", 5, 35, 18, "roles", [("role_id", "PK", False), ("name", "UK", False), ("display_name", "", True), ("description", "", False)], C)
table("rscopes", 25, 35, 16, "role_scopes", [("role_id", "FK", False), ("scope", "", False)], C)
table("partners", 7, 47.5, 32, "partner_clients", [("client_id", "PK", False), ("name (BOOKING_PROTOTIPO)", "", False),
      ("secret_hash (scrypt)", "", False), ("scopes", "", False), ("status", "", False), ("created_by · updated_by", "ref", False),
      ("secret_rotated_at · last_token_at", "", True)], C)
note(23, 66.0, "clientes de servicio (ESB y 5 MS) por semilla: D41, D44")
note(23, 67.8, "ADMIN suma flights:ops y flights:admin", color="#555555")

C = "#5b4bb7"
group(3, 74, 40, 21, "Customers", "base: customers · REST", C, "#efedfb", changed=True)
table("profiles", 9, 80.5, 28, "profiles", [("owner_id", "PK·ref", False), ("data (JSONB): nombre · documento", "", True),
      ("contacto · nacimiento", "", True), ("default_assistance", "", False), ("updated_at", "", False)], C)

C = "#5f6058"
group(3, 99, 40, 58, "Webhooks", "base: webhooks · consume webhooks.events", C, "#f1f1ec", changed=True)
table("subs", 9, 105.5, 28, "subscriptions", [("id", "PK", False), ("owner_id (partner)", "ref", False), ("url", "", False),
      ("events", "", False), ("secret_encrypted (cifrado)", "", True), ("active · created_at", "", False)], C)
table("deliv", 9, 122, 28, "deliveries", [("event_seq", "FK", True), ("subscription_id", "FK", False), ("outcome · http_status", "", False),
      ("attempts · last_attempt_at", "", False), ("next_retry_at (1 min → 6 h)", "", False), ("delivered_at", "", True)], C)
table("evlog", 9, 139, 28, "event_log (feed /eventos)", [("seq (cursor)", "PK", False), ("id (CloudEvent)", "UK", False),
      ("type · name · subject · time", "", False), ("owner_id · public", "", True), ("event (JSONB)", "", True), ("correlation_id", "", "corr")], C)

C = "#7a7a7a"
group(3, 161, 40, 76, "Payment API · tarjeta", "EXTERNO simulado · solo canal web", C, "#fafafa", changed=True)
table("pmeth", 9, 167.5, 28, "payment_methods", [("token", "PK", False), ("brand · last4", "", False), ("exp_month · exp_year", "", False),
      ("outcome (tarjeta de prueba)", "", True), ("expires_at · used_at (un uso)", "", True)], C)
table("pays", 9, 182, 28, "payments", [("payment_reference", "PK", False), ("status (AUTHORIZED…)", "", False), ("amount · currency", "", False),
      ("card_brand · card_last4", "", True), ("captured_amount · captured_at", "", True), ("order_id · operation", "", True),
      ("refunded_cents · voided_at", "", True), ("correlation_id", "", "corr")], C)
table("payref", 9, 202, 28, "used_references", [("payment_reference", "FK", False), ("order_id · operation", "", False), ("captured_at", "", False)], C)
table("prefund", 9, 213, 28, "refunds", [("refund_id", "PK", True), ("payment_reference", "FK", True), ("amount · reason", "", True),
      ("order_id · status", "", True)], C, new=True)
table("pidem", 9, 226, 28, "idempotency_keys", [("scope · key", "PK", True), ("request_hash · status · body", "", True)], C, new=True)

# ===================== Schedule y Flight status =====================
C = "#1f5fa6"
group(52, 9, 98, 59, "Schedule (admin)", "base: schedule · REST · red, flota, precios y acuerdo B2B", C, "#e4f0fa", changed=True)
table("routes", 56, 15.5, 30, "scheduled_routes", [("route_id", "PK", False), ("origin · destination", "", False),
      ("outbound_flight · departure", "UK", True), ("inbound_flight · departure", "UK", True), ("weekdays", "", False),
      ("aircraft_type · source", "", False), ("updated_by", "ref", False)], C)
table("rair", 92, 15.5, 24, "route_aircraft", [("route_id", "FK", False), ("registration", "FK", False), ("position", "", False)], C)
table("aircraft", 121, 15.5, 25, "aircraft", [("registration", "PK", False), ("aircraft_type", "", False), ("base · source", "", False),
      ("updated_by", "ref", True)], C)
table("meta", 63, 33.5, 17, "schedule_meta", [("id", "PK", True), ("version (optimista)", "", True)], C, new=True)
table("fcp", 92, 28.5, 27, "fare_class_prices", [("cabin_class", "PK", False), ("fare_brand", "PK", False), ("reference_multiplier", "", False),
      ("multiplier (vigente)", "", False), ("updated_by", "ref", False), ("updated_at", "", False)], C)
table("pchg", 122, 28.5, 25, "price_changes", [("id", "PK", False), ("cabin_class", "FK", False), ("fare_brand", "FK", False),
      ("old → new multiplier", "", False), ("changed_by", "ref", False), ("changed_at", "", False)], C)
table("promo", 121, 45.5, 27, "promotion_agreements", [("partner_id", "PK", False), ("allows_promotions", "", False),
      ("max_discount_percentage (≤ 50)", "", False), ("enabled_routes · destinations", "", False), ("enabled_cabins", "", False),
      ("valid_until · combo_conditions", "", False), ("updated_by · updated_at", "ref", False)], C)
note(63, 47.5, "El acuerdo se edita en «Precios por clase» (admin).", ha="left", color="#1f5fa6")
note(63, 49.2, "Booking lo consulta: GET /vuelos/promociones/contrato.", ha="left", color="#1f5fa6")
note(63, 50.9, "Se publica a Offers con los precios (PublishFarePrices).", ha="left", color="#1f5fa6")

C = "#16705a"
group(156, 9, 41, 59, "Flight status", "base: flight_status · REST", C, "#e3f4ee", changed=True)
table("schedf", 161, 15.5, 31, "scheduled_flights (proyección)", [("flight_number", "PK", False), ("date", "PK", False),
      ("route_id · registration", "", True), ("origin · destination", "", False), ("departure_at · departure_utc", "", True), ("arrival_at · aircraft_type", "", False)], C)
table("over", 161, 31.5, 31, "overrides", [("flight_number", "PK", False), ("date", "PK", False), ("state (JSONB): status · puerta", "", True),
      ("hora estimada · demora · motivo", "", True)], C)
table("fsch", 161, 44, 31, "status_changes", [("change_id", "PK", False), ("flight_number · date", "", False), ("changed_at · reverted", "", True),
      ("data: anterior → nuevo · motivo · autor", "", True)], C)
table("applied", 161, 56.5, 31, "applied_events", [("event_id (schedule.published)", "PK", True), ("applied_at", "", True)], C, new=True)

# ===================== Offers =====================
C = "#8a5300"
O = 72
group(52, O, 145, 50, "Offers · gRPC", "base: offers · inventario, precios, holds y stock", C, "#f8ecd8", changed=True)
table("ffs", 55, O + 8, 28, "flights_for_sale", [("segment_id", "PK", False), ("flight_number · date", "", False), ("route_id", "", True),
      ("origin · destination", "", True), ("departure_at · departure_utc", "", False), ("arrival_at", "", False),
      ("aircraft_type · registration", "", False), ("on_sale · closed_reason", "", True)], C)
table("holds", 86, O + 8, 28, "holds", [("hold_id", "PK", False), ("owner_id", "ref", False), ("channel (WEB / BOOKING)", "", False),
      ("status · ttl_minutes (5–30)", "", False), ("offer_id · expires_at", "", False), ("booking_id", "ref", True),
      ("data (JSONB): tarifas · precio", "", True)], C)
table("inv", 142, O + 8, 26, "inventory", [("segment_id", "PK·FK", False), ("cabin_class", "PK", False), ("total", "", False),
      ("held · booked · ticketed", "", True), ("checked_in · boarded", "", True), ("CHECK: suma ≤ total", "", True)], C)
table("bseats", 171, O + 8, 24, "booking_seats", [("id", "PK", True), ("booking_id", "ref", True), ("segment_id · cabin_class", "", True),
      ("status (HELD…BOARDED)", "", True), ("passenger_id", "", True), ("seat_number (único)", "UK", True)], C, new=True)
table("oout", 55, O + 30, 28, "outbox", [("id", "PK", False), ("type (hold.created / expired)", "", False), ("event (CloudEvent)", "", True),
      ("owner_id · published_at", "", False)], C)
table("hseg", 86, O + 28, 22, "hold_segments", [("hold_id", "FK", True), ("segment_id", "FK", True)], C, new=True)
table("sres", 86, O + 37.5, 22, "saga_results", [("key (saga_id)", "PK", True), ("result", "", True)], C, new=True)
table("fprice", 112, O + 28, 25, "fare_prices (copia)", [("cabin_class", "PK", False), ("fare_brand", "PK", False), ("multiplier", "", False)], C)
table("prules", 140, O + 28, 27, "promotion_rules (copia)", [("partner_id", "PK", True), ("allows_promotions", "", True),
      ("max_discount_percentage", "", True), ("routes · cabins · valid_until", "", True)], C, new=True)
table("ostock", 170, O + 28, 26, "stock_sync", [("segment_id · cabin_class", "PK", False), ("flight_number · date · time_slot", "", False),
      ("units · version", "", True), ("pending · attempts", "", True), ("next_attempt_at · last_error", "", True),
      ("pushed_units · pushed_at", "", True), ("correlation_id", "", "corr")], C)
note(140, O + 47.3, "Stock a Booking por REST (D53): POST booking-core-api…/api/v2/inventory/stock · service_id NODE_VUE_EQ5;")
note(140, O + 48.9, "reintenta 1 s → 60 s si Booking no responde; los vuelos que ya salieron no se envían. Seats de la v4 → booking_seats.")

# ===================== Bookings =====================
C = "#9c3418"
B = 126
group(52, B, 145, 48, "Bookings", "base: bookings · REST · la reserva es UN documento (agregado)", C, "#f9ebe6", changed=True)
table("bk", 55, B + 7.5, 32, "bookings", [("booking_id", "PK", False), ("pnr", "UK", False), ("hold_id", "ref", False), ("owner_id", "ref", False),
      ("channel (WEB / BOOKING)", "", True), ("partner_id", "", True), ("status (8 estados)", "", False), ("created_at · updated_at", "", False),
      ("data (JSONB) →", "", True)], C)
table("bdoc", 92, B + 7.5, 58, "data · documento de la reserva (JSONB, dentro de bookings)", [
      ("passengers (tipo, nombre, documento, contacto) · itineraries", "", True),
      ("fares (cabina, familia, precio) · grandTotal", "", True),
      ("payment (referencia, provider)", "", True),
      ("salesChannel (partner, orden, combo, promoción)", "", True),
      ("tickets (+ cupones; ISSUED … VOIDED, failure_reason)", "", True),
      ("changes (historial) · refunds (CALCULATED / SETTLED)", "", True),
      ("checkedIn · cancellation · failure", "", True),
      ("en la v4 eran 10 tablas: una reserva se lee y guarda entera", "", True)], C, doc=True)
table("bseg", 152.5, B + 7.5, 18, "booking_segments", [("booking_id", "FK", True), ("segment_id", "ref", True)], C, new=True)
table("pdocs", 172.5, B + 7.5, 24, "passenger_documents", [("segment_id", "PK", True), ("identity_key", "PK", True), ("booking_id", "FK", True)], C, new=True)
note(184.5, B + 18.5, "un documento no viaja", color="#9c3418")
note(184.5, B + 20.0, "dos veces en el mismo vuelo", color="#9c3418")
table("precs", 55, B + 30.5, 32, "payment_records", [("payment_reference (única)", "PK", False), ("provider (BOOKING / DIRECT)", "", False),
      ("operation (BOOKING, SEAT…)", "", False), ("amount", "", False), ("booking_id · saga_id", "FK", True), ("claimed_at", "", True)], C)
table("assist", 92, B + 30.5, 34, "passenger_assistance", [("booking_id · passenger_id", "PK", True), ("type (WCHR, MEDA…)", "", False),
      ("needs_companion · notes", "", False), ("status · updated_at", "", False)], C)
note(162, B + 33, "Booking cobra: aquí solo se registra la referencia", ha="center")
note(162, B + 34.6, "recibida (no reutilizada, monto exacto) y el reembolso", ha="center")
note(162, B + 36.2, "que se CALCULA; Booking lo ejecuta. La web: Payment API.", ha="center")
note(162, B + 39.5, "Asistencia médica en tabla aparte: es un dato de salud", ha="center", color="#9c3418")
note(162, B + 41.1, "que no viaja en webhooks, logs ni trazas.", ha="center", color="#9c3418")

# ===================== Post-sale, Check-in, ESB =====================
C = "#9b2c55"
group(52, 178, 68, 31, "Post-sale · SOA (SOAP/WSDL)", "base: post_sale", C, "#fbe8ef", changed=True)
table("cq", 55, 185.5, 31, "cancellation_quotes", [("quote_id", "PK", False), ("booking_id", "ref", False), ("status · saga_id", "", True),
      ("expires_at (15 min)", "", False), ("data (JSONB): reembolso ·", "", True), ("penalidad · penalty_waived", "", False)], C)
table("dco", 89, 185.5, 28, "date_change_offers", [("change_offer_id", "PK", False), ("booking_id", "ref", False), ("status · saga_id", "", True),
      ("expires_at", "", False), ("data (JSONB)", "", True)], C)
note(86, 205.8, "+ saga_results (idempotencia por saga, como en Offers)")

C = "#3d6b12"
group(124, 178, 36, 35, "Check-in", "base: check_in · REST", C, "#ecf4e2", changed=True)
table("ci", 126.5, 185.5, 31, "check_ins", [("booking_id · segment_id", "PK", False), ("passenger_id", "PK", False), ("saga_id · pnr", "", True),
      ("pasajero · e_ticket_number", "", True), ("vuelo · ruta · salida", "", True), ("cabin_class · seat · gate", "", False),
      ("boarding_group · position", "", False)], C)
table("ar", 126.5, 203.5, 31, "assistance_ready", [("booking · segment · passenger", "PK", True), ("ready · updated_by", "", True)], C, new=True)

C = "#5a5a5a"
group(163, 178, 34, 74, "ESB", "base: esb · datos técnicos", C, "#f3f3f3", changed=True)
table("idem", 165, 185.5, 30, "idempotency_claims", [("scope · idempotency_key", "PK", True), ("request_hash", "", False),
      ("lease_until", "", True), ("response status · headers · body", "", False)], C)
table("saga", 165, 197.5, 30, "saga_log", [("saga_id", "PK", False), ("type · status", "", False), ("steps (JSONB)", "", True),
      ("owner_id · actor_id", "", True), ("parent_saga_id · attempts", "", True), ("correlation_id", "", "corr")], C)
table("eout", 165, 213, 30, "outbox", [("seq · id", "PK", True), ("type (CloudEvents)", "", False), ("event · owner_id", "", True),
      ("published_at", "", False)], C)
table("inbound", 165, 225, 30, "inbound_events", [("id (CloudEvent)", "PK", False), ("type · source · booking_id", "", True),
      ("channel (WEBHOOK / AMQP)", "", True), ("status · attempts", "", True), ("correlation_id", "", "corr")], C)
table("chgo", 165, 238.5, 30, "change_offers", [("change_offer_id", "PK", True), ("booking_id · data · expires_at", "", True)], C, new=True)

# ===================== Telemetría =====================
C = "#37474f"
group(52, 217, 109, 35, "Telemetría · OpenTelemetry (no es una base: pila propia en la VM, D50)",
      "Prometheus (métricas) · Tempo (trazas) · Loki (logs) · Alertmanager · Grafana", C, "#eceff1", changed=True, dashed=True)
table("tmet", 55, 224, 24, "métricas (Prometheus)", [("http_server_request_…", "", False), ("ecoairlines_* (sagas, stock…)", "", True),
      ("service_name · labels", "", False), ("valor · timestamp", "", False)], C)
table("tspan", 81.5, 224, 24, "trazas (Tempo)", [("trace_id · span_id", "", False), ("correlation_id (atributo)", "", "corr"),
      ("service · duración · status", "", False)], C)
table("tlog", 108, 224, 25, "logs (Loki, JSON)", [("correlation_id", "", "corr"), ("request_id · trace_id", "", False),
      ("service · operation", "", False), ("status · latency_ms", "", False)], C)
table("talert", 135.5, 224, 23, "alertas (12 reglas)", [("alerts.yml (versionado)", "", True), ("ServicioCaido · NodoDown", "", False),
      ("StockSinEnviar · …", "", True)], C)
note(106.5, 248.5, "Nunca se registran tokens, tarjetas ni datos de salud.", color="#37474f")

# ===================== relaciones dentro de cada servicio (FK real) =====================
path([top("roles", 0.5), bottom("users", 0.179)], label="1:N")
path([right("roles", 40.5), left("rscopes", 40.5)], label="1:N")
path([bottom("pays"), top("payref")], label="1:1")
path([bottom("payref"), top("prefund")], label="1:N")
path([right("routes", 23.2), left("rair", 23.2)])
path([left("aircraft", 23.2), right("rair", 23.2)])
path([bottom("subs"), top("deliv")])
path([top("evlog"), bottom("deliv")])
path([right("fcp", 35.2), left("pchg", 35.2)], label="1:N")
path([bottom("schedf"), top("over")])
path([bottom("over"), top("fsch")], label="1:N")
path([bottom("ffs", 0.9), (80.2, O + 26.5), (155, O + 26.5), bottom("inv")], label="1:N", lseg=1, lfrac=0.5)
path([(155, O + 26.5), (183, O + 26.5), bottom("bseats")])
path([bottom("holds", 0.4), top("hseg", 0.4)], label="1:N")
path([right("bk", B + 22.5), left("bdoc", B + 22.5)])
path([bottom("bk", 0.5), top("precs", 0.5)], label="1:N")
path([bottom("bk", 0.95), (85.4, B + 28.5), (109, B + 28.5), top("assist", 0.5)], label="1:N", lseg=1, lfrac=0.5)
path([top("bk", 0.95), (85.4, B + 6.2), (161.5, B + 6.2), top("bseg", 0.5)], label="1:N", lseg=1, lfrac=0.82)
path([(161.5, B + 6.2), (184.5, B + 6.2), top("pdocs", 0.5)])
path([bottom("ci", 0.5), top("ar", 0.5)])

# ===================== referencias entre servicios (solo por id) =====================
TR = 47.5
path([right("users", 23), (TR, 23), (TR, B + 4.5)], cross=True, arrow=False)
path([right("partners", 57), (TR, 57)], cross=True, arrow=False)
ax.text(TR - 1.3, 108, "owner_id = sub del JWT  o  partner:<client_id>:<X-User-Id>", rotation=90, fontsize=8.3, color="#555555", fontweight="bold",
        ha="center", va="center", bbox=dict(fc="white", ec="none", pad=0.4), zorder=6)
path([(TR, 86), right("profiles", 86)], cross=True)
path([(TR, 112), right("subs", 112)], cross=True)
path([(TR, O + 5.5), (97.2, O + 5.5), top("holds", 0.4)], cross=True)
path([(TR, B + 4.5), (60, B + 4.5), top("bk", 0.16)], cross=True)
for yy in (23, 57, O + 5.5, 86, 112, B + 4.5):
    ax.plot([TR], [yy], "o", color=REF, ms=4, zorder=3)

path([bottom("routes", 0.13), top("ffs", 0.18)], cross=True, label="gRPC PublishTimetable", lfrac=0.82)
path([bottom("fcp", 0.96), (117.9, O + 28)], cross=True, label="gRPC PublishFarePrices (precios + reglas de promoción)", lfrac=0.5)
path([bottom("routes", 0.95), (84.5, 43.3), (153, 43.3), (153, 22.5), left("schedf", 22.5)], cross=True,
     label="evento schedule.published (bus)", lseg=1, lfrac=0.5)
path([(58, 176), top("cq", 0.1)], cross=True, label="booking_id", lfrac=0.12)
path([(114, 176), top("dco", 0.9)], cross=True, label="booking_id", lfrac=0.12)
path([(130, 176), top("ci", 0.11)], cross=True, label="booking_id · segment_id", lfrac=0.12)
for xx in (58, 114, 130):
    ax.plot([xx], [176], "o", color=REF, ms=4, zorder=3)

# ===================== leyenda =====================
ax.add_patch(Rectangle((3, 241), 40, 47, fc="white", ec="#999999", lw=1))
ax.text(5, 244, "Leyenda", fontsize=11, fontweight="bold")
legend = [
    ("——", FK, "Relación dentro del servicio (FK real)"),
    ("- - -", REF, "Referencia entre servicios (solo id)"),
    ("•", REF, "Punto donde sale una referencia"),
    ("PK / FK / UK", FK, "primaria / foránea / única"),
    ("ref", "#555555", "id de OTRO servicio (no es FK)"),
    ("rojo", NEW, "tabla o campo nuevo o corregido en v5"),
    ("borde rojo", NEW, "servicio cuyo modelo cambió"),
    ("naranja", CORR, "correlation_id (X-Correlation-Id)"),
    ("punteado", "#9c3418", "documento JSONB dentro de una tabla"),
]
for i, (sym, c, t) in enumerate(legend):
    yy = 248 + i * 3.5
    ax.text(5, yy, sym, fontsize=8.3, color=c, fontweight="bold", va="center")
    ax.text(17, yy, t, fontsize=7.7, va="center")
ax.text(5, 283, "Cada servicio crea sus tablas al arrancar\n(CREATE TABLE IF NOT EXISTS); sin DATABASE_URL\nfunciona en memoria (pruebas).",
        fontsize=7.6, va="center", color="#333333")

ax.add_patch(Rectangle((52, 256), 145, 34, fc="#fff3e0", ec=CORR, lw=2, zorder=1))
ax.text(124.5, 258.6, "Cómo viaja el correlation ID (una compra o un combo = un solo ID en todos los sistemas)",
        ha="center", fontsize=11.5, fontweight="bold", color=CORR)
steps = [
    ("1. Nace", "En el gateway de Booking (X-Correlation-Id). Si no llega, nuestro gateway lo crea. Nunca se modifica."),
    ("2. No se confunde", "X-Request-Id = un solo salto (lo genera cada servicio); trace_id = OpenTelemetry (la traza lo lleva como atributo)."),
    ("3. Viaja", "HTTP: X-Correlation-Id · gRPC: metadata x-correlation-id · SOAP: <CorrelationId> en <soap:Header> · RabbitMQ: correlation_id + correlationid · stock REST a Booking."),
    ("4. Se guarda", "Solo en datos técnicos: saga_log, inbound_events, event_log, stock_sync, payments (Payment API), y en los logs y trazas."),
    ("5. Se devuelve", "Cabecera X-Correlation-Id en toda respuesta, correlation_id en cada ProblemDetails y correlationid en cada CloudEvent."),
    ("6. Se consulta", "Panel admin → Telemetría, o Grafana → Loki {correlation_id=\"…\"} y Tempo: con un correlation_id se ven todos los pasos y la traza."),
]
for i, (k, v) in enumerate(steps):
    yy = 262.6 + i * 4.3
    ax.text(55, yy, k, fontsize=9, fontweight="bold", color=CORR, va="center")
    ax.text(73, yy, v, fontsize=8.1, color="#333333", va="center")

fig.savefig(OUT, dpi=110, bbox_inches="tight", facecolor="white")
print("ok", OUT)
