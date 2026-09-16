FROM lwp-selkies-base

# Ubuntu 24.04 ships `thunderbird` only as a snap transitional package (pulls
# snapd; can't run in a container). Install the real build straight from
# Mozilla's tarball instead — same approach as firefox/.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libdbus-glib-1-2 libxt6 xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fL "https://download.mozilla.org/?product=thunderbird-latest-ssl&os=linux64&lang=en-US" \
        -o /tmp/thunderbird.tar.xz \
    && tar -xf /tmp/thunderbird.tar.xz -C /opt/ \
    && ln -s /opt/thunderbird/thunderbird /usr/local/bin/thunderbird \
    && rm /tmp/thunderbird.tar.xz

ENV MOZ_DISABLE_RDD_SANDBOX=1
ENV LWP_START_APP="thunderbird --new-instance"
