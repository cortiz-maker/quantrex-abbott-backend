const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

const DT_API_URL = "https://activationcode.dispatchtrack.com/api/external/v1";
const DT_API_KEY = process.env.DISPATCHTRACK_API_KEY;
const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => res.json({ status: "ok", service: "quantrex-abbott-backend" }));

function checkApiKey(req, res, next) {
  if (!DT_API_KEY) {
    return res.status(500).json({ error: "DISPATCHTRACK_API_KEY no configurada." });
  }
  next();
}

function dtHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Token ${DT_API_KEY}`,
  };
}

app.post("/api/dispatches", checkApiKey, async (req, res) => {
  const { solicitud } = req.body;
  if (!solicitud) return res.status(400).json({ error: "Se requiere solicitud." });
  const payload = {
    order_number: solicitud.guia || `QX-${Date.now()}`,
    order_date: solicitud.fecha || new Date().toISOString().split("T")[0],
    dispatch_date: solicitud.fecha,
    dispatch_time: solicitud.hora || null,
    address: solicitud.direccion || "",
    contact_name: solicitud.contacto || "",
    notes: [solicitud.descripcion, solicitud.notas].filter(Boolean).join(" | "),
    type: mapTipo(solicitud.tipo),
    priority: mapPrioridad(solicitud.prioridad),
    custom_fields: { cliente: "Abbott", tipo_quantrex: solicitud.tipo, titulo: solicitud.titulo },
  };
  try {
    const response = await axios.post(`${DT_API_URL}/dispatches`, payload, { headers: dtHeaders() });
    return res.json({ success: true, dispatch: response.data });
  } catch (err) {
    return res.status(err?.response?.status || 500).json({ error: "Error DispatchTrack.", detail: err?.response?.data || err.message });
  }
});

app.get("/api/dispatches", checkApiKey, async (req, res) => {
  const { date, status } = req.query;
  const params = {};
  if (date) params.dispatch_date = date;
  if (status) params.status = status;
  try {
    const response = await axios.get(`${DT_API_URL}/dispatches`, { headers: dtHeaders(), params });
    return res.json({ success: true, dispatches: response.data });
  } catch (err) {
    return res.status(err?.response?.status || 500).json({ error: "Error al obtener despachos.", detail: err?.response?.data || err.message });
  }
});

app.patch("/api/dispatches/:id/status", checkApiKey, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "Se requiere status." });
  try {
    const response = await axios.patch(`${DT_API_URL}/dispatches/${req.params.id}`, { status }, { headers: dtHeaders() });
    return res.json({ success: true, dispatch: response.data });
  } catch (err) {
    return res.status(err?.response?.status || 500).json({ error: "Error al actualizar.", detail: err?.response?.data || err.message });
  }
});

app.post("/api/webhooks/dispatchtrack", (req, res) => {
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));
  return res.json({ received: true });
});

function mapTipo(tipo) {
  return { retiro: "pickup", entrega: "delivery", horario: "appointment", seguimiento: "tracking" }[tipo] || "delivery";
}

function mapPrioridad(prioridad) {
  return { alta: "high", normal: "normal", baja: "low" }[prioridad] || "normal";
}

// ── POST /api/notificar — Email de confirmación al cliente (Resend vía axios) ──
// Usado por Aquatrisq al guardar un pedido. No requiere dependencias nuevas.
app.post("/api/notificar", async (req, res) => {
  try {
    const { to, cliente, guia, mensaje, detalle, total } = req.body || {};
    if (!to || !guia) {
      return res.status(400).json({ ok: false, error: "Faltan datos (to, guia)." });
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.FROM_EMAIL || "Aquatrisq <onboarding@resend.dev>";
    if (!RESEND_API_KEY) {
      return res.status(500).json({ ok: false, error: "RESEND_API_KEY no configurada." });
    }

    const clp = (n) => "$" + (Number(n) || 0).toLocaleString("es-CL");
    const lineas = (detalle || "")
      .split("\n").filter(Boolean)
      .map((l) => `<li style="margin:2px 0">${l}</li>`).join("");
    const cuerpo = (mensaje || "")
      .replace(/\*(.+?)\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");

    const html = `
      <div style="font-family:Arial,sans-serif;color:#1d2433;max-width:560px">
        <div style="background:#1B2F6E;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
          <h2 style="margin:0;font-size:18px">Aquatrisq &middot; Pedido ${guia}</h2>
        </div>
        <div style="border:1px solid #e3e8f0;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
          <p style="font-size:14px;line-height:1.5">${cuerpo}</p>
          ${detalle ? `<h3 style="font-size:13px;color:#1B2F6E;margin:18px 0 6px">Detalle del pedido</h3>
          <ul style="padding-left:18px;font-size:14px">${lineas}</ul>
          <p style="font-weight:700;font-size:15px;color:#1B2F6E">Total: ${clp(total)}</p>` : ""}
        </div>
      </div>`;

    await axios.post(
      "https://api.resend.com/emails",
      {
        from: FROM_EMAIL,
        to: [to],
        subject: `Aquatrisq · Tu pedido ${guia} fue ingresado`,
        html,
      },
      { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" } }
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("notificar error:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data?.message || e.message || "Error enviando correo" });
  }
});

app.listen(PORT, () => console.log(`Quantrex Backend en puerto ${PORT}`));
