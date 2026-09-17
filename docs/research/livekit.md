# LiveKit — primary-source research notes

Researched 2026-07-18 against official sources only: docs.livekit.io, github.com/livekit/*, livekit.com. Third-party write-ups were not used.

## 1. What LiveKit is

- Open-source WebRTC SFU (Selective Forwarding Unit) written in Go, built on the Pion WebRTC library; Apache-2.0 licensed. ([github.com/livekit/livekit](https://github.com/livekit/livekit))
- Server features: speaker detection, simulcast, selective subscription, end-to-end encryption, SVC codecs (VP9, AV1), webhooks and moderation APIs, distributed multi-region deployments. ([github.com/livekit/livekit](https://github.com/livekit/livekit))
- Media model: rooms containing participants who publish/subscribe to tracks; ecosystem components are **Agents** (programmable backend participants), **Egress** (recording/multistreaming), **Ingress** (RTMP/WHIP/HLS/OBS ingest), and **SIP** (telephony). ([github.com/livekit/livekit](https://github.com/livekit/livekit))
- Two ways to run it: self-host the open-source server, or **LiveKit Cloud** (managed, globally distributed). Positioning today leads with AI: "the platform for voice, video, and physical AI agents." ([docs.livekit.io intro](https://docs.livekit.io/home/get-started/intro-to-livekit/))

### SIP / telephony

- Inbound and outbound phone calls are bridged into LiveKit rooms; a "SIP participant" represents the caller/callee. Inbound participants are auto-created; outbound via `CreateSIPParticipant`. ([docs.livekit.io/sip](https://docs.livekit.io/sip/))
- Concepts: inbound/outbound **trunks** (connect a third-party SIP provider), **dispatch rules** (route inbound calls to rooms). Supports DTMF, cold and warm transfer, SRTP, caller ID, Krisp noise cancellation. No video over SIP. ([docs.livekit.io/sip](https://docs.livekit.io/sip/))

## 2. AI story: LiveKit Agents

- Agents framework in **Python and Node.js**; handles streaming audio through an STT-LLM-TTS pipeline, "reliable turn detection, handling interruptions, and LLM orchestration," with plugins for major AI providers plus "LiveKit Inference" (LiveKit-hosted model access). ([docs.livekit.io/agents](https://docs.livekit.io/agents/))
- **Two model architectures**: the cascaded STT→LLM→TTS pipeline, or **realtime speech-to-speech models** that "consume and produce speech directly, bypassing the need for a voice pipeline." Realtime providers listed: OpenAI Realtime API, Gemini Live, Amazon Nova Sonic, Azure OpenAI Realtime, NVIDIA PersonaPlex, Phonic, Ultravox, xAI Grok Voice (some Python-only). Documented realtime trade-offs: delayed transcripts, can't script exact speech, text-only history loading. ([docs.livekit.io/agents/models/realtime](https://docs.livekit.io/agents/models/realtime/))
- **Turn detection**: custom LiveKit turn-detector model (audio + text, layered on VAD with phrase-endpointing heuristics) is the default in `AgentSession`; Silero VAD is the base signal; realtime providers' server-side VAD can be used instead. Fixed (`min_delay`/`max_delay`) or dynamic endpointing (Python only); interruption handling has "adaptive" mode (distinguishes interruptions from backchanneling) and VAD mode. ([docs.livekit.io/agents/build/turns](https://docs.livekit.io/agents/build/turns/))
- **Tool calling**: "Define tools that are compatible with any LLM, and even forward tool calls to your frontend." ([docs.livekit.io/agents](https://docs.livekit.io/agents/))
- **Worker/job model**: you run an "agent server" process that registers with the LiveKit server and "waits until it receives a dispatch request," then boots a **job subprocess** that joins the room; the model provides automatic load balancing and graceful shutdown. Dispatch is automatic or explicit (a token can carry agent-dispatch info). ([docs.livekit.io/agents](https://docs.livekit.io/agents/), [worker docs](https://docs.livekit.io/agents/worker/))
- **Deployment**: agents deploy as **containers** either to LiveKit Cloud ("run them on LiveKit's global network," automatic scaling/load balancing, logs/secrets/observability) or self-hosted "any custom environment," Kubernetes-compatible. ([docs.livekit.io/agents/ops/deployment](https://docs.livekit.io/agents/ops/deployment/))

## 3. SDKs and auth model

- **Client SDKs**: JavaScript, Swift, Kotlin, Flutter, React Native, Rust. **Server SDKs**: Go, Node.js, Ruby, Python, Java/Kotlin. ([github.com/livekit/livekit](https://github.com/livekit/livekit))
- **Auth**: API key/secret pair; access tokens are "JWT-based and signed with your API secret to prevent forgery" (shared-secret HMAC; the JS server SDK v2 signs via the `jose` library, async `toJwt()`). Tokens must be minted server-side: "generating a token requires API keys so it must be created on a backend server." ([docs.livekit.io/home/server/generating-tokens](https://docs.livekit.io/home/server/generating-tokens/), [node-sdks README](https://github.com/livekit/node-sdks/tree/main/packages/livekit-server-sdk), [docs auth overview](https://docs.livekit.io/home/get-started/authentication/))
- **Token shape** (compare to this repo's NATS JWTs): standard claims `iss` (= API key), `sub` (= participant identity), `exp`, `nbf`, plus `metadata`, `attributes` (string k/v), and a `video` grant object: `room`, `roomJoin`, `roomCreate`, `roomList`, `roomAdmin`, `roomRecord` (Egress), `ingressAdmin`, `canPublish`, `canSubscribe`, `canPublishData`, `canPublishSources`, `hidden`, `kind` (standard/ingress/egress/sip/agent/connector), `destinationRoom`, `canUpdateOwnMetadata`. Tokens can also embed a `RoomConfiguration` including agent dispatch (applied at room creation). ([docs.livekit.io/home/server/generating-tokens](https://docs.livekit.io/home/server/generating-tokens/))
- Token-minting options: your own backend endpoint, LiveKit Cloud's token server (dev/testing), or manual generation. ([docs auth overview](https://docs.livekit.io/home/get-started/authentication/))

## 4. Pricing (LiveKit Cloud) vs self-hosting

From [livekit.com/pricing](https://livekit.com/pricing) (2026-07):

| Tier | Price | Agent minutes incl. | Concurrent agent sessions | Data transfer incl. |
|---|---|---|---|---|
| Build | $0/mo | 1,000 | 5 | 50 GB |
| Ship | $50/mo | 5,000 | 20 | 250 GB ($0.12/GB over) |
| Scale | $500/mo | 50,000 | 600+ | 3 TB ($0.10/GB over) |
| Enterprise | custom | custom | custom | custom |

- Overage: agent session $0.01/min; telephony (US local) $0.01/min; observability $0.01/min. LiveKit Inference: STT $0.0025–$0.0117/min, TTS $0.009–$0.18/min, LLM $0.0002–$0.0676/min (model-dependent); inference credits included per tier ($2.50/$5/$50). Phone numbers: 1 free US local, then $1/mo; toll-free $2/mo. ([livekit.com/pricing](https://livekit.com/pricing))
- **Self-hosting** ([deployment docs](https://docs.livekit.io/home/self-hosting/deployment/)): single Go binary / Docker (host networking recommended) / Kubernetes. Ports: 7880 (WebSocket signal), 7881 (TCP fallback), UDP 50000–60000 (configurable), TURN/TLS 5349 or 443, TURN/UDP 443. Redis "recommended for production" and required for distributed multi-node. "Scalability of LiveKit is bound by CPU and bandwidth"; compute-optimized instances, 10 Gbps+ NICs recommended. Embedded TURN server for firewall traversal.

## 5. First-party positioning

- "An open source framework and developer platform for building, testing, deploying, scaling, and observing agents in production." ([livekit.com](https://livekit.com/))
- Named references: "OpenAI built ChatGPT's Advanced Voice on LiveKit Cloud, used by millions of users"; also Retell AI, Podium, Assort Health, Skydio, xAI, Nvidia, Salesforce. Compliance: SOC 2 Type 2, GDPR, HIPAA. ([livekit.com](https://livekit.com/))
- Differentiation as stated first-party: code-first flexibility ("use any model provider," deep customization) vs no-code agent builders. The homepage makes **no direct comparisons** to Twilio/Daily/Agora. (Homepage stat counters render as animation placeholders when fetched — the "2.5B+ calls annually" figure appeared; other numbers were unreliable and are omitted.) ([livekit.com](https://livekit.com/))

## 6. Fit with a Cloudflare Workers stack (zbc)

- **Token minting from a Worker: yes, effectively.** The JS server SDK v2 replaced `jsonwebtoken` with `jose` (Web-crypto based; jose explicitly supports Cloudflare Workers) and the README states it "runs in NodeJS, Deno and Bun" and "theoretically now also runs in every major browser" — i.e. no Node-only crypto. Signing is a shared-secret HMAC over a small JWT, so a Worker (with the API secret as a Worker secret, pushed the way zbc already pushes `workerSecrets`) can mint room tokens; this mirrors the per-session NATS JWT pattern already in this repo. ([node-sdks README](https://github.com/livekit/node-sdks/tree/main/packages/livekit-server-sdk))
- **Agents cannot run in workerd.** The agent server is a long-running registered worker that spawns a subprocess per job and holds a WebRTC media connection — it deploys as a container (LiveKit Cloud agent deployment, or your own K8s/VMs). Nothing in the docs offers a serverless/edge agent runtime. ([docs.livekit.io/agents](https://docs.livekit.io/agents/), [deployment](https://docs.livekit.io/agents/ops/deployment/))
- **Media server cannot run on Cloudflare either**: the SFU needs raw UDP port ranges and TURN — not available to Workers/DO. Practical zbc shape: Workers serve the app + mint tokens; LiveKit Cloud (Build tier is $0) or a self-hosted VM runs media + agents. A future `livekit` zbc module would look like the NATS one: provider API token in `secrets.yaml`, worker gets `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` via `workerSecrets`, agent container deployed out-of-band (LiveKit Cloud agent deploy) rather than by the cloudflare module. ([self-hosting](https://docs.livekit.io/home/self-hosting/deployment/), [livekit.com/pricing](https://livekit.com/pricing))
