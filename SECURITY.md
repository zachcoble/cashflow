# Security

This is a personal portfolio project — a single-user local tool, not a maintained multi-tenant service.

- No real financial data is committed; `cashflow.db` is gitignored.
- The dev server binds to `0.0.0.0:8000` by default. Don't run this on a shared or public-facing network without putting it behind a reverse proxy or changing the bind address.
- If you find a real credential or personal data committed by mistake, please open an issue and I'll remove and rotate it immediately.
