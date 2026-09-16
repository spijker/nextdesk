FROM lwp-selkies-base

# Firefox from Mozilla (no snap, no Chrome sandbox issues)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libdbus-glib-1-2 libxt6 xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fL "https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64&lang=en-US" \
        -o /tmp/firefox.tar.xz \
    && tar -xf /tmp/firefox.tar.xz -C /opt/ \
    && ln -s /opt/firefox/firefox /usr/local/bin/firefox \
    && rm /tmp/firefox.tar.xz

# web-type sessions have no persistent home (mount_home=false, ephemeral
# profile every launch) — a per-user prefs.js tweak would never survive to
# the next launch anyway. Baking the policy into the image is what actually
# suppresses "Welcome to Firefox" every single time, regardless of storage.
RUN mkdir -p /opt/firefox/distribution
COPY policies.json /opt/firefox/distribution/policies.json

ENV MOZ_DISABLE_RDD_SANDBOX=1

COPY start.sh /usr/local/bin/lwp-kiosk-start.sh
RUN chmod +x /usr/local/bin/lwp-kiosk-start.sh

ENV LWP_START_APP="/usr/local/bin/lwp-kiosk-start.sh"
