# Primary references checked during implementation

Checked 22 September 2026. Provider schemas, prices, entitlements, and rules can change; recheck before live activation.

- [Alpaca market-data plans](https://docs.alpaca.markets/us/docs/about-market-data-api): individual IEX/basic versus consolidated coverage. Published Algo Trader Plus price $99/month.
- [Alpaca streaming protocol](https://docs.alpaca.markets/us/docs/streaming-market-data): authentication, subscription, reconnect/error handling.
- [Alpaca order lifecycle and brackets](https://docs.alpaca.markets/us/docs/orders-at-alpaca): client IDs, partial fills, protective order behavior.
- [Alpaca client-ID lookup](https://docs.alpaca.markets/us/reference/getorderbyclientorderid) and [nested order lookup](https://docs.alpaca.markets/us/reference/getorderbyorderid-1).
- [Alpaca spot crypto](https://docs.alpaca.markets/us/docs/crypto-trading): asset increments, allowed order types, fees and availability.
- [Alpaca crypto streams](https://docs.alpaca.markets/us/docs/real-time-crypto-pricing-data): venue locations and bar/quote schemas.
- [TypeSafe API](https://docs.typesafe.ai/api): typed Noul, Choice, Score questions and response shapes.
- [TypeSafe models](https://docs.typesafe.ai/models): pinned model, pricing, dynamic service limits. The adapter uses $0.042/million input tokens for estimates; outputs are currently uncharged.
- [Node SQLite](https://nodejs.org/api/sqlite.html): durable embedded database API and experimental status in Node 24.
- [Docker Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/): official package repository bootstrap.
- [GCP IAP TCP forwarding](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding): private administrator access.
- [AWS instance Terraform resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/instance) and [GCP instance Terraform resource](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_instance): cloud template references; provider validation is a separate check.
- [FINRA intraday-margin transition](https://syndication.finra.org/content/understanding-new-intraday-margin-requirements): account-specific rules during the transition.
