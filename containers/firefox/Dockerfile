FROM lwp-selkies-base

# Install Firefox directly from Mozilla — avoids APT repo GPG issues.
# The download URL redirects to the latest stable release tarball.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libdbus-glib-1-2 libxt6 xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fL "https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64&lang=en-US" \
        -o /tmp/firefox.tar.xz \
    && tar -xf /tmp/firefox.tar.xz -C /opt/ \
    && ln -s /opt/firefox/firefox /usr/local/bin/firefox \
    && rm /tmp/firefox.tar.xz \
    # distribution/ is writable by the session user so the start wrapper can
    # drop a proxy policy when the session runs behind the VPN gateway
    && mkdir -p /opt/firefox/distribution \
    && chown 1000:1000 /opt/firefox/distribution

COPY lwp-firefox-start.sh /usr/local/bin/lwp-firefox-start.sh
RUN chmod +x /usr/local/bin/lwp-firefox-start.sh

ENV MOZ_DISABLE_RDD_SANDBOX=1
ENV LWP_START_APP="/usr/local/bin/lwp-firefox-start.sh"
ENV LWP_OPEN_CMD="firefox"
