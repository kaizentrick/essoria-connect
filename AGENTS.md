# Essoria development

- Node 24+, TypeScript, one persistent WhatsApp writer per local SQLite database.
- Never commit credentials, account data, QR payloads, recovery archives or real conversations. Runtime keys belong in private files or the deployment's credential manager.
- Keep account isolation, permission-filtered discovery, idempotent sending and uncertain-result protection intact. The default agent key is read-only. Standard MCP remains available alongside optional Code Mode.
- QR linking uses an unofficial linked-device transport. Do not describe it as official Meta coexistence or imply that a connected socket proves history completeness or message delivery.
- Registration and commercial charging are closed by default. A ready UI, synthetic tests and a fresh QR do not establish real-phone or payment-provider acceptance.
- Preserve original logos and honest availability labels. Use the editable HyperFrames compositions in public/motion; run their checks when changing motion, and support reduced motion.
- Run npm test, npm run check and npm run audit:runtime for backend changes. Keep tests behavioral. Preserve persistent data and verify recovery before changing a running installation.
- This source is self-hosted. Do not provision cloud infrastructure or start paid third-party services without the installation owner's request.
