# Build LWP container images.
#
# Usage:
#   make all          — build everything
#   make base         — build only lwp-kasm-base
#   make vivaldi      — build base + vivaldi

REGISTRY   ?=
TAG        ?= latest

_pfx = $(if $(REGISTRY),$(REGISTRY)/,)

.PHONY: all base web-base vivaldi firefox thunderbird libreoffice terminator terminal kiosk sshpilot vscodium filezilla headlamp remmina ferdium htop jupyterlab pgweb opencode flatpak vpn push

all: base vivaldi firefox thunderbird libreoffice terminator terminal kiosk sshpilot vscodium filezilla headlamp remmina ferdium htop jupyterlab pgweb opencode flatpak vpn

base:
	docker build -t $(_pfx)lwp-kasm-base:$(TAG) kasm-base/

web-base:
	docker build -t $(_pfx)lwp-web-base:$(TAG) web-base/

vivaldi: base
	docker build -t $(_pfx)lwp-vivaldi:$(TAG) vivaldi/

firefox: base
	docker build -t $(_pfx)lwp-firefox:$(TAG) firefox/

thunderbird: base
	docker build -t $(_pfx)lwp-thunderbird:$(TAG) thunderbird/

libreoffice: base
	docker build -t $(_pfx)lwp-libreoffice:$(TAG) libreoffice/

terminator: base
	docker build -t $(_pfx)lwp-terminator:$(TAG) terminator/

terminal:
	docker build -t $(_pfx)lwp-terminal:$(TAG) terminal/

kiosk: base
	docker build -t $(_pfx)lwp-kiosk:$(TAG) kiosk/

sshpilot: base
	docker build -t $(_pfx)lwp-sshpilot:$(TAG) sshpilot/

vscodium: base
	docker build -t $(_pfx)lwp-vscodium:$(TAG) vscodium/

filezilla: base
	docker build -t $(_pfx)lwp-filezilla:$(TAG) filezilla/

headlamp: base
	docker build -t $(_pfx)lwp-headlamp:$(TAG) headlamp/

remmina: base
	docker build -t $(_pfx)lwp-remmina:$(TAG) remmina/

ferdium: base
	docker build -t $(_pfx)lwp-ferdium:$(TAG) ferdium/

htop: terminal
	docker build -t $(_pfx)lwp-htop:$(TAG) htop/

jupyterlab: web-base
	docker build -t $(_pfx)lwp-jupyterlab:$(TAG) jupyterlab/

pgweb: web-base
	docker build -t $(_pfx)lwp-pgweb:$(TAG) pgweb/

opencode: base
	docker build -t $(_pfx)lwp-opencode:$(TAG) opencode/

flatpak: base
	docker build -t $(_pfx)lwp-flatpak:$(TAG) flatpak/

vpn:
	docker build -t $(_pfx)lwp-vpn:$(TAG) vpn/

push:
	docker push $(_pfx)lwp-kasm-base:$(TAG)
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
	docker push $(_pfx)lwp-flatpak:$(TAG)
	docker push $(_pfx)lwp-vpn:$(TAG)
