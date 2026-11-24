(() => {
  "use strict";
  const byId = (id) => document.getElementById(id),
    route = document.body.dataset.route;
  let me = null,
    currentQR = null,
    qrTimer = null,
    expiryTimer = null,
    qrSequence = 0,
    qrController = null;
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
  document.addEventListener("click", async (e) => {
    const button = e.target.closest?.("[data-guide-copy]");
    if (!button) return;
    try {
      await navigator.clipboard.writeText(
        button.previousElementSibling.textContent,
      );
      button.textContent = "Copiado";
    } catch {
      button.textContent = "Selecciona y copia el texto de arriba";
    }
  });
  const auth = byId("auth-form");
  if (auth) {
    const pending = new URLSearchParams(location.search).get("oauth");
    if (pending)
      document
        .querySelectorAll(
          '.auth-links a[href="/registro"],.auth-links a[href="/entrar"]',
        )
        .forEach((a) => (a.search = new URLSearchParams({ oauth: pending })));
    auth.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = auth.querySelector("button[type=submit]");
      button.disabled = true;
      notice("Procesando…");
      try {
        const v = Object.fromEntries(new FormData(auth));
        if (auth.dataset.mode === "registro")
          v.acceptedTerms = auth.elements.acceptedTerms.checked;
        await request(
          "/api/app/" +
            (auth.dataset.mode === "registro" ? "register" : "login"),
          v,
        );
        const pending = new URLSearchParams(location.search).get("oauth");
        location.assign(
          pending
            ? "/oauth/choose?request=" + encodeURIComponent(pending)
            : "/app/conexiones",
        );
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
    qr: "Pendiente de escaneo",
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
    me.account =
      me.numbers?.find(
        (a) => a.id === sessionStorage.getItem("essoriaNumber"),
      ) ?? me.account;
    byId("account-identity").textContent = me.user.name + " · " + me.user.email;
    render();
  }
  function render() {
    const content = byId("workspace-content");
    document
      .querySelectorAll(".workspace-nav a")
      .forEach((a) =>
        a.setAttribute(
          "aria-current",
          a.pathname === (route === "/app" ? "/app/conexiones" : route)
            ? "page"
            : "false",
        ),
      );
    if (route === "/app" || route === "/app/conexiones") {
      const displayNumber = (account) =>
        account.selfJid?.split("@")[0].split(":")[0];
      const name = (account, index) =>
        account.label ||
        displayNumber(account) ||
        (index === 0 ? "Número principal" : "Número " + (index + 1));
      const selected = me.numbers.find(
        (n) => n.id === new URLSearchParams(location.search).get("instancia"),
      );
      if (!selected) {
        content.innerHTML = `<div class="section-bar"><h2>Instancias</h2><button id="toggle-number" aria-expanded="false" aria-controls="add-number">＋ Nueva instancia</button></div>
        <form id="add-number" class="number-form" hidden><label>Nombre de la instancia<input required maxlength="64" name="label" placeholder="Por ejemplo, Ventas"></label><button>Crear instancia</button></form>
        <div class="instance-filters"><input type="search" id="find-instance" aria-label="Buscar instancia" placeholder="Buscar por nombre o teléfono"><select id="filter-instance" aria-label="Estado"><option value="">Todos los estados</option><option value="open">Conectadas</option><option value="other">Sin conexión</option></select></div>
        <div class="instance-grid">${me.numbers.map((n, i) => `<a class="instance-card" href="/app/conexiones?instancia=${encodeURIComponent(n.id)}" data-state="${escape(n.state)}"><strong>${escape(name(n, i))}</strong><span>${escape(displayNumber(n) || "Sin teléfono vinculado")}</span><small class="wa-status">${escape(stateText(n.state))}</small></a>`).join("")}</div><p id="no-results" hidden>No hay instancias que coincidan.</p>`;
        const filter = () => {
          let visible = 0;
          for (const card of content.querySelectorAll(".instance-card")) {
            const state = byId("filter-instance").value;
            card.hidden =
              !card.textContent
                .toLowerCase()
                .includes(byId("find-instance").value.trim().toLowerCase()) ||
              (state === "open" && card.dataset.state !== "open") ||
              (state === "other" && card.dataset.state === "open");
            if (!card.hidden) visible++;
          }
          byId("no-results").hidden = visible > 0;
        };
        byId("find-instance").oninput = filter;
        byId("filter-instance").onchange = filter;
        byId("toggle-number").onclick = () => {
          const form = byId("add-number");
          form.hidden = !form.hidden;
          byId("toggle-number").setAttribute(
            "aria-expanded",
            String(!form.hidden),
          );
          if (!form.hidden) form.elements.label.focus();
        };
        byId("add-number").onsubmit = async (e) => {
          e.preventDefault();
          const submit = e.currentTarget.querySelector("button");
          submit.disabled = true;
          try {
            const a = await request("/api/app/numbers", {
              label: new FormData(e.target).get("label"),
            });
            location.assign(
              "/app/conexiones?instancia=" + encodeURIComponent(a.id),
            );
          } catch (err) {
            submit.disabled = false;
            notice(err.message);
          }
        };
        return;
      }
      me.account = selected;
      sessionStorage.setItem("essoriaNumber", selected.id);
      content.innerHTML = `<a class="back-instances" href="/app/conexiones">← Instancias</a>
        <section class="wa-card">
          <header class="wa-heading"><div class="wa-brand"><img src="/assets/platforms/whatsapp.svg" alt="" width="32" height="32"><h3>${escape(
            name(
              me.account,
              me.numbers.findIndex((n) => n.id === me.account.id),
            ),
          )}</h3></div><span class="wa-status" id="phone-state">${escape(stateText(me.account.state))}</span></header>
          <div class="pair-actions"><button id="pair-phone" type="button">${me.account.state === "open" ? "Comprobar conexión" : "Vincular con QR"}</button><button id="copy-continuation" class="text-action" type="button">Copiar enlace para otra pantalla</button></div>
          <section id="pairing-output" hidden aria-labelledby="scan-title"><div class="scan-copy"><h3 id="scan-title">Escanea el código</h3><p>En tu teléfono, abre WhatsApp y ve a <strong>Dispositivos vinculados → Vincular un dispositivo</strong>.</p><p id="pairing-state" role="status">Preparando el QR…</p><button id="close-qr" type="button" class="secondary">Ocultar QR</button></div><img id="pairing-qr" width="240" height="240" alt="Código QR para vincular el número seleccionado" hidden></section>
          <label class="receipt-setting"><span><strong>Confirmaciones de lectura</strong><small>Mostrar el visto en WhatsApp cuando un agente lea un mensaje.</small></span><input type="checkbox" role="switch" id="read-receipts" ${selected.readReceipts ? "checked" : ""}></label>
          <details class="connection-details"><summary>Detalles y ajustes</summary><dl class="account-state"><dt>Teléfono</dt><dd id="phone-identity">${escape(displayNumber(me.account) || "Sin vincular")}</dd><dt>Historial</dt><dd id="history-state">${escape(syncText(me.account.syncStatus))}</dd></dl><div class="control-row"><button id="pause-phone" type="button" class="secondary">Pausar conexión</button><button id="unlink-phone" type="button" class="secondary">Desvincular teléfono</button></div></details>
        </section><a class="agent-next" href="/app/agentes"><span><strong>Conectar un agente</strong><small>Elige qué números podrá leer y responder.</small></span><span aria-hidden="true">→</span></a>`;
      byId("read-receipts").onchange = async (e) => {
        const input = e.currentTarget,
          enabled = input.checked;
        input.disabled = true;
        try {
          await request("/api/app/numbers/read-receipts", {
            account: selected.id,
            enabled,
          });
          selected.readReceipts = enabled;
          notice(
            enabled
              ? "Visto activado para esta instancia."
              : "Visto desactivado para esta instancia.",
          );
        } catch (err) {
          input.checked = !enabled;
          notice(err.message);
        } finally {
          input.disabled = false;
        }
      };
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
          const number = me.account.id;
          notice("Iniciando la conexión…");
          await tool("whatsapp_pairing_start");
          if (number !== me.account.id) return;
          byId("scan-title").textContent = "Escanea el código";
          byId("pairing-output").hidden = false;
          startQR();
          byId("pairing-output").scrollIntoView({ block: "nearest" });
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
            "¿Desvincular tu teléfono? Necesitarás un QR nuevo y se retirarán los permisos anteriores.",
          )
        )
          return;
        try {
          stopQR();
          await tool("whatsapp_account_logout", true);
          await refreshState();
          notice(
            "Dispositivo desvinculado. Vuelve a autorizar tus agentes cuando lo vincules.",
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
      content.innerHTML = '<h2>Mis agentes</h2><div id="agent-list"></div>';
      renderAgents();
      content.append(byId("agent-guide").content.cloneNode(true));
    } else {
      const { requests: used, monthlyLimit: limit } = me.usage;
      const remaining = Math.max(0, limit - used),
        fmt = (n) => n.toLocaleString("es-MX");
      const bill = me.billing,
        canSubscribe = bill.enabled && !bill.subscribed,
        canManage = bill.manageable && bill.hasCustomer;
      content.innerHTML = `<h2>Mi cuenta</h2>
        <section class="account-block billing-overview" id="facturacion" aria-labelledby="billing-title">
          <div class="billing-heading"><h3 id="billing-title">Facturación</h3><span class="plan-state">${escape(paymentStateText(bill.state, me.user.trialUntil))}</span></div>
          <div class="billing-usage"><div class="usage-title"><h4 id="usage-label">Envíos disponibles este mes</h4><strong>${fmt(remaining)} <small>de ${fmt(limit)}</small></strong></div>
          <progress id="usage-meter" aria-labelledby="usage-label" aria-valuetext="${fmt(remaining)} envíos disponibles de ${fmt(limit)}" max="${limit}" value="${remaining}"></progress>
          <p>${fmt(used)} utilizados · Se renueva el primer día de cada mes (UTC).</p></div>
          <div class="plan-details"><div><strong>${bill.enabled || bill.subscribed ? "Plan mensual" : "Plan previsto"} · USD 10</strong><small>Por un número, hasta cinco conexiones de agente. El consumo de IA se paga por separado.</small></div>
          ${bill.state === "beta" ? `<div><strong>Fin de la prueba</strong><small>${escape(new Date(me.user.trialUntil).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }))}</small></div>` : ""}
          </div>${!bill.enabled && !bill.subscribed ? '<p class="billing-note">Los cobros todavía están desactivados.</p>' : ""}
          ${canSubscribe || canManage ? `<div class="control-row">${canSubscribe ? '<button id="checkout">Activar suscripción</button>' : ""}${canManage ? '<button id="billing-portal" class="secondary">Gestionar suscripción</button>' : ""}</div>` : ""}</section>
        <section class="account-block account-security"><h3>Seguridad</h3><div class="settings-row"><div><strong>Contraseña</strong><small>${escape(me.user.email)}</small></div><button type="button" class="secondary" id="open-password">Cambiar contraseña</button></div>
        <div class="account-removal"><button type="button" id="open-delete" aria-haspopup="dialog">Eliminar mi cuenta</button></div></section>
        <dialog id="password-dialog" aria-labelledby="password-title"><h2 id="password-title">Cambiar contraseña</h2><form class="app-form" id="password-form"><label>Contraseña actual<input type="password" name="current" required autocomplete="current-password"></label><label>Nueva contraseña<input type="password" name="password" required minlength="8" maxlength="200" autocomplete="new-password" aria-describedby="min-length"></label><small id="min-length">Mínimo 8 caracteres.</small><p role="alert"></p><div class="dialog-actions"><button type="button" class="secondary" data-close>Cancelar</button><button type="submit">Guardar contraseña</button></div></form></dialog>
        <dialog id="delete-dialog" aria-labelledby="delete-title"><h2 id="delete-title">Eliminar mi cuenta</h2><p>Esta acción cierra sesiones, revoca agentes y elimina la conexión y los registros locales. Si existe una suscripción, se cancelará. Si WhatsApp no responde, tendrás que retirar el dispositivo desde el teléfono. Las copias de recuperación cifradas pueden conservar datos previos hasta 30 días.</p><form id="delete-form" class="app-form"><label for="delete-password">Confirma tu contraseña</label><input id="delete-password" name="password" type="password" minlength="8" required autocomplete="current-password"><label for="delete-word">Escribe ELIMINAR</label><input id="delete-word" name="confirm" required pattern="ELIMINAR" autocomplete="off"><p role="alert"></p><div class="dialog-actions"><button type="button" data-close class="secondary">Cancelar</button><button class="danger" type="submit">Eliminar mi cuenta y sus datos</button></div></form></dialog>`;
      byId("checkout")?.addEventListener("click", () =>
        goBilling("/api/app/checkout"),
      );
      byId("billing-portal")?.addEventListener("click", () =>
        goBilling("/api/app/billing/portal"),
      );
      for (const action of ["password", "delete"]) {
        const dialog = byId(action + "-dialog"),
          trigger = byId("open-" + action);
        trigger.onclick = () => dialog.showModal();
        dialog.querySelector("[data-close]").onclick = () => dialog.close();
        dialog.onclose = () => {
          dialog.querySelector("form").reset();
          dialog.querySelector('[role="alert"]').textContent = "";
          trigger.focus();
        };
      }
      byId("password-form").onsubmit = async (e) => {
        e.preventDefault();
        const form = e.currentTarget,
          submit = form.querySelector("[type=submit]");
        submit.disabled = true;
        try {
          await request(
            "/api/app/password",
            Object.fromEntries(new FormData(form)),
          );
          byId("password-dialog").close();
          notice("Contraseña actualizada. Tus otras sesiones web se cerraron.");
        } catch (err) {
          form.querySelector('[role="alert"]').textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      };
      byId("delete-form").onsubmit = async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const b = form.querySelector("button[type=submit]");
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
          form.querySelector('[role="alert"]').textContent = error.message;
          b.disabled = false;
        }
      };
    }
  }
  function renderAgents() {
    const list = byId("agent-list");
    if (!me.agents.length) {
      list.innerHTML =
        "<p>Todavía no has conectado un agente. Elige uno abajo para empezar.</p>";
      return;
    }
    const numberName = (id) => {
      const n = me.numbers.find((n) => n.id === id);
      return (
        n?.label ||
        n?.selfJid?.split("@")[0].split(":")[0] ||
        "Número principal"
      );
    };
    list.innerHTML = me.agents
      .map((a) => {
        const logo = {
          openai: "openai.svg",
          claude: "claude.svg",
          grok: "grok.png",
          muse: "muse.svg",
        }[a.provider];
        const icon = logo
          ? `<img class="agent-logo" width="38" height="38" src="/assets/platforms/${logo}" alt="">`
          : `<span class="agent-initial" aria-hidden="true">${escape(a.name.slice(0, 1))}</span>`;
        return `<article class="connected-agent"><div class="agent-identity">${icon}<div><h3>${escape(a.name)}</h3><p>${escape(a.numberIds.map(numberName).join(" · "))}</p></div></div><div class="agent-access"><span>${a.permissions.includes("send") ? "Leer y responder" : "Leer mensajes"}</span><small>${a.expiresAt ? "Hasta el " + escape(new Date(a.expiresAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })) : "Permiso indefinido"}</small></div><button class="secondary" data-revoke="${escape(a.id)}" type="button" aria-label="Revocar acceso de ${escape(a.name)}">Revocar</button>${a.provider === "openai" && a.events?.count ? dotAlerts(a) : ""}</article>`;
      })
      .join("");
    const webhookAgents = me.agents.filter(
      (a) => a.provider !== "openai" || a.wake,
    );
    if (webhookAgents.length) manualWake(list, webhookAgents);
    list.querySelectorAll("[data-revoke]").forEach(
      (b) =>
        (b.onclick = async () => {
          const a = me.agents.find((v) => v.id === b.dataset.revoke);
          if (
            !confirm(
              "¿Revocar el acceso de " +
                a.name +
                "? Ese agente perderá el acceso; WhatsApp seguirá conectado.",
            )
          )
            return;
          try {
            await request("/api/app/agents/revoke", { id: a.id });
            me = await request("/api/app/me");
            me.account =
              me.numbers?.find(
                (a) => a.id === sessionStorage.getItem("essoriaNumber"),
              ) ?? me.account;
            renderAgents();

            notice("Conexión revocada. No se desconectó tu teléfono.");
          } catch (e) {
            notice(e.message);
          }
        }),
    );
  }
  function dotAlerts(agent) {
    const last = agent.events.lastAccepted;
    return `<details class="dot-alerts"><summary>Avisos en Dot</summary><p>Suscripciones activas: ${agent.events.count}.</p><p>${last ? "Último aviso recibido por el servicio de Dot: " + escape(date(last)) + "." : "Esperando el primer aviso."} Puedes detener los avisos desde el chat donde los activaste.</p></details>`;
  }
  function manualWake(list, webhookAgents) {
    const panel = document.createElement("details");
    panel.className = "agent-alerts";
    panel.innerHTML = `<summary>Avisos por webhook</summary><p>Cuando llega un mensaje que coincide, Essoria avisa a la URL de tu agente. El agente puede abrir el mensaje con su conexión autorizada.</p><form id="wake-config"><label>Conexión <select name="id">${webhookAgents.map((a) => `<option value="${escape(a.id)}">${escape(a.name)} · ${a.wake ? "Avisos activos" : "Sin avisos"}</option>`).join("")}</select></label><label>Avisar por <select name="mode"><option value="off">Desactivado</option><option value="all">Cada mensaje entrante</option><option value="new">Primer mensaje de un chat</option><option value="contacts">Contactos específicos</option></select></label><label>URL HTTPS del agente <input name="url" type="url" autocomplete="off"></label><label>Contactos con código de país, separados por comas <input name="contacts"></label><label>Firma del receptor (si tu agente la pide) <input name="signingKey" type="password" autocomplete="new-password"></label><button>Guardar avisos</button></form>`;
    list.append(panel);
    const form = byId("wake-config");
    function showWake() {
      const a = me.agents.find((a) => a.id === form.elements.id.value);
      form.elements.mode.value = a.wake?.mode ?? "off";
      form.elements.contacts.value = a.wake?.contacts.join(", ") ?? "";
      form.elements.url.value = "";
      form.elements.url.placeholder = a.wake
        ? "Reintroduce la URL de " + a.wake.host
        : "https://";
      form.elements.signingKey.value = "";
    }
    function showFields() {
      const off = form.elements.mode.value === "off";
      for (const field of ["url", "signingKey", "contacts"])
        form.elements[field].closest("label").hidden =
          off ||
          (field === "contacts" && form.elements.mode.value !== "contacts");
    }
    form.elements.mode.onchange = showFields;
    form.elements.id.onchange = () => {
      showWake();
      showFields();
    };
    showWake();
    showFields();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      try {
        await request("/api/app/agents/wake", {
          id: v.id,
          settings:
            v.mode === "off"
              ? null
              : {
                  mode: v.mode,
                  url: v.url,
                  contacts: v.contacts
                    .split(",")
                    .map((n) => n.trim())
                    .filter(Boolean),
                  signingKey: v.signingKey,
                },
        });
        await load();
        notice("Configuración de avisos guardada.");
      } catch (err) {
        notice(err.message);
      }
    };
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
      account: me.account.id,
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
    me.account =
      me.numbers?.find(
        (a) => a.id === sessionStorage.getItem("essoriaNumber"),
      ) ?? me.account;
    if (byId("phone-state")) {
      byId("phone-state").textContent = stateText(me.account.state);
      byId("phone-identity").textContent =
        me.account.selfJid?.split("@")[0].split(":")[0] || "Sin vincular";
      byId("pair-phone").textContent =
        me.account.state === "open" ? "Comprobar conexión" : "Vincular con QR";
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
        body: JSON.stringify({
          name: "whatsapp_pairing_get",
          account: me.account.id,
        }),
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
            "El código se renueva automáticamente.";
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
          byId("scan-title").textContent = "Dispositivo vinculado";
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
  });
  load().catch((e) => notice(e.message));
})();
