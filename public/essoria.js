(() => {
  "use strict";
  const byId = (id) => document.getElementById(id),
    route = document.body.dataset.route;
  let me = null,
    currentQR = null,
    qrTimer = null,
    expiryTimer = null,
    qrSequence = 0,
    qrController = null,
    agentSecret = null,
    recovery = null;
  const escape = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const date = (t) =>
    t ? new Date(t).toLocaleString("es-MX") : "Sin uso observado";
  const paymentStateText = (state, trialUntil) =>
    state === "beta"
      ? trialUntil > Date.now()
        ? "Prueba beta"
        : "Prueba finalizada"
      : {
          active: "Suscripción activa",
          trialing: "Período de prueba",
          past_due: "Pago pendiente",
          unpaid: "Pago pendiente",
          awaiting_payment: "Pago pendiente",
          incomplete: "Suscripción sin completar",
          incomplete_expired: "Suscripción sin completar",
          canceled: "Suscripción cancelada",
          disputed: "Pago en revisión",
          refunded: "Pago reembolsado",
          fraud_warning: "Pago en revisión",
        }[state] || "Estado pendiente de comprobar";
  async function request(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    }).catch(() => {
      throw new Error(
        "No se pudo conectar con Essoria. Comprueba tu conexión y vuelve a intentarlo.",
      );
    });
    const value = await res.json();
    if (!res.ok) {
      if (res.status === 401 && route.startsWith("/app")) {
        expireSession(value.error);
      }
      throw new Error(value.error || "No se pudo completar la operación.");
    }
    return value;
  }
  function expireSession(message) {
    stopQR();
    agentSecret = null;
    recovery = null;
    me = null;
    const target = byId("workspace-content");
    if (target) {
      target.replaceChildren();
      const a = document.createElement("a");
      a.href = "/entrar";
      a.textContent = "Volver a iniciar sesión";
      target.append(a);
      a.focus();
    }
    if (byId("account-identity"))
      byId("account-identity").textContent = "Sesión caducada";
    notice(message || "Tu sesión terminó. Inicia sesión de nuevo.");
  }
  function notice(text) {
    const e = byId("app-notice") || byId("form-status");
    if (e) e.textContent = text;
  }
  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      notice("Copiado. Guarda este dato en un lugar privado.");
      return true;
    } catch {
      notice(
        "El navegador no pudo copiarlo. Selecciona el texto y cópialo manualmente.",
      );
      return false;
    }
  }
  function download(value, name) {
    const url = URL.createObjectURL(
        new Blob([value + "\n"], { type: "text/plain" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }
  function showRecovery(value) {
    recovery = value;
    byId("recovery-value").textContent = value;
    byId("recovery-result").hidden = false;
    byId("recovery-result").scrollIntoView({ block: "nearest" });
    const heading = byId("recovery-result").querySelector("h2,h3");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
    byId("copy-recovery").onclick = () => copy(recovery);
    byId("download-recovery").onclick = () =>
      download(recovery, "essoria-recuperacion.txt");
  }
  window.addEventListener("pagehide", () => {
    agentSecret = null;
    recovery = null;
    for (const id of ["agent-secret", "recovery-value"])
      if (byId(id)) byId(id).textContent = "";
    for (const id of ["secret-result", "recovery-result"])
      if (byId(id)) byId(id).hidden = true;
  });
  const auth = byId("auth-form");
  if (auth) {
    auth.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = auth.querySelector("button[type=submit]");
      button.disabled = true;
      notice("Procesando…");
      try {
        const v = Object.fromEntries(new FormData(auth));
        if (auth.dataset.mode === "registro")
          v.acceptedTerms = auth.elements.acceptedTerms.checked;
        const endpoint = {
            entrar: "login",
            registro: "register",
            recuperar: "recover",
          }[auth.dataset.mode],
          result = await request("/api/app/" + endpoint, v);
        auth.elements.password.value = "";
        if (result.recoveryCode) {
          showRecovery(result.recoveryCode);
          button.hidden = true;
          notice("Cuenta lista. Guarda el código antes de continuar.");
        } else location.assign("/app");
      } catch (error) {
        notice(error.message);
      } finally {
        button.disabled = false;
      }
    });
    if (auth.dataset.mode === "registro")
      request("/api/app/config")
        .then((c) => {
          if (!c.signupOpen) {
            auth.querySelector("button[type=submit]").disabled = true;
            notice(
              "El registro está cerrado mientras preparamos el servicio. Puedes consultar disponibilidad en Contacto.",
            );
          }
        })
        .catch(() =>
          notice("No se pudo comprobar el registro. Intenta de nuevo."),
        );
  }
  const contact = byId("contact-form");
  if (contact)
    contact.onsubmit = async (e) => {
      e.preventDefault();
      const b = contact.querySelector("button");
      b.disabled = true;
      try {
        const v = Object.fromEntries(new FormData(contact));
        v.consent = contact.elements.consent.checked;
        const r = await request("/api/app/contact", v);
        notice(r.message + " Referencia: " + r.id);
        contact.reset();
      } catch (error) {
        notice(error.message);
      } finally {
        b.disabled = false;
      }
    };
  if (route === "/estado")
    fetch("/health", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(
        (r) =>
          (byId("service-state").textContent =
            "El servicio web y su almacenamiento responden. Versión " +
            r.version +
            "."),
      )
      .catch(
        () =>
          (byId("service-state").textContent =
            "No se pudo comprobar la disponibilidad. Intenta más tarde o contacta al equipo."),
      );
  const motionFrame = byId("connection-motion"),
    motionButton = byId("motion-play");
  if (motionFrame && motionButton) {
    let playing = false;
    const narrowMotion = matchMedia("(max-width:650px)");
    const motionSource = () => {
      motionFrame.src = narrowMotion.matches
        ? "/assets/motion/mobile/index.html"
        : "/assets/motion/index.html";
    };
    if (narrowMotion.matches) motionSource();
    narrowMotion.addEventListener("change", motionSource);

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const send = (action) =>
      motionFrame.contentWindow?.postMessage(
        { type: "essoria-motion", action },
        location.origin,
      );
    const setReduced = () => {
      playing = false;
      if (reduced.matches) {
        send("static");
        motionButton.disabled = true;
        motionButton.textContent = "Movimiento reducido";
        byId("motion-state").textContent =
          "Esquema estático según tu preferencia de movimiento.";
      } else {
        motionButton.disabled = false;
        motionButton.textContent = "Reproducir recorrido";
        byId("motion-state").textContent =
          "Animación explicativa; sin datos reales.";
      }
    };
    motionFrame.addEventListener("load", () => {
      setReduced();
      if (!reduced.matches) {
        send("play");
        playing = true;
        motionButton.textContent = "Pausar recorrido";
      }
    });
    setReduced();
    motionButton.onclick = () => {
      if (playing) {
        send("pause");
        playing = false;
        motionButton.textContent = "Continuar recorrido";
      } else {
        send(
          motionButton.textContent === "Continuar recorrido"
            ? "resume"
            : "play",
        );
        playing = true;
        motionButton.textContent = "Pausar recorrido";
      }
    };
    window.addEventListener("message", (e) => {
      if (
        e.origin === location.origin &&
        e.source === motionFrame.contentWindow &&
        e.data?.type === "essoria-motion" &&
        e.data.state === "complete"
      ) {
        playing = false;
        motionButton.textContent = "Repetir recorrido";
      }
    });
    reduced.addEventListener("change", setReduced);
  }
  if (!route.startsWith("/app")) return;
  byId("sign-out").onclick = async () => {
    try {
      await request("/api/app/logout", {});
      stopQR();
      location.assign("/entrar");
    } catch (e) {
      notice(e.message);
    }
  };
  const states = {
    disconnected: "Sin vincular",
    connecting: "Conectando",
    qr: "Esperando el QR",
    open: "Conectado",
    reconnecting: "Reconectando",
    paused: "Pausado",
    logged_out: "Desvinculado",
    error: "Requiere atención",
    identity_mismatch: "Número diferente",
    replaced: "Conexión reemplazada",
  };
  const stateText = (s) => states[s] || s;
  async function load() {
    me = await request("/api/app/me");
    byId("account-identity").textContent = me.user.name + " · " + me.user.email;
    render();
  }
  function render() {
    const content = byId("workspace-content");
    document
      .querySelectorAll(".workspace-nav a")
      .forEach((a) =>
        a.setAttribute("aria-current", a.pathname === route ? "page" : "false"),
      );
    if (route === "/app" || route === "/app/conexiones") {
      content.innerHTML = `<h2 class="connection-title"><img src="/assets/platforms/whatsapp.svg" width="44" height="44" alt="">Tu conexión de WhatsApp</h2><p class="instructions">WhatsApp sigue en tu teléfono. Para mostrar y escanear el QR necesitas otra pantalla. Abre esta misma página en un ordenador o tableta e inicia sesión allí.</p><button id="copy-continuation" class="secondary" type="button">Copiar enlace para otra pantalla</button><dl class="account-state"><dt>Cuenta</dt><dd>${escape(me.account.name)}</dd><dt>Número</dt><dd id="phone-identity">${escape(me.account.selfJid || "Todavía sin vincular")}</dd><dt>Conexión</dt><dd id="phone-state">${escape(stateText(me.account.state))}</dd><dt>Historial</dt><dd id="history-state">${escape(syncText(me.account.syncStatus))}</dd></dl><div class="control-row"><button id="pair-phone" type="button">${me.account.state === "open" ? "Comprobar conexión" : "Vincular o reanudar"}</button><button id="pause-phone" type="button" class="secondary">Pausar</button><button id="unlink-phone" type="button" class="secondary">Desvincular</button></div><section id="pairing-output" hidden><h3>Vincula el dispositivo</h3><p id="pairing-state" role="status">Esperando una respuesta…</p><img id="pairing-qr" width="300" height="300" alt="QR privado para vincular WhatsApp" hidden><p>En el teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo.</p><button id="close-qr" type="button" class="secondary">Ocultar QR</button></section><h3>Después, conecta tu agente</h3><p>Una vez vinculado el teléfono, crea una clave limitada. Guardar una configuración no demuestra que el agente ya tenga acceso.</p><a href="/app/agentes">Ir a mis agentes →</a><h3>Otras redes</h3><p>Instagram y Facebook están previstas. Todavía no se pide acceso a esas cuentas.</p>`;
      byId("copy-continuation").onclick = () =>
        copy(location.origin + "/app/conexiones");
      if (!me.billing.accessActive) {
        byId("pair-phone").disabled = true;
        notice(
          me.billing.state === "beta"
            ? "Tu prueba terminó. Puedes consultar el estado, revocar permisos o contactar al equipo desde Facturación."
            : "El acceso está pausado. Revisa tu pago o contacta al equipo desde Facturación; puedes consultar el estado y revocar permisos.",
        );
      }
      byId("pair-phone").onclick = async () => {
        try {
          notice("Iniciando la conexión…");
          await tool("whatsapp_pairing_start");
          byId("pairing-output").hidden = false;
          startQR();
          notice("");
        } catch (e) {
          notice(e.message);
        }
      };
      byId("pause-phone").onclick = async () => {
        try {
          stopQR();
          await tool("whatsapp_account_disconnect");
          await refreshState();
          notice("Conexión pausada. Las credenciales se conservan.");
        } catch (e) {
          notice(e.message);
        }
      };
      byId("unlink-phone").onclick = async () => {
        if (
          !confirm(
            "¿Desvincular tu teléfono? Necesitarás un QR nuevo y se invalidarán tus claves anteriores.",
          )
        )
          return;
        try {
          stopQR();
          await tool("whatsapp_account_logout", true);
          await refreshState();
          notice(
            "Dispositivo desvinculado. Crea nuevas claves cuando vuelvas a vincular.",
          );
        } catch (e) {
          notice(
            e.message +
              " Si el dispositivo sigue visible, retíralo desde WhatsApp → Dispositivos vinculados.",
          );
        }
      };
      byId("close-qr").onclick = () => {
        stopQR();
        byId("pair-phone").focus();
      };
    } else if (route === "/app/agentes") {
      content.innerHTML = `<h2>Tus agentes y sus permisos</h2><p>Hasta cinco claves activas por cuenta. Elige permisos antes de crear cada una; se mostrará una sola vez.</p><p>Endpoint MCP: <code>${escape(location.origin + "/mcp")}</code><br>Code Mode: <code>${escape(location.origin + "/mcp/code")}</code></p><button id="refresh-agents" type="button" class="secondary">Actualizar uso observado</button><div id="agent-list" class="agent-scroll"></div><form id="agent-form" class="agent-form"><label for="agent-name">Nombre de tu agente</label><input id="agent-name" name="name" required maxlength="60" autocomplete="off"><fieldset><legend>Permisos para ${escape(me.account.name)}</legend><label class="check-row"><input type="checkbox" name="read" checked disabled> Lectura de tu cuenta, chats, contactos y grupos</label><label class="check-row"><input type="checkbox" name="send"> Enviar mensajes y archivos</label><label class="check-row"><input type="checkbox" name="manage"> Gestionar la sesión y desvincular el teléfono</label></fieldset><button type="submit">Crear clave de agente</button></form><section id="secret-result" class="secret-output" hidden><h3>Guarda esta clave privada</h3><p>Caduca en 30 días. No se volverá a mostrar. No la pegues en una URL ni en una conversación pública.</p><code id="agent-secret"></code><div class="control-row"><button id="copy-agent" type="button">Copiar clave</button><button id="download-agent" type="button" class="secondary">Descargar clave</button><button id="hide-agent" type="button" class="secondary">Ya la guardé, ocultar</button></div><p>Crea la conexión en tu cliente MCP y empieza listando tu cuenta. Una clave creada o copiada no equivale a una conexión observada.</p></section><p><a href="/agentes">Guía y ejemplos para clientes MCP →</a></p>`;
      renderAgents();
      byId("refresh-agents").onclick = async () => {
        try {
          me = await request("/api/app/me");
          renderAgents();
          notice(
            "Uso actualizado. Solo mostramos peticiones autenticadas observadas.",
          );
        } catch (e) {
          notice(e.message);
        }
      };
      byId("agent-form").onsubmit = async (e) => {
        e.preventDefault();
        const form = e.currentTarget,
          b = form.querySelector("button");
        b.disabled = true;
        try {
          const permissions = ["read"];
          if (form.elements.send.checked) permissions.push("send");
          if (form.elements.manage.checked) permissions.push("manage");
          const r = await request("/api/app/agents", {
            name: form.elements.name.value,
            permissions,
          });
          agentSecret = r.token;
          byId("agent-secret").textContent = agentSecret;
          byId("secret-result").hidden = false;
          me = await request("/api/app/me");
          renderAgents();
          notice(
            "Clave creada. Aún no se ha observado una petición de tu agente.",
          );
          byId("secret-result").scrollIntoView({ block: "nearest" });
        } catch (error) {
          notice(error.message);
        } finally {
          b.disabled = false;
        }
      };
      byId("copy-agent").onclick = () => copy(agentSecret);
      byId("download-agent").onclick = () =>
        download(agentSecret, "essoria-agente.token");
      byId("hide-agent").onclick = () => {
        agentSecret = null;
        byId("agent-secret").textContent = "";
        byId("secret-result").hidden = true;
        byId("agent-name").focus();
      };
    } else if (route === "/app/facturacion") {
      content.innerHTML = `<h2>Tu plan y facturación</h2><div class="billing-facts"><p class="launch-price">USD 10 <span>/ mes por un número</span></p><p>Hasta cinco claves de agente y 1.000 solicitudes únicas de envío al mes natural UTC. El consumo de tu proveedor de IA se paga por separado.</p><dl class="account-state"><dt>Estado</dt><dd>${escape(paymentStateText(me.billing.state, me.user.trialUntil))}</dd><dt>Prueba hasta</dt><dd>${escape(date(me.user.trialUntil))}</dd><dt>Uso este mes</dt><dd>${me.usage.requests} de ${me.usage.monthlyLimit} solicitudes</dd><dt>Pagos</dt><dd>${me.billing.enabled ? "Configurados (" + escape(me.billing.mode) + ")" : "Todavía no habilitados"}</dd></dl><p>${escape(me.billing.reason || "La suscripción es mensual. Revisa el importe e impuestos en Stripe antes de confirmar.")}</p><div class="control-row"><button id="checkout" type="button" ${me.billing.enabled && !me.billing.subscribed ? "" : "disabled"}>Activar suscripción</button><button id="billing-portal" type="button" class="secondary" ${me.billing.manageable && me.billing.hasCustomer ? "" : "disabled"}>Gestionar suscripción</button></div><p>Volver desde Stripe no confirma un pago. El acceso se actualiza al recibir y verificar su estado en el servidor.</p><a href="/contacto">Consultar disponibilidad o pedir ayuda →</a></div>`;
      byId("checkout").onclick = () => goBilling("/api/app/checkout");
      byId("billing-portal").onclick = () =>
        goBilling("/api/app/billing/portal");
    } else {
      content.innerHTML = `<h2>Mi cuenta</h2><p>${escape(me.user.name)} · ${escape(me.user.email)}</p><h3>Recuperación de acceso</h3><p>Tu código de recuperación se mostró al registrarte. Si lo tienes, puedes restablecer el acceso y revocar las sesiones y claves anteriores. Si no lo guardaste, contacta al equipo.</p><a href="/recuperar">Usar mi código de recuperación →</a><h3>Eliminar mi cuenta</h3><p>Esta acción cierra sesiones, revoca agentes y elimina la conexión y los registros locales. Si existe una suscripción, se cancelará. Si WhatsApp no responde, tendrás que retirar el dispositivo desde el teléfono. Las copias de recuperación cifradas pueden conservar datos previos hasta 30 días.</p><form id="delete-form" class="app-form"><label for="delete-password">Confirma tu contraseña</label><input id="delete-password" name="password" type="password" minlength="12" required autocomplete="current-password"><label for="delete-word">Escribe ELIMINAR</label><input id="delete-word" name="confirm" required pattern="ELIMINAR" autocomplete="off"><button class="danger" type="submit">Eliminar mi cuenta y sus datos</button></form>`;
      byId("delete-form").onsubmit = async (e) => {
        e.preventDefault();
        const b = e.currentTarget.querySelector("button");
        b.disabled = true;
        try {
          const r = await request(
            "/api/app/delete",
            Object.fromEntries(new FormData(e.currentTarget)),
          );
          stopQR();
          byId("workspace-content").innerHTML =
            '<h2 id="deleted-title" tabindex="-1">Cuenta eliminada</h2><p>' +
            escape(r.message) +
            '</p><a href="/">Volver a Essoria →</a>';
          byId("deleted-title").focus();
          byId("account-identity").textContent = "No hay una sesión activa";
          byId("sign-out").hidden = true;
          me = null;
          notice(r.message);
        } catch (error) {
          notice(error.message);
          b.disabled = false;
        }
      };
    }
  }
  function renderAgents() {
    const list = byId("agent-list");
    if (!me.agents.length) {
      list.innerHTML =
        "<p>No has creado claves. Ningún agente tiene acceso con una clave de esta cuenta.</p>";
      return;
    }
    list.innerHTML =
      '<table class="agent-table"><caption>Claves activas para tu cuenta</caption><thead><tr><th>Agente</th><th>Permisos</th><th>Uso observado / caducidad</th><th>Acción</th></tr></thead><tbody>' +
      me.agents
        .map(
          (a) =>
            `<tr><th>${escape(a.name)}</th><td>${escape(a.permissions.join(", "))}</td><td>${escape(date(a.lastUsedAt))}<br>Caduca: ${escape(date(a.expiresAt))}</td><td><button class="secondary" data-revoke="${a.id}" type="button" aria-label="Revocar ${escape(a.name)}">Revocar</button></td></tr>`,
        )
        .join("") +
      "</tbody></table>";
    list.querySelectorAll("[data-revoke]").forEach(
      (b) =>
        (b.onclick = async () => {
          const a = me.agents.find((v) => v.id === b.dataset.revoke);
          if (
            !confirm(
              "¿Revocar la clave de " +
                a.name +
                "? Ese agente perderá el acceso; WhatsApp seguirá conectado.",
            )
          )
            return;
          try {
            await request("/api/app/agents/revoke", { id: a.id });
            if (agentSecret) {
              agentSecret = null;
              byId("agent-secret").textContent = "";
              byId("secret-result").hidden = true;
            }
            me = await request("/api/app/me");
            renderAgents();
            byId("agent-name").focus();
            notice("Clave revocada. No se desconectó tu teléfono.");
          } catch (e) {
            notice(e.message);
          }
        }),
    );
  }
  async function goBilling(endpoint) {
    try {
      notice("Abriendo Stripe…");
      const r = await request(endpoint, {}),
        u = new URL(r.url);
      if (
        !["checkout.stripe.com", "billing.stripe.com"].includes(u.hostname) ||
        u.protocol !== "https:"
      )
        throw new Error("URL de pago no válida.");
      location.assign(u.href);
    } catch (e) {
      notice(e.message);
    }
  }
  async function tool(name, confirm) {
    const r = await request("/api/app/tools", {
      name,
      ...(confirm === undefined ? {} : { confirm }),
    });
    if (r.isError) throw new Error(r.content[0].text);
    return r;
  }
  function syncText(state) {
    return state === "latest_batch_received"
      ? "Último lote recibido; puede no ser todo el historial"
      : state === "partial"
        ? "Sincronización parcial; pueden llegar más datos"
        : "Aún no sincronizado";
  }
  async function refreshState() {
    me = await request("/api/app/me");
    if (byId("phone-state")) {
      byId("phone-state").textContent = stateText(me.account.state);
      byId("phone-identity").textContent =
        me.account.selfJid || "Todavía sin vincular";
      byId("history-state").textContent = syncText(me.account.syncStatus);
    }
  }
  function stopQR() {
    qrSequence++;
    clearInterval(qrTimer);
    qrTimer = null;
    clearTimeout(expiryTimer);
    qrController?.abort();
    qrController = null;
    currentQR = null;
    const area = byId("pairing-output"),
      img = byId("pairing-qr");
    if (area) area.hidden = true;
    if (img) {
      img.hidden = true;
      img.removeAttribute("src");
    }
  }
  function startQR() {
    clearInterval(qrTimer);
    void pollQR();
    qrTimer = setInterval(() => void pollQR(), 2000);
  }
  async function pollQR() {
    if (
      !byId("pairing-output") ||
      byId("pairing-output").hidden ||
      navigator.onLine === false ||
      (qrController && !qrController.signal.aborted)
    )
      return;
    const seq = ++qrSequence;
    const controller = new AbortController();
    qrController = controller;
    try {
      const res = await fetch("/api/app/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "whatsapp_pairing_get" }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (res.status === 401)
        expireSession("Tu sesión terminó. Inicia sesión de nuevo.");
      if (!res.ok)
        throw new Error(
          res.status === 401
            ? "Tu sesión terminó. Inicia sesión de nuevo."
            : "No se pudo consultar el QR. Intenta reanudar la conexión.",
        );
      const r = await res.json();
      if (r.isError) throw new Error(r.content[0].text);
      if (seq !== qrSequence) return;
      const d = JSON.parse(r.content.find((c) => c.type === "text").text),
        img = r.content.find((c) => c.type === "image"),
        target = byId("pairing-qr");
      if (img && d.expiresAt > Date.now()) {
        const identity = [d.generation, d.createdAt, d.expiresAt].join(":");
        if (currentQR !== identity) {
          currentQR = identity;
          target.src = "data:image/png;base64," + img.data;
          target.hidden = false;
          clearTimeout(expiryTimer);
          expiryTimer = setTimeout(
            () => {
              if (
                currentQR !== identity ||
                byId("pairing-output")?.hidden !== false
              )
                return;
              target.hidden = true;
              target.removeAttribute("src");
              byId("pairing-state").textContent =
                "El código venció. Esperando uno nuevo…";
            },
            Math.max(0, d.expiresAt - Date.now()),
          );
          byId("pairing-state").textContent =
            "Escanea este QR desde tu teléfono. Se renueva automáticamente.";
        }
        byId("phone-state").textContent = "Esperando vinculación";
      } else {
        clearTimeout(expiryTimer);
        target.hidden = true;
        target.removeAttribute("src");
        currentQR = null;
        const text =
          d.state === "open"
            ? "WhatsApp conectado. Ya puedes configurar tus agentes."
            : stateText(d.state || "connecting");
        if (byId("pairing-state").textContent !== text)
          byId("pairing-state").textContent = text;
        byId("phone-state").textContent = stateText(d.state || "connecting");
        if (d.state === "open") {
          clearInterval(qrTimer);
          qrTimer = null;
          await refreshState();
        }
      }
    } catch (e) {
      if (e.name === "AbortError" || seq !== qrSequence) return;
      const img = byId("pairing-qr");
      img.hidden = true;
      img.removeAttribute("src");
      currentQR = null;
      clearTimeout(expiryTimer);
      if (byId("pairing-state")) byId("pairing-state").textContent = e.message;
    } finally {
      if (qrController === controller) qrController = null;
    }
  }
  window.addEventListener("offline", () => {
    qrSequence++;
    qrController?.abort();
    clearTimeout(expiryTimer);
    if (byId("pairing-qr")) {
      byId("pairing-qr").hidden = true;
      byId("pairing-qr").removeAttribute("src");
      currentQR = null;
    }
    notice(
      "Sin conexión. El estado mostrado puede estar desactualizado; no repetimos acciones automáticamente.",
    );
  });
  window.addEventListener("online", () => {
    notice(
      "Conexión de red recuperada. Consulta el estado antes de repetir una acción.",
    );
    if (qrTimer) void pollQR();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && qrTimer) void pollQR();
  });
  window.addEventListener("pagehide", () => {
    stopQR();
    agentSecret = null;
    recovery = null;
  });
  load().catch((e) => notice(e.message));
})();
