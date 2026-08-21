FROM alpine:3.20
RUN apk add --no-cache socat
RUN printf '#!/bin/sh\necho WALGIT-SPIKE-OK\ncat\n' > /srv.sh && chmod +x /srv.sh
CMD ["socat","TCP-LISTEN:2222,fork,reuseaddr","EXEC:/srv.sh"]
