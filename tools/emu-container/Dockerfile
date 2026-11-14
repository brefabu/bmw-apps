# Live emulator (kit/tools/emu.js) in a Linux container: emu.js talks to the app over a Unix socket, which
# Node on Windows cannot listen on. The repository is mounted read-only at /work and mirrored into /app
# (entrypoint.sh), so a save rebuilds the app.
# Usage (repository root): docker compose up --build   ->  http://localhost:8077
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 socat rsync \
 && rm -rf /var/lib/apt/lists/*

COPY python3-shim.sh /usr/local/bin/python3
COPY entrypoint.sh /usr/local/bin/bre-emu
# (a Windows checkout may carry CRLF line endings: sh would not run them)
RUN sed -i 's/\r$//' /usr/local/bin/python3 /usr/local/bin/bre-emu \
 && chmod +x /usr/local/bin/python3 /usr/local/bin/bre-emu

ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
EXPOSE 8078
ENTRYPOINT ["bre-emu"]
CMD ["bre_hub"]
