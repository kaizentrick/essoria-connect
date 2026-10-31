# Roadmap de Essoria

## Base disponible

Transporte propio de WhatsApp QR con Baileys, cuentas y credenciales separadas, búsquedas/recibos/envíos idempotentes, MCP HTTP/OAuth/stdio, Code Mode opcional, web multipágina oscura y app de conexión/agentes/cuenta. Facturación implementada detrás de un cierre comercial.

## Aceptación de la beta

1. Vincular dos teléfonos de prueba como dispositivos nuevos, uno por cuenta. Mantener Evolution mientras se valida la nueva base.
2. Probar uno a otro en ambos sentidos, envío a uno mismo, número nuevo con WhatsApp, grupos permitidos y archivos. Confirmar recepción en los teléfonos y recibos.
3. Reiniciar el servicio conservando el disco, comprobar identidad de ambas cuentas, conexión, historial disponible y nuevos envíos. Probar pausa, revocación y desvinculación.
4. Aceptar recuperación y eliminación, backup cifrado y restauración aislada. No iniciar una copia restaurada de una sesión que todavía tiene otro escritor.
5. Completar Stripe y los flujos de prueba reales antes de habilitar ventas.

Una vez aceptada esa base, retirar servicios/túnel de Evolution con inventario y copia de recuperación. No borrar sesiones previas por el mero hecho de obtener un QR nuevo.

## Siguiente producto

Invitaciones/equipo, almacenamiento y retención por cuenta, métricas operativas sin contenido privado, exportación de datos y control de cuotas por plan. Conectores para Instagram/Facebook requieren desarrollo y autorización reales de sus respectivas plataformas. La integración oficial Meta y su coexistencia son una línea distinta de la conexión QR actual.
