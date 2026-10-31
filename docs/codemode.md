# Code Mode en Essoria

Cloudflare Code Mode no sustituye a MCP: cambia el catálogo de herramientas que recibe el agente. Essoria conserva `/mcp` como opción principal y ofrece `/mcp/code` para descubrir y componer consultas con `search` y `execute`.

Usa el SDK oficial `@cloudflare/codemode/mcp` 0.5.6 y un ejecutor propio QuickJS/WASM. No importa el módulo raíz de Workers, no necesita una cuenta de Cloudflare para ejecutarse y no provisiona Workers ni servicios de pago. Cloudflare Tunnel es el transporte HTTPS del despliegue de Essoria; es una función independiente.

## Aislamiento

El código del agente no recibe `process`, `require`, `fetch`, archivos ni credenciales. Solo puede consultar la especificación autorizada y llamar al adaptador de las herramientas WhatsApp. El adaptador admite únicamente POST a rutas locales `/tools/whatsapp_*`, valida el esquema, vuelve a resolver la autorización y conserva la intersección de permisos OAuth. No acepta URL arbitraria ni cuerpo sin validar.

Límites por ejecución: 500 ms de CPU, 45 s de reloj, 16 MiB de memoria, 256 KiB de pila, 12 llamadas y 64.000 caracteres de resultado. Máximo cuatro aislamientos activos en el proceso. Filtra y pagina dentro de la composición; para archivos grandes usa MCP directo. Un timeout no autoriza a repetir un envío: consulta su mismo `requestId`.

## Comparación medida

En la prueba de descubrimiento con una clave de solo lectura, el catálogo directo contiene 13 herramientas. Code Mode presenta dos. Se compara la longitud del JSON de ambos catálogos y se exige que Code Mode sea menor; el resultado exacto queda en la salida de `test/codemode.test.mjs`. La medición local inicial fue aproximadamente 29% menos caracteres de catálogo.

Esta medición **no** demuestra ahorro total de tokens, latencia ni dinero de un modelo. La búsqueda adicional y el aislamiento añaden trabajo. Una llamada simple suele ser más directa con `/mcp`; Code Mode resulta útil para componer varias lecturas y devolver solo un resumen. Los envíos siguen necesitando permiso y la intención explícita del usuario.

OAuth vincula cada autorización a su recurso: `/mcp` y `/mcp/code` se autorizan por separado. La revocación de la clave original invalida ambos accesos derivados.

Referencias primarias: [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/), [MCP con Code Mode](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/), [referencia del adaptador MCP](https://developers.cloudflare.com/agents/tools/codemode/mcp/).
