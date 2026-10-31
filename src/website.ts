import express from "express";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
const pages: Record<
  string,
  { title: string; description: string; body: string }
> = {
  "/": {
    title: "Tus redes, al alcance de tu agente",
    description:
      "Conecta WhatsApp por QR y dale acceso a tu propio agente de IA mediante MCP. Un número, permisos claros y control para revocar.",
    body: `<section class="connection-intro"><div class="proposition"><h1>Tus redes.<br>Tu agente.<br>Tú decides.</h1><p class="lead">Un lugar para conectar tus cuentas con la IA que ya usas. Empieza con WhatsApp por QR, sin dejar de usarlo en tu teléfono.</p><p class="launch-price">USD 10 <span>/ mes por un número</span></p><p class="availability">Versión beta. WhatsApp es la primera conexión; otras redes están previstas. Los cobros aún no están habilitados.</p><a class="action" href="/registro">Preparar mi conexión</a><a class="text-link" href="/producto">Conocer el producto →</a></div><div class="connection-route"><h2>De tu número a tu agente</h2><iframe id="connection-motion" class="connection-motion" src="/assets/motion/index.html" title="Animación explicativa de la conexión entre WhatsApp, Essoria y agentes de IA" loading="lazy" tabindex="-1"></iframe><div class="motion-controls"><button id="motion-play" type="button" class="secondary">Reproducir recorrido</button><span id="motion-state" class="motion-caption">Animación explicativa; sin datos reales.</span></div><p class="motion-transcript">Tu agente consulta → Essoria verifica tus permisos → WhatsApp devuelve el resultado. Tú puedes revocar el acceso.</p><p class="route-note">La vinculación QR es un dispositivo conectado a WhatsApp Web. No es la API oficial de Meta.</p></div></section><ol class="connection-steps" aria-label="Cómo empezar"><li><span class="step-number">01</span><div><h3>Vincula WhatsApp</h3><p>Escanea el QR con tu teléfono desde otra pantalla. Conservas la app y tus conversaciones.</p></div></li><li><span class="step-number">02</span><div><h3>Elige los permisos</h3><p>Lectura, envío y gestión por separado. Una clave para cada agente, limitada a tu cuenta.</p></div></li><li><span class="step-number">03</span><div><h3>Conecta tu propia IA</h3><p>Usa un cliente MCP compatible. Puedes consultar, redactar y autorizar acciones desde tu agente.</p></div></li></ol><section class="platform-roster" aria-label="Plataformas y clientes"><p>WhatsApp es la conexión inicial. Usa tu propio cliente compatible con MCP.</p><span><img src="/assets/platforms/whatsapp.svg" width="32" height="32" alt="">WhatsApp QR</span><span><img src="/assets/platforms/claude.svg" width="32" height="32" alt="">Claude</span><span><img src="/assets/platforms/openai.svg" width="32" height="32" alt="">OpenAI</span><span><img src="/assets/platforms/gemini.svg" width="32" height="32" alt="">Gemini</span><p>Instagram y Facebook están previstas; no son conexiones activas.</p><span><img src="/assets/platforms/instagram.svg" width="32" height="32" alt="">Instagram · previsto</span><span><img src="/assets/platforms/facebook.svg" width="32" height="32" alt="">Facebook · previsto</span></section><section class="capability-ledger"><div><h2>La conexión es tuya.<br>El control también.</h2><p>Essoria conecta cuentas y herramientas. Tu agente aporta el razonamiento y tú decides cuándo puede actuar.</p></div><dl><div><dt>Un teléfono, tu cuenta</dt><dd>Cuenta y credenciales separadas. El agente no puede saltar a otros números.</dd></div><div><dt>Contactos y grupos</dt><dd>Consulta el historial disponible, los participantes y el estado de los mensajes.</dd></div><div><dt>También a números nuevos</dt><dd>No necesitas guardarlos como contacto. Sí deben tener WhatsApp y autorizar el contacto.</dd></div><div><dt>Revoca cuando quieras</dt><dd>Retira una clave de agente, pausa la conexión o desvincula el teléfono.</dd></div></dl></section><section class="reading-path"><h2>Antes de conectar</h2><a href="/integraciones"><span>01</span> Qué está disponible y qué viene después <b>→</b></a><a href="/agentes"><span>02</span> Cómo conectar tu agente y elegir permisos <b>→</b></a><a href="/seguridad"><span>03</span> Dónde viven tus datos y cómo eliminarlos <b>→</b></a></section>`,
  },
  "/producto": {
    title: "Una conexión que trabaja contigo",
    description:
      "Así funciona Essoria: WhatsApp por QR, cuentas separadas, permisos y acceso desde tu propio agente.",
    body: `<div class="document-opening"><h1>Tu WhatsApp no tiene que cambiar de manos.</h1><p class="lead">Conecta tu número como dispositivo vinculado y permite que tu propio agente use las herramientas que tú autorizas.</p></div><div class="document-columns"><aside><a href="/registro">Preparar mi conexión →</a><p>Necesitas tu teléfono con WhatsApp y otra pantalla para mostrar el QR.</p></aside><article><h2>Una cuenta, una conexión</h2><p>Cada cuenta de Essoria tiene un número independiente. El plan inicial contempla un número y hasta cinco claves para agentes. Los permisos se aplican en el servidor, además de las instrucciones que le des a tu IA.</p><h2>Lo cotidiano, desde tu agente</h2><p>Consultar una conversación, identificar participantes de un grupo, recuperar un archivo o escribir un mensaje a un contacto nuevo. Siempre con una cuenta de origen explícita y la autorización correspondiente.</p><h2>WhatsApp sigue en tu teléfono</h2><p>La conexión por QR utiliza el mecanismo de dispositivos vinculados de WhatsApp Web mediante Baileys. No hace falta trasladar el número a la API oficial de Meta. Este transporte no es oficial y puede requerir volver a escanear el QR si WhatsApp cierra la sesión.</p><h2>El historial que realmente llega</h2><p>Essoria guarda lo que WhatsApp sincroniza al dispositivo. Una conexión abierta no garantiza que esté disponible todo el historial del teléfono. Un envío aceptado tampoco demuestra entrega o lectura: los recibos se consultan por separado.</p><h2>Sin una IA impuesta</h2><p>Trae tu agente y tu proveedor. Essoria no incluye un modelo de IA ni cobra su consumo. El cliente debe admitir MCP por HTTP/OAuth, Bearer o mediante el puente stdio.</p><a href="/docs">Ver la guía de conexión →</a></article></div>`,
  },
  "/integraciones": {
    title: "Un lugar para tus conexiones",
    description:
      "WhatsApp QR es la primera integración de Essoria. Conoce las capacidades actuales y el estado de otras redes.",
    body: `<div class="document-opening"><h1>Un lugar para conectar.<br>Sin promesas escondidas.</h1><p class="lead">Empezamos por WhatsApp. Aquí puedes distinguir lo que está implementado de lo que todavía está previsto.</p></div><div class="integration-table"><table><caption>Estado de las conexiones de Essoria</caption><thead><tr><th>Conexión</th><th>Estado</th><th>Qué permite</th></tr></thead><tbody><tr><th><span class="platform-record"><img src="/assets/platforms/whatsapp.svg" width="32" height="32" alt="">WhatsApp QR</span></th><td>Beta</td><td>Vincular un número, consultar chats y grupos, enviar texto y archivos con permisos.</td></tr><tr><th>Agentes por MCP</th><td>Implementado</td><td>Conectar tu propio cliente compatible por HTTP o stdio.</td></tr><tr><th>Code Mode</th><td>Experimental</td><td>Buscar operaciones, combinar llamadas y devolver un resultado reducido en una ejecución aislada.</td></tr><tr><th><span class="platform-record"><img src="/assets/platforms/instagram.svg" width="32" height="32" alt="">Instagram</span></th><td>Previsto</td><td>Sin conexión disponible todavía.</td></tr><tr><th><span class="platform-record"><img src="/assets/platforms/facebook.svg" width="32" height="32" alt="">Facebook</span></th><td>Previsto</td><td>Sin conexión disponible todavía.</td></tr></tbody></table></div><div class="document-columns"><aside><a href="/agentes">Conectar un agente →</a></aside><article><h2>Permisos por conexión</h2><p>Una clave de Essoria solo puede usar la cuenta para la que se creó. La lectura no autoriza enviar, y el envío no autoriza desvincular un teléfono.</p><h2>Coexistencia con la app</h2><p>En esta versión, coexistencia significa mantener WhatsApp en tu teléfono y vincular Essoria por QR. No ofrecemos ni presentamos este modo como coexistencia oficial de WhatsApp Business Platform.</p><h2>Redes futuras</h2><p>No se pide acceso a Instagram o Facebook mientras sus conectores no estén disponibles. No se cobra por esas funciones previstas.</p></article></div>`,
  },
  "/agentes": {
    title: "Conecta la IA que tú eliges",
    description:
      "MCP estándar y Code Mode para conectar tus propios agentes a tu cuenta de Essoria con permisos separados.",
    body: `<div class="document-opening"><h1>Tu agente ya tiene cerebro.<br>Ahora dale una conexión.</h1><p class="lead">Essoria expone herramientas MCP. Tu cliente y proveedor de IA siguen siendo tuyos.</p></div><div class="document-columns"><aside><p>El cliente debe soportar el transporte y la autenticación elegidos.</p><a href="/app/agentes">Gestionar mis claves →</a></aside><article><h2>1. Crea una clave limitada</h2><p>Entra a tu cuenta, abre Agentes y elige lectura, envío o gestión. Lectura es el permiso inicial. La clave se muestra una sola vez: guárdala de forma privada.</p><h2>2. Elige cómo conectarte</h2><dl class="plain-list"><div><dt>MCP estándar</dt><dd>Endpoint <code>https://essoria.app/mcp</code>. Herramientas independientes para tareas simples y compatibilidad amplia.</dd></div><div><dt>Code Mode</dt><dd>Endpoint <code>https://essoria.app/mcp/code</code>. Dos herramientas para descubrir operaciones y combinar llamadas. Usa el SDK Code Mode de Cloudflare con un ejecutor WebAssembly autoalojado.</dd></div><div><dt>Puente stdio</dt><dd>Para clientes locales que lanzan un proceso. El puente se conecta al mismo servicio persistente; no abre otro WhatsApp.</dd></div></dl><h2>3. Verifica una consulta</h2><p>Empieza por listar tu cuenta. Haber copiado la configuración no demuestra que el agente esté conectado. La app distingue una clave creada de una clave que ya hizo una petición autenticada.</p><pre aria-label="Ejemplo de configuración MCP"><code>{
  "mcpServers": {
    "essoria": {
      "url": "https://essoria.app/mcp",
      "headers": { "Authorization": "Bearer TU_CLAVE_PRIVADA" }
    }
  }
}</code></pre><p>Este formato es orientativo: algunos clientes usan su propia pantalla de conexión u OAuth. Nunca publiques la clave ni la incluyas en una URL.</p><h2>Revoca sin desconectar tu teléfono</h2><p>Eliminar la clave de un agente retira su acceso. Pausar WhatsApp o desvincular el teléfono son acciones distintas, con controles separados.</p><a href="/docs">Leer ejemplos de uso y límites →</a></article></div>`,
  },
  "/precios": {
    title: "Un precio claro para empezar",
    description:
      "Propuesta de lanzamiento de Essoria: USD 10 al mes por un número, cinco claves de agente y límites definidos.",
    body: `<div class="document-opening"><h1>Una conexión.<br>Un precio claro.</h1><p class="lead">Empieza con tu número y tu propio agente. Sin pagar por redes que todavía no están conectadas.</p></div><section class="price-folio"><div><h2>Essoria Inicio</h2><p class="large-price">USD 10 <span>/ mes</span></p><p>Suscripción mensual propuesta por un número.</p><p class="availability">Los cobros aún no están habilitados. El precio no activa una compra ni garantiza aceptación del teléfono durante la beta.</p><a class="action" href="/registro">Preparar mi cuenta</a></div><dl class="plain-list"><div><dt>1 número de WhatsApp</dt><dd>Vinculación por QR y uso en el teléfono.</dd></div><div><dt>5 claves de agente</dt><dd>Permisos separados, caducidad y revocación.</dd></div><div><dt>1.000 solicitudes de envío al mes</dt><dd>El límite incluye resultados inciertos y se cuenta por solicitud única. Sin campañas masivas.</dd></div><div><dt>MCP y Code Mode</dt><dd>Acceso por clientes compatibles. Sin modelo de IA incluido.</dd></div></dl></section><article class="reading-copy"><h2>Antes de contratar</h2><p>Cuando los cobros estén disponibles, la suscripción se renovará mensualmente y podrá gestionarse o cancelarse desde el portal de Stripe. El precio se expresa en dólares estadounidenses; los impuestos aplicables se comunicarán antes del pago. El proveedor de tu agente factura su consumo por separado.</p><h2>Primero, una conexión comprobada</h2><p>La versión se está validando con teléfonos reales antes de habilitar ventas. Necesitas otra pantalla para mostrar el QR y tu teléfono para escanearlo. Las conexiones a Instagram y Facebook no están incluidas.</p><a href="/contacto">Consultar disponibilidad →</a></article>`,
  },
  "/docs": {
    title: "Guía de conexión",
    description:
      "Vincula WhatsApp por QR, crea permisos para tu agente y verifica tu primera consulta en Essoria.",
    body: `<div class="document-opening"><h1>De cero a tu primera consulta.</h1><p class="lead">Una guía breve para conectar tu teléfono y tu agente sin compartir más acceso del necesario.</p></div><div class="document-columns"><aside><nav aria-label="Guía"><a href="#telefono">Vincular teléfono</a><a href="#permisos">Crear permisos</a><a href="#consulta">Verificar consulta</a><a href="#recuperar">Recuperar acceso</a></nav></aside><article><h2 id="telefono">1. Prepara dos pantallas</h2><p>Abre Essoria en un ordenador o tableta. En tu teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo. Un teléfono no puede escanear el QR mostrado en su propia pantalla.</p><p>En Conexiones, pulsa Vincular por QR. El código se renueva y los códigos vencidos dejan de mostrarse. La conexión sigue en el servidor aunque cierres la página.</p><h2 id="permisos">2. Autoriza a tu agente</h2><p>En Agentes, ponle un nombre reconocible y selecciona permisos. Comienza con lectura. Activa envío solo si quieres que el agente pueda mandar mensajes y gestión solo si también debe administrar la sesión.</p><p>Copia o descarga la clave al crearla. No se vuelve a mostrar. Puedes generar una nueva y revocar la anterior si la pierdes.</p><h2 id="consulta">3. Confirma el acceso</h2><p>Conecta el endpoint MCP en tu cliente. Pide listar las cuentas disponibles y consulta el estado de tu número. La app mostrará la última petición autenticada de la clave cuando se haya observado.</p><p>Para escribir a un número ausente de contactos, usa su número con código de país. Debe tener WhatsApp. Cada envío necesita un <code>requestId</code> único. Si el resultado es incierto, consulta su estado: no repitas con un identificador nuevo.</p><h2>Qué significa cada estado</h2><dl class="plain-list"><div><dt>Conectado</dt><dd>El transporte está abierto; el historial puede seguir sincronizándose.</dd></div><div><dt>Reconectando</dt><dd>El servidor intenta recuperar la conexión. Evita reenviar mensajes por tu cuenta.</dd></div><div><dt>Pausado</dt><dd>Detuviste la conexión conservando credenciales; puedes reanudarla.</dd></div><div><dt>Desvinculado</dt><dd>La sesión se cerró y requiere un QR nuevo. Las claves anteriores dejan de ser válidas.</dd></div></dl><h2 id="recuperar">Recupera tu acceso</h2><p>Guarda el código de recuperación que aparece al registrarte. Con él puedes establecer una contraseña nueva. Se cerrarán las demás sesiones y se revocarán las claves de agente. Si no lo guardaste, contacta al equipo; no se enviarán contraseñas por correo.</p><a href="/recuperar">Usar mi código de recuperación →</a></article></div>`,
  },
  "/seguridad": {
    title: "Permisos claros. Datos bajo control.",
    description:
      "Cómo Essoria separa cuentas, protege credenciales y permite revocar accesos y eliminar datos.",
    body: `<div class="document-opening"><h1>El acceso se concede.<br>Y también se retira.</h1><p class="lead">Cada agente usa una clave limitada a tu cuenta. Tú decides qué puede consultar, enviar o administrar.</p></div><article class="reading-copy"><h2>Separación en el servidor</h2><p>Los permisos se verifican en cada operación, tanto en MCP estándar como dentro de Code Mode. Cambiar el nombre de una cuenta en una petición no concede acceso a otra.</p><h2>Qué se cifra</h2><p>Las credenciales de WhatsApp, las claves Signal, los registros originales de mensajes y las autorizaciones OAuth se guardan con cifrado autenticado. El texto consultable y los índices de contactos, chats y recibos no están cifrados dentro de SQLite. El servidor y las copias deben estar protegidos.</p><h2>Code Mode aislado</h2><p>El código del agente se ejecuta en WebAssembly con límites de memoria, tiempo y llamadas. No recibe acceso al sistema de archivos, a la red general ni a las credenciales. Las acciones pasan por la misma validación y permisos que MCP.</p><h2>Pausar, revocar y eliminar</h2><p>Puedes revocar una clave sin detener WhatsApp; pausar la conexión conservando la sesión; o desvincular el dispositivo. Eliminar tu cuenta retira su acceso y borra sus registros locales. Si WhatsApp no responde al cierre, la app te indicará cómo retirar el dispositivo desde tu teléfono.</p><h2>Una conexión no oficial</h2><p>La vinculación QR usa Baileys y WhatsApp Web. Essoria no está afiliada a Meta, no ofrece un sello oficial ni garantiza que WhatsApp mantenga una sesión abierta indefinidamente.</p><a href="/privacidad">Consultar privacidad y retención →</a></article>`,
  },
  "/contacto": {
    title: "Hablemos de tu conexión",
    description:
      "Contacta al equipo de Essoria para acceso a la beta, dudas del producto o ayuda con tu cuenta.",
    body: `<div class="document-opening"><h1>Cuéntanos qué necesitas conectar.</h1><p class="lead">Ayuda con tu cuenta, acceso a la beta o una red que te gustaría integrar.</p></div><form id="contact-form" class="account-form"><label for="contact-email">Tu correo</label><input id="contact-email" name="email" type="email" autocomplete="email" required maxlength="200"><label for="contact-message">Tu consulta</label><textarea id="contact-message" name="message" required minlength="20" maxlength="4000" rows="6"></textarea><label class="check-row"><input name="consent" type="checkbox" required> Acepto el tratamiento de esta consulta según la <a href="/privacidad">política de privacidad</a>.</label><button type="submit">Guardar consulta</button><p role="status" id="form-status"></p><p>La consulta se guarda para revisión del equipo. No adjuntes claves, códigos QR, contraseñas ni conversaciones privadas.</p></form>`,
  },
  "/privacidad": {
    title: "Privacidad",
    description:
      "Datos utilizados por Essoria, separación de cuentas, eliminación y límites de la versión beta.",
    body: `<div class="document-opening"><h1>Privacidad en Essoria.</h1><p>Versión del 31 de octubre de 2026. Información de la beta.</p></div><article class="reading-copy"><h2>Responsable y contacto</h2><p>Essoria es un producto de KaizenTrick. Para consultas sobre tus datos o solicitudes de derechos, utiliza <a href="/contacto">el formulario de contacto</a> y conserva tu referencia. Los datos fiscales y la información comercial completa se confirmarán antes de habilitar ventas.</p><h2>Datos que utiliza el servicio</h2><p>Correo, nombre, contraseña protegida con derivación criptográfica, sesiones de acceso, credenciales de los dispositivos que vinculas, contactos, chats, mensajes sincronizados y recibos. Las claves de agentes se guardan por su huella y con sus permisos, caducidad y uso observado.</p><h2>Para qué se utilizan</h2><p>Autenticarte, mantener tu conexión, responder a operaciones que autorizas, gestionar permisos y resolver consultas. Essoria no incluye un modelo de IA. El contenido que tu agente solicite será tratado también por el proveedor que tú elijas, conforme a sus propias condiciones.</p><h2>Terceros y almacenamiento</h2><p>El servicio está autoalojado en la infraestructura de KaizenTrick. Cloudflare facilita el acceso HTTPS por túnel y Stripe se prevé para el cobro. WhatsApp es un servicio externo con sus propias reglas. No presentamos la conexión QR como una API oficial.</p><h2>Eliminación y copias</h2><p>Puedes eliminar tu cuenta desde la app, con confirmación y contraseña. Se retiran las sesiones y claves y se eliminan sus registros de la base activa. Las copias de recuperación cifradas pueden conservar una versión previa durante un máximo de 30 días. Los registros que un procesador de pagos deba conservar se rigen por sus obligaciones aplicables.</p><h2>Protección y límites</h2><p>Se cifran las credenciales y registros originales; el texto buscable y los índices no están cifrados dentro de la base. El QR y las claves no se guardan en el almacenamiento del navegador. No se utilizan rastreadores publicitarios en esta versión.</p></article>`,
  },
  "/terminos": {
    title: "Términos de la beta",
    description:
      "Condiciones de uso de Essoria, acceso por QR, permisos, facturación y límites de la beta.",
    body: `<div class="document-opening"><h1>Condiciones para conectar.</h1><p>Versión del 31 de octubre de 2026. Beta de Essoria.</p></div><article class="reading-copy"><h2>Tu cuenta y tus permisos</h2><p>Debes tener autorización sobre el número que vinculas y el contenido al que das acceso. Conserva tu contraseña, código de recuperación y claves de agente en privado. Las acciones de tus agentes están bajo los permisos y las instrucciones que tú les concedas.</p><h2>Qué ofrece la beta</h2><p>Conexión QR a WhatsApp y herramientas para clientes MCP compatibles. El acceso de prueba dura siete días desde el registro cuando esté habilitado. Se limita a un número, cinco claves de agente y 1.000 solicitudes únicas de envío por mes natural UTC, incluyendo resultados inciertos. No incluye consumo de IA ni redes previstas.</p><h2>Uso permitido</h2><p>No uses el servicio para mensajes masivos no solicitados, fraude, suplantación, acoso o acceso a cuentas ajenas. Cumple las condiciones de WhatsApp y respeta la voluntad de los destinatarios. Tener acceso técnico a un grupo o contacto no autoriza cualquier tratamiento o mensaje.</p><h2>Disponibilidad</h2><p>La beta puede requerir volver a vincular el teléfono y no garantiza historial completo ni disponibilidad continua. La aceptación por el transporte, entrega y lectura son estados distintos. No se deben reintentar automáticamente envíos con resultado incierto.</p><h2>Suscripción futura</h2><p>La propuesta inicial es USD 10 al mes por un número. No se realizan cobros mientras no esté habilitada la facturación. Antes del pago se mostrarán importe, periodicidad e impuestos aplicables; la renovación y cancelación se gestionarán desde Stripe. No se activan derechos por volver a una página de éxito: se verifica el estado del pago en el servidor.</p><h2>Cerrar la cuenta</h2><p>Puedes revocar agentes, pausar WhatsApp o eliminar tu cuenta. Si no se puede retirar el dispositivo remotamente, deberás hacerlo desde WhatsApp → Dispositivos vinculados. Para incidencias y solicitudes de cancelación o reembolso, usa <a href="/contacto">Contacto</a>.</p></article>`,
  },
  "/estado": {
    title: "Estado del servicio",
    description:
      "Disponibilidad del servicio web y API de Essoria sin revelar cuentas ni números privados.",
    body: `<div class="document-opening"><h1>Estado del servicio.</h1><p class="lead" id="service-state" role="status">Comprobando disponibilidad…</p></div><article class="reading-copy"><h2>Qué comprueba esta página</h2><p>Consulta la disponibilidad del proceso web y de su almacenamiento. El estado de cada número y de la sincronización es privado y se ve dentro de tu cuenta.</p><p>Una respuesta correcta no demuestra que todos los teléfonos estén conectados ni que un mensaje haya sido entregado.</p><a href="/app/conexiones">Ver mi conexión →</a></article>`,
  },
};
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const nav = `<a href="/producto">Producto</a><a href="/integraciones">Conexiones</a><a href="/agentes">Agentes</a><a href="/precios">Precios</a><a href="/docs">Guía</a><a href="/entrar">Entrar →</a>`;
function shell(
  title: string,
  description: string,
  body: string,
  path: string,
  origin: string,
) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Essoria</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${origin + path}"><meta name="theme-color" content="#0c3836"><link rel="icon" href="/assets/brand/essoria/favicon-32.png"><link rel="apple-touch-icon" href="/assets/brand/essoria/apple-touch-icon.png"><link rel="stylesheet" href="/assets/essoria.css?v=0.2.1-dark1"><script src="/assets/essoria.js?v=0.2.1-dark1" defer></script></head><body data-route="${path}"><a class="skip-link" href="#main">Saltar al contenido</a><header class="site-header"><a href="/" aria-label="Essoria, inicio"><img src="/assets/brand/essoria/logo-horizontal-dark.png" width="1451" height="360" alt="Essoria"></a><nav class="desktop-nav" aria-label="Principal">${nav}</nav><details class="mobile-nav"><summary>Menú</summary><nav aria-label="Navegación móvil">${nav}</nav></details></header><main id="main">${body}</main><footer class="site-footer"><div><img src="/assets/brand/essoria/logo-horizontal-dark.png" width="1451" height="360" alt="Essoria"><p>Conexiones para tu propio agente.</p><p>Un producto de KaizenTrick.</p></div><nav aria-label="Información"><a href="/seguridad">Seguridad</a><a href="/estado">Estado</a><a href="/contacto">Contacto</a><a href="/privacidad">Privacidad</a><a href="/terminos">Términos</a></nav><p class="footer-disclosure">WhatsApp QR utiliza un dispositivo vinculado mediante un transporte no oficial. Essoria no está afiliada a WhatsApp ni a Meta.</p></footer></body></html>`;
}
function authBody(mode: string) {
  const register = mode === "registro",
    recover = mode === "recuperar";
  return `<div class="auth-layout"><div><h1>${register ? "Tu próxima conexión empieza aquí." : recover ? "Vuelve a tu cuenta." : "Tu espacio de conexiones."}</h1><p class="lead">${recover ? "Usa el código privado que guardaste al registrarte. Se revocarán las sesiones y claves anteriores." : "WhatsApp en tu teléfono. Tu propio agente. Permisos que tú decides."}</p><p>Para vincular WhatsApp por QR necesitarás otra pantalla además de tu teléfono.</p><a href="/docs">Leer la guía antes de empezar →</a></div><form id="auth-form" class="account-form" data-mode="${mode}">${register ? '<label for="name">Tu nombre o negocio</label><input id="name" name="name" autocomplete="organization" minlength="2" maxlength="80" required>' : ""}<label for="email">Correo</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200">${recover ? '<label for="recovery">Código de recuperación</label><input id="recovery" name="recoveryCode" autocomplete="off" required minlength="20">' : ""}<label for="password">${recover ? "Nueva contraseña" : "Contraseña"}</label><input id="password" name="password" type="password" autocomplete="${register || recover ? "new-password" : "current-password"}" required minlength="12" maxlength="200" aria-describedby="password-help"><p id="password-help">Usa al menos 12 caracteres. Puedes usar un gestor de contraseñas.</p>${register ? '<label class="check-row"><input type="checkbox" name="acceptedTerms" required><span> Acepto los <a href="/terminos">términos</a> y la <a href="/privacidad">privacidad</a> de la beta.</span></label>' : ""}<button type="submit">${register ? "Crear mi cuenta" : recover ? "Restablecer acceso" : "Entrar"}</button><p id="form-status" role="status"></p><div id="recovery-result" hidden><h2>Guarda tu código privado</h2><p>Es necesario para recuperar tu cuenta. No volverá a mostrarse. No lo compartas con tus agentes.</p><code id="recovery-value"></code><button id="copy-recovery" type="button">Copiar código</button><button id="download-recovery" type="button">Descargar código</button><a class="action" href="/app">Ya lo guardé, abrir mi cuenta →</a></div><div class="auth-links"><a href="${register ? "/entrar" : "/registro"}">${register ? "Ya tengo cuenta" : "Crear una cuenta"}</a><a href="/recuperar">Recuperar acceso</a><a href="/contacto">Necesito ayuda</a></div></form></div>`;
}
const appBody = `<div class="workspace-heading"><h1>Mi espacio</h1><p id="account-identity">Cargando tu cuenta…</p><button id="sign-out" type="button">Cerrar sesión</button></div><div class="workspace-layout"><nav class="workspace-nav" aria-label="Mi cuenta"><a href="/app/conexiones">Conexiones</a><a href="/app/agentes">Agentes</a><a href="/app/facturacion">Facturación</a><a href="/app/cuenta">Mi cuenta</a></nav><div id="workspace-content"><p role="status">Consultando el estado actual…</p></div></div><p id="app-notice" role="status" class="app-notice"></p>`;
export function siteRouter(config: Config) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });
  router.use("/assets/motion", (_req, res, next) => {
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'self'; base-uri 'none'",
    );
    next();
  });
  router.use(
    "/assets",
    express.static(fileURLToPath(new URL("../public/", import.meta.url)), {
      index: false,
      dotfiles: "deny",
      maxAge: "1h",
    }),
  );
  for (const [path, p] of Object.entries(pages))
    router.get(path, (_req, res) =>
      res
        .type("html")
        .send(shell(p.title, p.description, p.body, path, config.publicUrl)),
    );
  for (const mode of ["entrar", "registro", "recuperar"])
    router.get("/" + mode, (_req, res) =>
      res
        .type("html")
        .send(
          shell(
            mode === "entrar"
              ? "Entrar"
              : mode === "registro"
                ? "Crear cuenta"
                : "Recuperar acceso",
            "Tu cuenta privada de Essoria.",
            authBody(mode),
            "/" + mode,
            config.publicUrl,
          ),
        ),
    );
  for (const path of [
    "/app",
    "/app/conexiones",
    "/app/agentes",
    "/app/facturacion",
    "/app/cuenta",
  ])
    router.get(path, (_req, res) =>
      res
        .set("X-Robots-Tag", "noindex")
        .type("html")
        .send(
          shell(
            "Mi espacio",
            "Tu cuenta privada de Essoria.",
            appBody,
            path,
            config.publicUrl,
          ),
        ),
    );
  router.get("/robots.txt", (_req, res) =>
    res
      .type("text")
      .send(
        `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api\nDisallow: /operator\nDisallow: /mcp\nSitemap: ${config.publicUrl}/sitemap.xml\n`,
      ),
  );
  router.get("/sitemap.xml", (_req, res) =>
    res.type("xml").send(
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        Object.keys(pages)
          .map((p) => "<url><loc>" + config.publicUrl + p + "</loc></url>")
          .join("") +
        "</urlset>",
    ),
  );
  return router;
}
