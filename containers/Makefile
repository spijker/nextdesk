# Build LWP container images.
#
# Usage:
#   make all           — build everything
#   make base          — build only lwp-kasm-base (legacy KasmVNC — vpn)
#   make selkies-base  — build only lwp-selkies-base (everything else desktop-y)
#   make vivaldi       — build selkies-base + vivaldi
#
# kasm-base (KasmVNC) is being phased out in favor of selkies-base
# (LinuxServer.io's Selkies base — better audio sync, same LWP sidecars
# ported as s6 custom-services.d). vpn stays on kasm-base for now — it's the
# network gateway, higher blast radius than a desktop app.

REGISTRY   ?=
TAG        ?= latest

_pfx = $(if $(REGISTRY),$(REGISTRY)/,)

.PHONY: all base selkies-base web-base vivaldi firefox thunderbird libreoffice terminator terminal kiosk sshpilot vscodium filezilla headlamp remmina ferdium htop jupyterlab pgweb opencode vpn push

all: base selkies-base vivaldi firefox thunderbird libreoffice terminator terminal kiosk sshpilot vscodium filezilla headlamp remmina ferdium htop jupyterlab pgweb opencode vpn

base:
	docker build -t $(_pfx)lwp-kasm-base:$(TAG) kasm-base/

selkies-base:
	docker build -t $(_pfx)lwp-selkies-base:$(TAG) selkies-base/

web-base:
	docker build -t $(_pfx)lwp-web-base:$(TAG) web-base/

vivaldi: selkies-base
	docker build -t $(_pfx)lwp-vivaldi:$(TAG) vivaldi/

firefox: selkies-base
	docker build -t $(_pfx)lwp-firefox:$(TAG) firefox/

thunderbird: selkies-base
	docker build -t $(_pfx)lwp-thunderbird:$(TAG) thunderbird/

libreoffice: selkies-base
	docker build -t $(_pfx)lwp-libreoffice:$(TAG) libreoffice/

terminator: selkies-base
	docker build -t $(_pfx)lwp-terminator:$(TAG) terminator/

terminal:
	docker build -t $(_pfx)lwp-terminal:$(TAG) terminal/

kiosk: selkies-base
	docker build -t $(_pfx)lwp-kiosk:$(TAG) kiosk/

sshpilot: selkies-base
	docker build -t $(_pfx)lwp-sshpilot:$(TAG) sshpilot/

vscodium: selkies-base
	docker build -t $(_pfx)lwp-vscodium:$(TAG) vscodium/

filezilla: selkies-base
	docker build -t $(_pfx)lwp-filezilla:$(TAG) filezilla/

headlamp: selkies-base
	docker build -t $(_pfx)lwp-headlamp:$(TAG) headlamp/

remmina: selkies-base
	docker build -t $(_pfx)lwp-remmina:$(TAG) remmina/

ferdium: selkies-base
	docker build -t $(_pfx)lwp-ferdium:$(TAG) ferdium/

htop: terminal
	docker build -t $(_pfx)lwp-htop:$(TAG) htop/

jupyterlab: web-base
	docker build -t $(_pfx)lwp-jupyterlab:$(TAG) jupyterlab/

pgweb: web-base
	docker build -t $(_pfx)lwp-pgweb:$(TAG) pgweb/

opencode: selkies-base
	docker build -t $(_pfx)lwp-opencode:$(TAG) opencode/

vpn: base
	docker build -t $(_pfx)lwp-vpn:$(TAG) vpn/

push:
	docker push $(_pfx)lwp-kasm-base:$(TAG)
	docker push $(_pfx)lwp-selkies-base:$(TAG)
	docker push $(_pfx)lwp-vivaldi:$(TAG)
	docker push $(_pfx)lwp-firefox:$(TAG)
	docker push $(_pfx)lwp-thunderbird:$(TAG)
	docker push $(_pfx)lwp-libreoffice:$(TAG)
	docker push $(_pfx)lwp-terminator:$(TAG)
	docker push $(_pfx)lwp-terminal:$(TAG)
	docker push $(_pfx)lwp-kiosk:$(TAG)
	docker push $(_pfx)lwp-sshpilot:$(TAG)
	docker push $(_pfx)lwp-vscodium:$(TAG)
	docker push $(_pfx)lwp-filezilla:$(TAG)
	docker push $(_pfx)lwp-headlamp:$(TAG)
	docker push $(_pfx)lwp-remmina:$(TAG)
	docker push $(_pfx)lwp-ferdium:$(TAG)
	docker push $(_pfx)lwp-htop:$(TAG)
	docker push $(_pfx)lwp-jupyterlab:$(TAG)
	docker push $(_pfx)lwp-pgweb:$(TAG)
	docker push $(_pfx)lwp-opencode:$(TAG)
	docker push $(_pfx)lwp-vpn:$(TAG)
