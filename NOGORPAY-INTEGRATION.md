# NogorPay integration notes

The NogorPay dashboard integration reference was inspected on 2026-10-21.

- Production base URL: `https://api.nogorpay.com/api/v1`
- Payment methods endpoint: `GET /charge/methods`
- Hosted checkout creation: `POST /charge/create`
- Payment verification: `GET /charge/verify/:invoice_id`
- Authentication header: `NOGORPAY-API-KEY` (server-side only)
- Checkout creation supports `order_id`, `amount`, customer details, `brand_id`, optional `payment_method`, `webhook_url`, `redirect_url`, and `cancel_url`.
- The dashboard provides an API reference and Node/code samples under Integrations.
- The current account’s primary brand ID observed in the dashboard: `8ETVNX`.
- The account’s configured gateway list must be managed in NogorPay; the hosted checkout can present the active methods.

Source: https://dashboard.nogorpay.com/integrations (authenticated dashboard API reference and code samples).
Public product overview: https://nogorpay.com/.

The application reads `NOGORPAY_API_KEY`, `NOGORPAY_BRAND_ID`, `NOGORPAY_API_BASE`, and optional `NOGORPAY_WEBHOOK_URL` from server environment variables. No API secret is stored in this repository.
