"""Modelo conceptual v4 de EcoAirlines (Reto 2): datos que exige el contrato de Vuelos v2 de Booking."""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

OUT = sys.argv[1]
NEW = "#d32f2f"          # nuevo o corregido en v4 (contrato v2)
CORR = "#e65100"         # correlation ID
REF = "#7a7a7a"          # referencias entre servicios
FK = "#333333"           # relaciones dentro del servicio
ROW_H = 1.75
HEAD_H = 2.3

fig, ax = plt.subplots(figsize=(20, 30.5))
ax.set_xlim(0, 200)
ax.set_ylim(306, 0)
ax.axis("off")
T = {}


def group(x, y, w, h, title, schema, color, fill, changed=False, dashed=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=1.6", fc=fill,
                                ec=NEW if changed else color, lw=2.4 if changed else 1.8, ls="--" if dashed else "-", zorder=1))
    ax.text(x + w / 2, y + 2.1, title, ha="center", va="center", fontsize=13, fontweight="bold", color=color, zorder=5)
    ax.text(x + w / 2, y + 4.1, schema, ha="center", va="center", fontsize=8.5, color=color, zorder=5)


def table(key, x, y, w, title, rows, color, new=False):
    h = HEAD_H + ROW_H * len(rows) + 0.4
    ec = NEW if new else color
    ax.add_patch(Rectangle((x, y), w, h, fc="white", ec=ec, lw=1.8 if new else 1.2, zorder=4))
    ax.add_patch(Rectangle((x, y), w, HEAD_H, fc=ec, ec=ec, zorder=4))
    ax.text(x + w / 2, y + HEAD_H / 2, title, ha="center", va="center", fontsize=9.5, fontweight="bold", color="white", zorder=5)
    for i, (name, tag, flag) in enumerate(rows):
        ry = y + HEAD_H + 0.2 + ROW_H * (i + 0.5)
        c = CORR if flag == "corr" else (NEW if (flag or new) else "black")
        bold = bool(flag or new)
        ax.text(x + 0.8, ry, name, ha="left", va="center", fontsize=8, zorder=5, color=c, fontweight="bold" if bold else "normal")
        if tag:
            ax.text(x + w - 0.8, ry, tag, ha="right", va="center", fontsize=7.5, fontweight="bold", zorder=5,
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
        ax.text(x1 + (x2 - x1) * lfrac, y1 + (y2 - y1) * lfrac, label, fontsize=7.8, color=color, ha="center", va="center",
                zorder=6, bbox=dict(fc="white", ec="none", pad=0.5))


def note(x, y, text, ha="center", color=NEW):
    ax.text(x, y, text, fontsize=7.6, color=color, ha=ha, va="center", style="italic", zorder=6)


ax.text(100, 2.3, "EcoAirlines — Modelo conceptual de datos por microservicio (v4 · contrato de Vuelos v2 de Booking)", ha="center", fontsize=17, fontweight="bold")
ax.text(100, 5.0, "Base: la v3.1. En rojo, lo nuevo o corregido por el contrato v2: partner y token de servicio · acuerdo de promociones · estado por asiento · "
        "canal de venta · pagos recibidos · reembolsos · CloudEvents", ha="center", fontsize=10.2, color=NEW)
ax.text(100, 7.0, "En naranja: correlation_id = X-Correlation-Id de Booking (todo el proceso). Ya NO es igual al X-Request-Id ni al trace_id (corrección de la v3.1)",
        ha="center", fontsize=10.2, color=CORR, fontweight="bold")

# ===================== columna izquierda =====================
C = "#455a64"
group(3, 9, 40, 61, "Identity · usuarios y partners", "esquema: identity · REST · antes dev-auth", C, "#eef2f4", changed=True)
table("users", 9, 15.5, 28, "users", [("sub", "PK", False), ("email", "UK", False), ("password_hash", "", False),
      ("full_name", "", False), ("role_id (un solo rol)", "FK", False), ("status (ACTIVO/BLOQUEADO)", "", False), ("created_by", "ref", False)], C)
table("roles", 5, 35, 18, "roles", [("role_id", "PK", False), ("name", "UK", False), ("description", "", False)], C)
table("rscopes", 25, 35, 16, "role_scopes", [("role_id", "FK", False), ("scope", "", False)], C)
table("partners", 7, 49, 32, "partner_clients", [("client_id", "PK", True), ("name (BOOKING_PROTOTIPO)", "", True),
      ("secret_hash (scrypt)", "", True), ("scopes", "", True), ("status · created_by", "ref", True)], C, new=True)
note(23, 65.3, "partner: token client_credentials")
note(23, 67.3, "ADMIN suma flights:ops y flights:admin")

C = "#5b4bb7"
group(3, 74, 40, 28, "Customers", "esquema: customers · REST", C, "#efedfb")
table("profiles", 9, 80.5, 28, "profiles", [("owner_id", "PK·ref", False), ("first_name", "", False), ("last_name", "", False),
      ("document_type", "", False), ("document_number", "", False), ("birth_date", "", False), ("email", "", False), ("phone", "", False),
      ("default_assistance", "", False)], C)

C = "#5f6058"
group(3, 106, 40, 60, "Webhooks", "esquema: webhooks · REST · consume el bus", C, "#f1f1ec", changed=True)
table("subs", 9, 112.5, 28, "subscriptions", [("id", "PK", False), ("owner_id (partner)", "ref", True), ("url", "", False),
      ("events", "", False), ("secret (HMAC-SHA256)", "", True), ("active", "", True)], C)
table("deliv", 9, 129, 28, "deliveries", [("event_id", "FK", False), ("subscription_id", "FK", False), ("outcome · http_status", "", False),
      ("attempts", "", False), ("next_retry_at (1 min → 6 h)", "", True), ("correlation_id", "", "corr")], C)
table("evlog", 9, 145, 28, "event_log (feed /eventos)", [("seq (cursor after)", "PK", True), ("event_id (CloudEvent id)", "UK", True),
      ("type (CloudEvents)", "", True), ("subject · occurred_at", "", True), ("data", "", False), ("correlation_id", "", "corr")], C)

C = "#7a7a7a"
group(3, 170, 40, 50, "Payment API · tarjeta", "EXTERNO simulado · solo canal web", C, "#fafafa")
table("pmeth", 9, 176.5, 28, "payment_methods", [("token", "PK", False), ("holder_name", "", False), ("brand (Visa, MC, Amex)", "", False),
      ("last4", "", False), ("exp_month · exp_year", "", False)], C)
table("pays", 9, 191, 28, "payments", [("reference", "PK", False), ("token", "FK", False), ("amount · currency", "", False),
      ("status (AUTHORIZED…CAPTURED)", "", True)], C)
table("payref", 9, 205, 28, "used_references", [("reference", "FK", False), ("order_id · operation", "", True), ("captured_at", "", True)], C)

# ===================== Schedule y Flight status =====================
C = "#1f5fa6"
group(52, 9, 98, 59, "Schedule (admin)", "esquema: schedule · REST · red, flota, precios y acuerdo B2B", C, "#e4f0fa", changed=True)
table("routes", 56, 15.5, 30, "scheduled_routes", [("route_id", "PK", False), ("origin", "", False), ("destination", "", False),
      ("outbound_flight", "UK", False), ("inbound_flight", "UK", False), ("weekdays", "", False), ("aircraft_type", "", False), ("source", "", False)], C)
table("rair", 92, 15.5, 24, "route_aircraft", [("route_id", "FK", False), ("registration", "FK", False), ("position", "", False)], C)
table("aircraft", 121, 15.5, 25, "aircraft", [("registration", "PK", False), ("aircraft_type", "", False), ("base", "", False), ("source", "", False)], C)
table("fcp", 92, 28.5, 27, "fare_class_prices", [("cabin_class", "PK", False), ("fare_brand", "PK", False), ("reference_multiplier", "", False),
      ("multiplier (vigente)", "", False), ("updated_by", "ref", False), ("updated_at", "", False)], C)
table("pchg", 122, 28.5, 25, "price_changes", [("id", "PK", False), ("cabin_class", "FK", False), ("fare_brand", "FK", False),
      ("old → new multiplier", "", False), ("changed_by", "ref", False), ("changed_at", "", False)], C)
table("promo", 121, 45.5, 27, "promotion_agreements", [("partner_id", "PK", True), ("allows_promotions", "", True), ("max_discount_pct (0–50, admin)", "", True),
      ("routes · destinations · cabins", "", True), ("valid_until", "", True), ("combo_conditions", "", True), ("updated_by · updated_at", "ref", True)], C, new=True)
note(67, 52.5, "Se edita en «Precios por clase» (admin), máximo 50 %.", ha="left")
note(67, 54.0, "Booking lo consulta: GET /vuelos/promociones/contrato.", ha="left")
note(67, 55.5, "Se publica a Offers junto con los precios (PublishFarePrices).", ha="left")

C = "#16705a"
group(156, 9, 41, 59, "Flight status", "esquema: flight_status · REST", C, "#e3f4ee", changed=True)
table("schedf", 161, 15.5, 31, "scheduled_flights (proyección)", [("flight_number", "PK", False), ("date", "PK", False), ("origin", "", False),
      ("destination", "", False), ("departure_at", "", False), ("arrival_at", "", False)], C)
table("over", 161, 31.5, 31, "overrides", [("flight_number", "PK", False), ("date", "PK", False), ("status", "", False),
      ("departure_gate", "", True), ("estimated_departure_at", "", True), ("delay_minutes · reason", "", True), ("updated_by", "ref", False)], C)
table("fsch", 161, 49.5, 31, "status_changes", [("id", "PK", True), ("flight_number · date", "", True), ("previous → new status", "", True),
      ("reason · changed_by", "ref", True)], C, new=True)

# ===================== Offers =====================
C = "#8a5300"
O = 73
group(52, O, 145, 47, "Offers · gRPC", "esquema: offers · inventario, precios y stock", C, "#f8ecd8", changed=True)
table("ffs", 55, O + 8, 26, "flights_for_sale", [("segment_id", "PK", False), ("flight_number", "", False), ("departure_at", "", False),
      ("arrival_at", "", False), ("aircraft_type", "", False)], C)
table("holds", 84, O + 8, 27, "holds", [("hold_id", "PK", False), ("owner_id", "ref", False), ("channel (WEB / BOOKING)", "", True),
      ("offer_id", "", False), ("status · ttl_minutes (5–30)", "", True), ("expires_at", "", False), ("locked_price", "", False)], C)
table("fsel", 114, O + 8, 27, "fare_selections", [("hold_id", "FK", False), ("itinerary_id", "", False), ("cabin_class", "", False),
      ("fare_brand", "", False), ("segment_ids", "", False), ("price", "", False)], C)
table("inv", 144, O + 8, 24, "inventory", [("segment_id", "FK", False), ("cabin_class", "", False), ("total_seats", "", True),
      ("conteo por estado", "", True), ("available = AVAILABLE", "", True)], C)
table("seats", 171, O + 8, 24, "seats", [("segment_id", "FK", False), ("seat_number", "", False), ("cabin_class", "", False),
      ("status (6 estados)", "", True), ("hold_id · booking_id", "ref", True)], C)
table("fprice", 114, O + 31, 31, "fare_prices (copia de lectura)", [("cabin_class", "PK", False), ("fare_brand", "PK", False),
      ("effective_multiplier", "", False), ("max_discount_pct (copia)", "", True), ("synced_at", "", False)], C)
table("oout", 168, O + 30, 27, "outbox", [("event_id", "PK", True), ("type (hold.created / expired)", "", True), ("published_at", "", True),
      ("correlation_id", "", "corr")], C, new=True)
note(101.5, O + 36, "copia escrita solo por\nel orquestador (gRPC)", color="#8a5300")
table("ostock", 147.5, O + 29, 19, "stock_sync", [("item_id (vuelo-cabina)", "", True), ("date · available_units", "", True),
      ("pushed_at · status", "", True)], C, new=True)
note(158, O + 44.6, "Offers envía el stock a Booking por gRPC (PushStockUpdate) tras\ncada hold, venta, liberación o cancelación; reintenta si Booking no responde")

# ===================== Bookings =====================
C = "#9c3418"
B = 126
group(52, B, 145, 66, "Bookings", "esquema: bookings · REST", C, "#f9ebe6", changed=True)
table("seg", 55, B + 8.5, 26, "segments", [("segment_id", "PK·ref", False), ("booking_id", "FK", False), ("flight_number", "ref", False), ("departure", "", False)], C)
table("bk", 84, B + 8.5, 26, "bookings", [("booking_id", "PK", False), ("pnr", "UK", False), ("owner_id", "ref", False),
      ("hold_id", "ref", False), ("status (8 estados)", "", True), ("grand_total", "", False)], C)
table("tk", 113, B + 8.5, 26, "tickets", [("ticket_id", "PK", False), ("booking_id", "FK", False), ("passenger_id", "FK", False),
      ("e_ticket_number", "", False), ("status (… VOIDED)", "", True), ("failure_reason", "", True)], C)
table("coup", 142, B + 8.5, 26, "ticket_coupons", [("ticket_id", "FK", False), ("segment_id", "", False), ("coupon_number", "", False), ("status", "", False)], C)
table("chg", 171, B + 8.5, 24, "booking_changes", [("booking_id", "FK", False), ("changed_at", "", False), ("description", "", False)], C)
table("seat_as", 55, B + 28, 26, "seat_assignments", [("passenger_id", "FK", False), ("segment_id", "FK", False), ("seat_number", "", False)], C)
table("pax", 84, B + 28, 26, "passengers", [("passenger_id", "PK", False), ("booking_id", "FK", False), ("passenger_type", "", False),
      ("first_name", "", False), ("document_number", "", False)], C)
table("bag", 113, B + 28, 26, "extra_baggage", [("passenger_id", "FK", False), ("itinerary_id", "", False), ("quantity", "", False)], C)
table("pfare", 142, B + 28, 26, "purchased_fares", [("booking_id", "FK", False), ("itinerary_id", "", False), ("cabin_class", "", False),
      ("fare_brand", "", False), ("price", "", False)], C)
table("assist", 171, B + 28, 24, "passenger_assistance", [("passenger_id", "FK", False), ("type (WCHR, MEDA…)", "", False),
      ("needs_companion", "", False), ("notes", "", False), ("status", "", False)], C)
table("sch", 55, B + 48, 29, "sales_channels", [("booking_id", "PK·FK", True), ("partner_id", "", True), ("partner_order_id", "", True),
      ("package_id (combo)", "", True), ("promotion_applied", "", True), ("discount_pct", "", True)], C, new=True)
table("precs", 88, B + 48, 29, "payment_records", [("reference", "UK", True), ("booking_id", "FK", True), ("provider (BOOKING / DIRECT)", "", True),
      ("operation (BOOKING, SEAT…)", "", True), ("amount · currency", "", True)], C, new=True)
table("refunds", 121, B + 48, 29, "refunds", [("refund_id (REF-VUE-…)", "PK", True), ("booking_id", "FK", True), ("amount · penalty · %", "", True),
      ("original_payment_reference", "", True), ("status CALCULATED / SETTLED", "", True)], C, new=True)
note(173, B + 53, "Booking cobra: aquí solo se", ha="center")
note(173, B + 54.6, "registra la referencia recibida", ha="center")
note(173, B + 56.2, "(no reutilizada, monto exacto)", ha="center")
note(173, B + 58.4, "y el reembolso que se CALCULA;", ha="center")
note(173, B + 60.0, "Booking lo ejecuta", ha="center")

# ===================== Post-sale, Check-in, ESB =====================
C = "#9b2c55"
group(52, 200, 68, 28, "Post-sale · SOA (SOAP/WSDL)", "esquema: post_sale", C, "#fbe8ef", changed=True)
table("cq", 55, 207.5, 31, "cancellation_quotes", [("id", "PK", False), ("booking_id", "ref", False), ("refund_amount", "", False),
      ("penalty_amount", "", False), ("penalty_waived (acuerdo B2B)", "", True), ("unflown_itineraries", "", False), ("expires_at", "", False)], C)
table("dco", 89, 207.5, 28, "date_change_offers", [("id", "PK", False), ("booking_id", "ref", False), ("total_to_pay", "", False),
      ("payload", "", False), ("expires_at", "", False)], C)

C = "#3d6b12"
group(124, 200, 34, 28, "Check-in", "esquema: check_in · REST", C, "#ecf4e2", changed=True)
table("ci", 127, 207.5, 28, "check_ins", [("booking_id", "PK·ref", False), ("segment_id", "PK·ref", False),
      ("passenger_id", "PK", False), ("seat · checked_in_at", "", False), ("assistance_ready", "", False), ("boarding_group · gate", "", True),
      ("barcode (PDF417 / QR)", "", True)], C)

C = "#5a5a5a"
group(163, 200, 34, 58, "ESB", "esquema: esb · datos técnicos", C, "#f3f3f3", changed=True)
table("idem", 166, 207.5, 28, "idempotency_claims", [("key", "PK", False), ("request_hash (mismo body)", "", True), ("status_code · response", "", True),
      ("expires_at (24 h)", "", True), ("correlation_id", "", "corr")], C)
table("saga", 166, 221.5, 28, "saga_log", [("saga_id", "PK", False), ("type · step", "", False), ("status", "", False), ("correlation_id", "", "corr")], C)
table("outbox", 166, 233.5, 28, "outbox", [("event_id", "PK", False), ("type (CloudEvents)", "", True), ("published_at", "", False), ("correlation_id", "", "corr")], C)
table("inbound", 166, 245.5, 28, "inbound_events", [("event_id", "PK", True), ("type (payment.*, package.*)", "", True),
      ("received_at · status", "", True), ("correlation_id", "", "corr")], C, new=True)

# ===================== Telemetría =====================
C = "#37474f"
group(52, 234, 106, 30, "Telemetría · OpenTelemetry", "no es un dominio · Prometheus (métricas) · Tempo (trazas) · Loki (logs) · Grafana",
      C, "#eceff1", changed=True, dashed=True)
table("spans", 55, 241, 24, "spans", [("trace_id", "", False), ("span_id", "PK", False), ("correlation_id (atributo)", "", "corr"),
      ("service", "", False), ("duration_ms · status", "", False)], C)
table("metrics", 81.5, 241, 22, "metrics", [("service", "", False), ("name", "", False), ("labels", "", False), ("value", "", False), ("timestamp", "", False)], C)
table("logs", 106, 241, 28, "api_request_logs", [("correlation_id", "", "corr"), ("request_id (X-Request-Id)", "", True),
      ("service · operation", "", True), ("status · latency_ms", "", True), ("timestamp", "", True)], C, new=True)
table("alerts", 136.5, 241, 19, "alert_rules", [("id", "PK", False), ("metric", "", False), ("threshold", "", False), ("channel", "", False)], C)

# ===================== relaciones dentro de cada servicio (FK real) =====================
path([top("roles", 0.5), bottom("users", 0.179)], label="1:N")
path([right("roles", 40.5), left("rscopes", 40.5)], label="1:N")
path([bottom("pmeth"), top("pays")], label="1:N")
path([bottom("pays"), top("payref")], label="1:1")
path([right("routes", 23.2), left("rair", 23.2)])
path([left("aircraft", 23.2), right("rair", 23.2)])
path([bottom("subs"), top("deliv")])
path([top("evlog"), bottom("deliv")])
path([right("fcp", 35.2), left("pchg", 35.2)], label="1:N")
path([bottom("schedf"), top("over")])
path([bottom("over"), top("fsch")], label="1:N")
path([right("holds", O + 12.5), left("fsel", O + 12.5)])
path([bottom("ffs", 0.8), (75.8, O + 26), (156, O + 26), bottom("inv")], label="1:N", lseg=1, lfrac=0.62)
path([(156, O + 26), (183, O + 26), bottom("seats")])
path([left("bk", B + 13), right("seg", B + 13)])
path([right("bk", B + 13), left("tk", B + 13)])
path([right("tk", B + 13), left("coup", B + 13)])
path([top("bk", 0.77), (104, B + 6), (183, B + 6), top("chg")], label="1:N", lseg=1, lfrac=0.55)
path([bottom("bk"), top("pax")], label="1:N")
path([bottom("bk", 0.85), (106.1, B + 25.3), (155, B + 25.3), top("pfare")], label="1:N", lseg=1, lfrac=0.6)
path([bottom("seg"), top("seat_as")], label="1:N")
path([left("pax", B + 33), right("seat_as", B + 33)])
path([right("pax", B + 33), left("bag", B + 33)])
path([bottom("pax", 0.5), (97, B + 43.6), (183, B + 43.6), bottom("assist")], label="1:N", lseg=1, lfrac=0.5)
# bookings → canal de venta, pagos recibidos y reembolsos (por el canal entre columnas)
TRUNK = B + 45.8
path([left("bk", B + 20.5), (82.5, B + 20.5), (82.5, TRUNK)], arrow=False)
ax.plot([69.5, 135.5], [TRUNK, TRUNK], color=FK, lw=1.3, zorder=2)
for k, f in (("sch", 0.5), ("precs", 0.5), ("refunds", 0.5)):
    x0, _ = top(k, f)
    path([(x0, TRUNK), top(k, f)])
ax.text(108, TRUNK - 0.9, "1:1 · 1:N · 1:N", fontsize=7.8, color=FK, ha="center", va="center", zorder=6,
        bbox=dict(fc="#f9ebe6", ec="none", pad=0.3))

# ===================== referencias entre servicios (solo por id) =====================
TR = 47.5
path([right("users", 23), (TR, 23), (TR, B + 6.5)], cross=True, arrow=False)
path([right("partners", 58), (TR, 58)], cross=True, arrow=False)
ax.text(TR - 1.3, 108, "owner_id = sub del JWT  o  partner:X-User-Id", rotation=90, fontsize=8.5, color=NEW, fontweight="bold",
        ha="center", va="center", bbox=dict(fc="white", ec="none", pad=0.4), zorder=6)
path([(TR, 89), right("profiles", 89)], cross=True)
path([(TR, 118), right("subs", 118)], cross=True)
path([(TR, O + 5.5), (91, O + 5.5), top("holds", 0.26)], cross=True)
path([(TR, B + 6.5), (87.9, B + 6.5), top("bk", 0.15)], cross=True)
for yy in (23, 58, O + 5.5, 89, 118, B + 6.5):
    ax.plot([TR], [yy], "o", color=REF, ms=4, zorder=3)

path([bottom("routes", 0.27), top("ffs", 0.36)], cross=True, label="gRPC PublishTimetable", lfrac=0.8)
path([bottom("fcp", 0.76), (112.5, O + 28.5), (118, O + 28.5), top("fprice", 0.13)], cross=True, label="orquestador: gRPC PublishFarePrices",
     lseg=0, lfrac=0.48)
path([top("fprice", 0.6), bottom("fsel", 0.68)], label="precio por cabin_class · fare_brand", lfrac=0.3)
path([bottom("routes", 0.8), (80, 43.3), (153, 43.3), (153, 22.5), left("schedf", 22.5)], cross=True,
     label="evento schedule.published (bus)", lseg=1, lfrac=0.5)
path([bottom("ffs", 0.27), top("seg", 0.27)], cross=True, label="segment_id", lfrac=0.72)
path([bottom("holds", 0.26), top("bk", 0.27)], cross=True, label="hold_id", lfrac=0.72)
path([(58, 192), top("cq", 0.1)], cross=True, label="booking_id", lfrac=0.45)
path([(114, 192), top("dco", 0.9)], cross=True, label="booking_id", lfrac=0.45)
path([(130, 192), top("ci", 0.1)], cross=True, label="booking_id · segment_id", lfrac=0.45)
for xx in (58, 114, 130):
    ax.plot([xx], [192], "o", color=REF, ms=4, zorder=3)

# ===================== leyenda =====================
ax.add_patch(Rectangle((3, 224), 40, 46, fc="white", ec="#999999", lw=1))
ax.text(5, 227, "Leyenda", fontsize=11, fontweight="bold")
legend = [
    ("——", FK, "Relación dentro del servicio (FK real)"),
    ("- - -", REF, "Referencia entre servicios (solo id)"),
    ("•", REF, "Punto donde sale una referencia"),
    ("PK / FK / UK", FK, "primaria / foránea / única"),
    ("ref", "#555555", "id de OTRO servicio (no es FK)"),
    ("rojo", NEW, "tabla o campo nuevo en v4 (contrato v2)"),
    ("borde rojo", NEW, "servicio modificado en v4"),
    ("naranja", CORR, "correlation_id (X-Correlation-Id)"),
]
for i, (sym, c, t) in enumerate(legend):
    yy = 231.5 + i * 3.6
    ax.text(5, yy, sym, fontsize=8.5, color=c, fontweight="bold", va="center")
    ax.text(16, yy, t, fontsize=7.8, va="center")
ax.text(5, 262.5, "Lo nuevo de la v3 (roles, precios, asistencia,\ntarjeta, telemetría) sigue igual; ver la v3.\nLas líneas nunca cruzan una tabla.",
        fontsize=7.8, va="center", color="#333333")

ax.add_patch(Rectangle((52, 272), 145, 32, fc="#fff3e0", ec=CORR, lw=2, zorder=1))
ax.text(124.5, 274.6, "Cómo viaja el correlation ID según el contrato v2 (una compra o un combo = un solo ID en todos los sistemas)",
        ha="center", fontsize=11.5, fontweight="bold", color=CORR)
steps = [
    ("1. Nace", "En el gateway de Booking (X-Correlation-Id). Si no llega, nuestro gateway lo crea. Nunca se modifica."),
    ("2. No se confunde", "X-Request-Id = un solo salto (lo genera cada servicio); trace_id = OpenTelemetry. La v3.1 los igualaba: se CORRIGE."),
    ("3. Viaja", "HTTP: X-Correlation-Id · gRPC: metadata x-correlation-id · SOAP: <corr:CorrelationId> en <soap:Header> · RabbitMQ: correlation_id + correlationid."),
    ("4. Se guarda", "Solo en datos técnicos: saga_log, outbox (ESB y Offers), idempotency_claims, inbound_events, event_log, deliveries, api_request_logs y spans."),
    ("5. Se devuelve", "Cabecera X-Correlation-Id en toda respuesta, correlation_id en cada ProblemDetails y correlationid en cada CloudEvent."),
    ("6. Se consulta", "Panel admin → Telemetría: con un correlation_id se ven todos los pasos, como en Booking: SELECT … WHERE correlation_id = '…' ORDER BY timestamp."),
]
for i, (k, v) in enumerate(steps):
    yy = 278.4 + i * 4.1
    ax.text(55, yy, k, fontsize=9, fontweight="bold", color=CORR, va="center")
    ax.text(73, yy, v, fontsize=8.2, color="#333333", va="center")

fig.savefig(OUT, dpi=110, bbox_inches="tight", facecolor="white")
print("ok", OUT)
