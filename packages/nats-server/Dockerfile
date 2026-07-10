# zbc-nats container: nats-server with WebSocket enabled, run as a
# Durable-Object-bound Cloudflare Container. The Worker (worker/index.ts) proxies
# wss traffic to port 8080. Mirrors the old Fly machine config (renderConf): ws
# on 8080, http monitoring on 8222, authorization user `app` / $NATS_PASSWORD.
FROM nats:latest

COPY nats-server.conf /etc/nats/nats-server.conf

# ws (client), 8222 (http monitoring / healthz).
EXPOSE 8080 8222

# The nats image ENTRYPOINT is `nats-server`; pass our config as args.
CMD ["-c", "/etc/nats/nats-server.conf"]
