#!/usr/bin/env python3
# Desktop GUI for the VPN gateway — GTK4 + libadwaita, run inside the
# session's KasmVNC desktop (see containers/kasm-base/xstartup) the same way
# every other GUI app in this repo runs (Firefox, SSHPilot, …). Replaces the
# old ttyd/tmux/whiptail terminal login.
#
# Spawns openconnect directly, feeds it credentials over stdin, and streams
# its output into a collapsible log panel. On tunnel-up, lwp-vpn-up.sh (the
# openconnect --script-tun handler) POSTs to the backend and drops a sentinel
# file that this process polls for, then execs ocproxy to serve SOCKS5 on
# :1080. On disconnect this process itself POSTs the "down" state.
#
# Defaults come from the app's env_json (admin-configurable):
#   LWP_VPN_SERVER    portal/gateway hostname
#   LWP_VPN_USER      username preset
#   LWP_VPN_PROTOCOL  openconnect protocol (default: gp)
import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

import json
import os
import signal
import subprocess
import threading
import time
import urllib.request

# argv[0] is "python3" otherwise, which would give every python3-gi app in the
# fleet the same WM_CLASS. Openbox (containers/vpn/openbox.xml) matches on
# "lwp-vpn" to center this window instead of maximizing it like every other
# (fullscreen) app image.
GLib.set_prgname("lwp-vpn")

BACKEND_URL = os.environ.get("LWP_BACKEND_URL", "http://backend:8000")
SESSION_TOKEN = os.environ.get("LWP_SESSION_TOKEN", "")
CONNECTED_MARKER = "/tmp/.lwp-vpn-connected"
VPN_UP_SCRIPT = "/usr/local/bin/lwp-vpn-up.sh"

PROTOCOLS = [
    ("GlobalProtect", "gp"),
    ("Cisco AnyConnect", "anyconnect"),
    ("Pulse Connect Secure", "pulse"),
    ("F5 BIG-IP APM", "f5"),
    ("Fortinet FortiGate", "fortinet"),
    ("Juniper Network Connect", "nc"),
    ("Array Networks", "array"),
]


def post_state(connected: bool) -> None:
    try:
        req = urllib.request.Request(
            f"{BACKEND_URL}/api/sessions/vpn/state",
            data=json.dumps({"connected": connected}).encode(),
            headers={
                "Content-Type": "application/json",
                "X-Session-Token": SESSION_TOKEN,
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5).close()
    except Exception:
        pass


class VpnWindow(Adw.ApplicationWindow):
    def __init__(self, app: Adw.Application) -> None:
        super().__init__(application=app, title="VPN Gateway")
        self.set_default_size(440, 640)
        self.proc: subprocess.Popen | None = None
        self.connected = False
        self._force_close = False
        self._build_ui()
        self.connect("close-request", self._on_close_request)
        post_state(False)

    # ── UI ────────────────────────────────────────────────────────────────
    def _build_ui(self) -> None:
        toolbar = Adw.ToolbarView()

        header = Adw.HeaderBar()
        self.title_widget = Adw.WindowTitle(title="VPN Gateway", subtitle="Disconnected")
        header.set_title_widget(self.title_widget)
        toolbar.add_top_bar(header)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        outer.set_margin_top(24)
        outer.set_margin_bottom(24)
        outer.set_margin_start(18)
        outer.set_margin_end(18)

        clamp = Adw.Clamp(maximum_size=420)
        clamp.set_child(outer)
        scroller = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        scroller.set_child(clamp)
        toolbar.set_content(scroller)

        # Status
        status_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, halign=Gtk.Align.CENTER)
        self.status_icon = Gtk.Image.new_from_icon_name("network-vpn-disabled-symbolic")
        self.status_icon.set_pixel_size(48)
        self.status_icon.add_css_class("dim-label")
        self.status_label = Gtk.Label(label="Disconnected")
        self.status_label.add_css_class("title-2")
        status_box.append(self.status_icon)
        status_box.append(self.status_label)
        outer.append(status_box)

        # Connection form
        group = Adw.PreferencesGroup(title="Connection")

        self.server_row = Adw.EntryRow(title="Portal / gateway host")
        self.server_row.set_text(os.environ.get("LWP_VPN_SERVER", ""))
        group.add(self.server_row)

        self.user_row = Adw.EntryRow(title="Username")
        self.user_row.set_text(os.environ.get("LWP_VPN_USER", ""))
        group.add(self.user_row)

        self.pass_row = Adw.PasswordEntryRow(title="Password")
        group.add(self.pass_row)

        self.otp_row = Adw.PasswordEntryRow(title="One-time code (if required)")
        group.add(self.otp_row)

        self.proto_row = Adw.ComboRow(title="Protocol")
        self.proto_row.set_model(Gtk.StringList.new([label for label, _ in PROTOCOLS]))
        default_proto = os.environ.get("LWP_VPN_PROTOCOL", "gp")
        default_idx = next((i for i, (_, slug) in enumerate(PROTOCOLS) if slug == default_proto), 0)
        self.proto_row.set_selected(default_idx)
        group.add(self.proto_row)

        outer.append(group)

        self.connect_btn = Gtk.Button(label="Connect")
        self.connect_btn.add_css_class("suggested-action")
        self.connect_btn.add_css_class("pill")
        self.connect_btn.set_size_request(-1, 44)
        self.connect_btn.connect("clicked", self._on_connect_clicked)
        outer.append(self.connect_btn)

        banner = Adw.Banner(
            title="Other sessions reach the tunnel at socks5h://vpn:1080 — "
            "toggle the shield on each app window to route it through.",
        )
        banner.set_revealed(True)
        outer.append(banner)

        # Collapsible log
        log_group = Adw.PreferencesGroup()
        self.log_expander = Adw.ExpanderRow(title="Connection log", subtitle="TCP only — no VPN credentials are stored")
        log_scroller = Gtk.ScrolledWindow(min_content_height=160, vexpand=False)
        self.log_buffer = Gtk.TextBuffer()
        log_view = Gtk.TextView(buffer=self.log_buffer, editable=False, monospace=True, cursor_visible=False)
        log_view.set_top_margin(8)
        log_view.set_bottom_margin(8)
        log_view.set_left_margin(8)
        log_view.set_right_margin(8)
        log_scroller.set_child(log_view)
        log_row = Gtk.ListBoxRow(selectable=False, activatable=False)
        log_row.set_child(log_scroller)
        self.log_expander.add_row(log_row)
        log_group.add(self.log_expander)
        outer.append(log_group)

        self.toast_overlay = Adw.ToastOverlay()
        self.toast_overlay.set_child(toolbar)
        self.set_content(self.toast_overlay)

    def _toast(self, message: str) -> bool:
        self.toast_overlay.add_toast(Adw.Toast.new(message))
        return False

    # ── Status / form helpers ───────────────────────────────────────────────
    def _set_status(self, connected: bool, connecting: bool = False) -> bool:
        self.connected = connected
        self.status_icon.remove_css_class("success")
        self.status_icon.remove_css_class("dim-label")
        if connecting:
            self.status_label.set_label("Connecting…")
            self.status_icon.set_from_icon_name("network-vpn-acquiring-symbolic")
            self.status_icon.add_css_class("dim-label")
            self.title_widget.set_subtitle("Connecting…")
        elif connected:
            self.status_label.set_label("Connected")
            self.status_icon.set_from_icon_name("network-vpn-symbolic")
            self.status_icon.add_css_class("success")
            self.title_widget.set_subtitle("Connected")
            self.connect_btn.set_label("Disconnect")
            self.connect_btn.remove_css_class("suggested-action")
            self.connect_btn.add_css_class("destructive-action")
        else:
            self.status_label.set_label("Disconnected")
            self.status_icon.set_from_icon_name("network-vpn-disabled-symbolic")
            self.status_icon.add_css_class("dim-label")
            self.title_widget.set_subtitle("Disconnected")
            self.connect_btn.set_label("Connect")
            self.connect_btn.remove_css_class("destructive-action")
            self.connect_btn.add_css_class("suggested-action")
        return False

    def _set_form_sensitive(self, sensitive: bool) -> bool:
        for widget in (self.server_row, self.user_row, self.pass_row, self.otp_row, self.proto_row):
            widget.set_sensitive(sensitive)
        return False

    def _append_log(self, text: str) -> bool:
        self.log_buffer.insert(self.log_buffer.get_end_iter(), text)
        return False

    # ── Connect / disconnect ────────────────────────────────────────────────
    def _on_connect_clicked(self, _btn: Gtk.Button) -> None:
        if self.connected or self.proc is not None:
            self._disconnect()
            return

        server = self.server_row.get_text().strip()
        user = self.user_row.get_text().strip()
        if not server or not user:
            self._toast("Portal host and username are required")
            return
        password = self.pass_row.get_text()
        otp = self.otp_row.get_text()
        proto = PROTOCOLS[self.proto_row.get_selected()][1]

        self.log_buffer.set_text("")
        self.log_expander.set_expanded(True)
        self._set_form_sensitive(False)
        self.connect_btn.set_sensitive(False)
        self._set_status(False, connecting=True)

        threading.Thread(
            target=self._run_openconnect, args=(server, user, password, otp, proto), daemon=True
        ).start()

    def _disconnect(self) -> None:
        self.connect_btn.set_sensitive(False)
        if self.proc is not None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except Exception:
                pass

    def _run_openconnect(self, server: str, user: str, password: str, otp: str, proto: str) -> None:
        try:
            os.remove(CONNECTED_MARKER)
        except OSError:
            pass

        cmd = [
            "openconnect",
            f"--protocol={proto}",
            f"--user={user}",
            server,
            "--script-tun",
            "--script",
            VPN_UP_SCRIPT,
        ]
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                start_new_session=True,
            )
        except Exception as exc:
            GLib.idle_add(self._append_log, f"Failed to start openconnect: {exc}\n")
            GLib.idle_add(self._connection_ended)
            return

        self.proc = proc

        # openconnect reads its auth-form answers from stdin when stdin isn't
        # a TTY: password, then OTP, one per line.
        stdin_data = password + "\n" + (otp + "\n" if otp else "")
        try:
            proc.stdin.write(stdin_data)
            proc.stdin.close()
        except Exception:
            pass
        password = otp = stdin_data = None  # drop secrets

        threading.Thread(target=self._watch_marker, args=(proc,), daemon=True).start()

        for line in proc.stdout:
            GLib.idle_add(self._append_log, line)
        proc.wait()

        try:
            os.remove(CONNECTED_MARKER)
        except OSError:
            pass
        post_state(False)
        self.proc = None
        GLib.idle_add(self._connection_ended)

    def _watch_marker(self, proc: subprocess.Popen) -> None:
        # Polls for the sentinel lwp-vpn-up.sh drops once the tunnel is up
        # (it also POSTs the "connected" state to the backend directly).
        for _ in range(150):  # ~30s
            if proc.poll() is not None:
                return
            if os.path.exists(CONNECTED_MARKER):
                GLib.idle_add(self._set_status, True, False)
                GLib.idle_add(self.connect_btn.set_sensitive, True)
                return
            time.sleep(0.2)

    def _connection_ended(self) -> bool:
        self._set_form_sensitive(True)
        self._set_status(False)
        self.connect_btn.set_sensitive(True)
        return False

    # ── Window close ─────────────────────────────────────────────────────
    def _on_close_request(self, *_args) -> bool:
        if self._force_close:
            return False
        if self.connected or self.proc is not None:
            dialog = Adw.AlertDialog(
                heading="Disconnect VPN?",
                body="Closing this window disconnects the tunnel and ends the gateway session.",
            )
            dialog.add_response("cancel", "Cancel")
            dialog.add_response("disconnect", "Disconnect")
            dialog.set_response_appearance("disconnect", Adw.ResponseAppearance.DESTRUCTIVE)
            dialog.connect("response", self._on_close_confirmed)
            dialog.present(self)
            return True
        return False

    def _on_close_confirmed(self, _dialog: Adw.AlertDialog, response: str) -> None:
        if response != "disconnect":
            return
        if self.proc is not None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except Exception:
                pass
        self._force_close = True
        self.close()


class VpnApp(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id="nl.lwp.VpnGateway", flags=Gio.ApplicationFlags.DEFAULT_FLAGS)

    def do_activate(self) -> None:
        win = self.props.active_window or VpnWindow(self)
        win.present()


if __name__ == "__main__":
    VpnApp().run(None)
