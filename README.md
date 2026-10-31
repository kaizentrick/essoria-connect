# Essoria

Conecta tu WhatsApp con tu propio agente de IA. Vinculación mediante QR, teléfono disponible, cuentas separadas y MCP estándar. Aplicación y web multipágina en español, tema oscuro, logos reales y una composición HyperFrames editable.

El transporte procede del [prototipo WhatsApp MCP](https://github.com/kaizentrick/whatsapp-mcp); **no depende de Evolution API**.

## Qué incluye

- Registro, acceso, código de recuperación, prueba de siete días y eliminación de la cuenta.
- Un número por cuenta de la aplicación y hasta cinco claves de agentes, con lectura, envío y gestión separados. El operador puede administrar múltiples números.
- 20 herramientas MCP para cuentas, QR, contactos, chats, historial disponible, grupos, envío a uno mismo, contactos o números nuevos con WhatsApp, archivos y recibos. El catálogo se filtra según los permisos.
- MCP Streamable HTTP `/mcp`, OAuth con PKCE y puente stdio. Cada agente recibe una autorización revocable.
- `/mcp/code` opcional: `search` + `execute` del SDK Code Mode de Cloudflare y un ejecutor QuickJS/WASM autoalojado. Conserva los permisos y la separación por cuenta.
- Facturación preparada con Stripe Checkout, portal y webhooks firmados, cerrada por defecto. Plan propuesto: USD 10/mes, un número, cinco claves y 1.000 solicitudes únicas de envío por mes UTC. El modelo de IA se paga por separado.
- Docker sin root, SQLite persistente, credenciales y registros originales cifrados, pruebas y CI.

WhatsApp QR usa Baileys y un dispositivo vinculado. **No es la API oficial de Meta ni coexistencia oficial de WhatsApp Business Platform.** El historial depende de lo que WhatsApp sincronice. Instagram y Facebook están previstas; no tienen conectores implementados. No se incluye un modelo de IA.

## Ejecutar en tu servidor

Requiere Node 24 o posterior, disco local persistente y un solo proceso propietario de las sesiones.

```sh
npm ci
npm run build
WA_DATA_DIR=./data npm run init
WA_DATA_DIR=./data WA_PUBLIC_URL=http://127.0.0.1:8787 ESSORIA_SIGNUP_OPEN=true npm start
```

Abre `http://127.0.0.1:8787`. Regístrate, guarda el código de recuperación y abre **Conexiones**. Muestra el QR en un ordenador o tableta y escanéalo desde WhatsApp → Dispositivos vinculados en el teléfono. Después crea una clave en **Agentes**. Lectura es el permiso inicial; envío y gestión se eligen explícitamente.

Docker:

```sh
cp .env.example .env
# Configura el origen HTTPS y el registro en .env.
docker compose up -d --build
```

El puerto se publica solo en loopback. Configura tu túnel o proxy para la totalidad del origen, incluidos OAuth y `/mcp/code`. No elimines el volumen al actualizar.

## Conectar un agente

Para un cliente MCP remoto, añade `https://TU-DOMINIO/mcp`, inicia su flujo OAuth y autoriza con la clave de **tu cuenta**. Si el cliente acepta Bearer directamente, configura esa clave en su almacén privado de credenciales. No uses la clave global del operador para un agente limitado.

Un cliente exclusivamente stdio puede ejecutar:

```sh
WA_SERVER_URL=https://TU-DOMINIO WA_CLIENT_TOKEN_FILE=/ruta/privada/agente.token node dist/cli.js stdio
```

El puente exige una clave explícita y no selecciona automáticamente la del operador. El protocolo MCP permite clientes de distintos proveedores; la compatibilidad concreta depende del transporte y autenticación admitidos por cada cliente. No hay un acuerdo o certificación implícitos con las marcas mostradas.

Usa un `requestId` nuevo para cada envío intencional; reutiliza el mismo para consultar/reintentar esa misma operación. Un resultado incierto no se vuelve a enviar automáticamente. Un socket conectado o una aceptación de envío no demuestran entrega: consulta los recibos.

## Verificar

```sh
npm test
npm run check
npm run audit:runtime
npm run motion:check
npm run smoke:qr
```

`smoke:qr` abre una sesión temporal, confirma que recibe un QR y la elimina sin enviar mensajes ni imprimir el QR. Las pruebas automáticas de envío usan un transporte sintético. La aceptación real exige vincular teléfonos, comprobar recepción en ambos sentidos, recibos y persistencia tras reiniciar; no debe confundirse con esas pruebas.

La animación está en `public/motion`: HTML, CSS, GSAP, recursos y contrato de movimiento. La web la reproduce una sola vez y permite pausa/repetición; respeta movimiento reducido. Los logos no se animan ni se recolorean. Su procedencia está en `public/platforms/provenance.json`.

## Documentación

- [Despliegue, seguridad operativa y recuperación](docs/deployment.md)
- [MCP, permisos y herramientas](docs/mcp.md)
- [Code Mode: arquitectura, límites y comparación](docs/codemode.md)
- [Preparación de Stripe y apertura comercial](docs/billing.md)
- [Roadmap y condiciones de migración](docs/ROADMAP.md)

Licencia GPL-3.0-only para este código. Consulta `NOTICE` y las licencias de dependencias/recursos. Las marcas pertenecen a sus titulares.
