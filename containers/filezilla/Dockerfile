FROM lwp-selkies-base

# FileZilla — cross-platform FTP/SFTP client (Ubuntu universe).
RUN apt-get update && apt-get install -y --no-install-recommends \
      filezilla \
    && rm -rf /var/lib/apt/lists/*

ENV LWP_START_APP="filezilla"
