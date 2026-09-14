from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database
    database_url: str = "postgresql+asyncpg://lwp:lwpdev@localhost:5432/lwp"

    # Redis
    redis_url: str = "redis://localhost:6379"

    # Security
    secret_key: str = "dev-secret-key-change-in-prod"
    access_token_expire_minutes: int = 60
    refresh_token_expire_days: int = 7

    # Auth methods — comma-separated, enables the login options shown to users.
    # Values: oidc, local, ldap  (e.g. "oidc,local" or "ldap" or "oidc,ldap,local")
    auth_methods: str = "oidc"

    # OIDC
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_scopes: str = "openid email profile groups"
    oidc_groups_claim: str = "groups"
    # Label for the SSO button on the login page.
    oidc_button_label: str = "Sign in with your organisation"

    # LDAP
    ldap_host: str = ""
    ldap_port: int = 389
    ldap_bind_dn: str = ""
    ldap_bind_password: str = ""
    ldap_base_dn: str = ""
    ldap_user_filter: str = "(uid={username})"
    ldap_user_attr_email: str = "mail"
    ldap_user_attr_display_name: str = "cn"
    # none | ldaps | starttls
    ldap_tls: str = "none"
    # Attribute holding group membership; set to "memberOf" for AD
    ldap_groups_attr: str = "memberOf"

    # App
    lwp_base_url: str = "http://localhost"
    lwp_env: str = "production"
    # Small text shown under the login card — e.g. product/company branding.
    footer_text: str = "Nextdesk — Powered by VPE © 2026"

    # Docker (dev only) — network session containers join so Nginx can reach them
    docker_network: str = "compose_internal"

    # Internal URL containers use to reach the backend (for self-stop callback)
    backend_internal_url: str = "http://backend:8000"

    # Kiosk image used for web-type apps — Chrome in --app mode, reads START_URL env var
    kiosk_image: str = "lwp-kiosk"

    # Persistent home volumes
    home_storage_class: str = "standard"   # K8s StorageClass for user home PVCs
    home_pvc_size: str = "5Gi"             # per-user PVC size

    # Session defaults
    max_sessions_per_user: int = 2
    session_timeout_hours: int = 8

    # Session recordings (per-group record_sessions policy) land here as
    # uploaded mp4 segments: <recordings_dir>/<session_id>/<seq>.mp4
    recordings_dir: str = "/data/recordings"

    @property
    def is_dev(self) -> bool:
        return self.lwp_env == "development"

    @property
    def enabled_auth_methods(self) -> list[str]:
        return [m.strip() for m in self.auth_methods.split(",") if m.strip()]

    @property
    def oidc_callback_url(self) -> str:
        return f"{self.lwp_base_url}/api/auth/oidc/callback"


settings = Settings()
