FROM lwp-selkies-base

# GTK4 + Adwaita + VTE + GtkSourceView + WebKit2 + keyring + SSH CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-gi python3-gi-cairo \
      libgtk-4-1 gir1.2-gtk-4.0 \
      libadwaita-1-0 gir1.2-adw-1 \
      libvte-2.91-gtk4-0 gir1.2-vte-3.91 \
      libgtksourceview-5-0 gir1.2-gtksource-5 \
      libsecret-1-0 gir1.2-secret-1 \
      gnome-keyring \
      python3-cryptography sshpass ssh-askpass \
      openssh-client \
      gir1.2-webkit-6.0 \
    && rm -rf /var/lib/apt/lists/*

# Add SSHPilot PPA and install
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg && \
    curl -fsSL https://mfat.github.io/sshpilot-ppa/pubkey.gpg \
        | gpg --dearmor -o /usr/share/keyrings/sshpilot-ppa.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/sshpilot-ppa.gpg arch=amd64] https://mfat.github.io/sshpilot-ppa any main" \
        > /etc/apt/sources.list.d/sshpilot-ppa.list && \
    apt-get update && apt-get install -y --no-install-recommends sshpilot && \
    rm -rf /var/lib/apt/lists/*

# Wrapper: init gnome-keyring (provides libsecret backend) then launch app
COPY lwp-start-sshpilot.sh /usr/local/bin/lwp-start-sshpilot.sh
RUN chmod +x /usr/local/bin/lwp-start-sshpilot.sh

ENV LWP_START_APP="/usr/local/bin/lwp-start-sshpilot.sh"
