# Facturación de Essoria

La integración está cerrada por defecto. No se cobra desde un botón de prueba ni al volver de Stripe. La propuesta comercial es USD 10 por mes: un número, cinco claves de agente y 1.000 solicitudes únicas de envío por mes UTC. Se cuentan solicitudes admitidas, incluidas las de resultado incierto; reusar el mismo requestId no suma otra operación. Lecturas e IA externa no se facturan por Essoria en este plan.

## Configuración propia

Crea la marca en una cuenta Stripe separada, con dominio y datos públicos de Essoria. No uses claves, clientes ni precios de otro producto. El código verifica el ID de cuenta, `business_profile.url` de essoria.app y un precio activo USD 1000 centavos/mes. En modo real exige también `charges_enabled`.

Configura fuera de Git:

- `ESSORIA_STRIPE_ACCOUNT_ID`, `ESSORIA_STRIPE_PRICE_ID`.
- `ESSORIA_STRIPE_SECRET_KEY`, `ESSORIA_STRIPE_WEBHOOK_SECRET` mediante el gestor privado de secretos del despliegue. Prefiere una clave restringida (`rk_`) con los permisos necesarios para esta aplicación.
- `ESSORIA_COMMERCIAL_READY=true` únicamente después de aceptar teléfonos reales, validar el flujo de prueba completo y activar la marca en Stripe. Mantén el flag falso mientras falte algo.

Con Docker Compose puedes suministrar esas variables desde un archivo privado
fuera del checkout: `docker compose --env-file /ruta/privada/essoria.env up -d --build`.
El archivo de ejemplo no contiene secretos; los valores vacíos mantienen cerrados los cobros.

Para un autoalojamiento de otra marca, cambia de forma explícita la verificación de marca y precio en `src/billing.ts`; no retires silenciosamente esos controles en una instalación compartida.

Endpoint: `POST /api/billing/webhook`. Suscribe Checkout completed/async payment succeeded, customer.subscription created/updated/deleted, invoice paid/payment_failed/payment_action_required, charge.dispute created/closed, charge.refunded y radar.early_fraud_warning.created. La firma se verifica sobre el cuerpo original; no actives un parser JSON delante de esta ruta.

Se relee la suscripción actual para tolerar eventos atrasados. Solo una factura pagada o un período trialing vigente concede acceso de Stripe. Los eventos son idempotentes; los de una suscripción antigua no reemplazan una posterior. Una disputa, reembolso total o alerta de fraude accionable mantiene un bloqueo persistente, incluso durante la prueba o si llega otra notificación de factura. Una disputa ganada levanta su bloqueo; una alerta de fraude requiere revisión del operador. No se ejecuta ningún reembolso automático.

Checkout usa claves idempotentes con parámetros estables. No fija `payment_method_types`; Stripe elige los métodos disponibles. La configuración de impuestos queda pendiente de los registros fiscales reales. No se activa Stripe Tax automáticamente. El portal permite al cliente gestionar su suscripción; la eliminación de cuenta cancela una suscripción existente antes de borrar datos locales.

## Aceptación antes de vender

En la cuenta de prueba propia verifica alta de cliente, Checkout, webhook firmado, renovación, fallo, acción requerida, cancelación, eventos duplicados/desordenados, portal, devolución/disputa y eliminación. Las pruebas unitarias con respuestas sintéticas no prueban aceptación del proveedor. Verifica el webhook real recibido, no solo una redirección de Checkout.

Completa verificación legal/fiscal, marca pública, soporte y cuenta bancaria desde el Dashboard. No inventes datos ni copies automáticamente los bancarios de otra marca. Copia el producto de prueba a la cuenta activa y sustituye IDs/claves para ese modo; nunca mezcles objetos de sandbox y modo real.

Referencias: [cuentas independientes](https://docs.stripe.com/get-started/account/multiple-accounts), [Checkout suscripciones](https://docs.stripe.com/payments/checkout/build-subscriptions), [webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).
