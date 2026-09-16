export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  auth_source: string;
  preferences: Record<string, unknown>;
  totp_enabled: boolean;
  lock_pin_enabled?: boolean;
  nc_connected?: boolean;
  // DLP/security flags resolved from group policy (server also enforces)
  policies?: {
    record_sessions?: boolean;
    disable_download?: boolean;
    disable_upload?: boolean;
    disable_clipboard?: boolean;
    force_simple_layout?: boolean;
  };
}

export type AppType = "stream" | "web" | "kasm";

export interface App {
  id: string;
  name: string;
  description: string;
  category: string;
  icon_url: string;
  app_type: AppType;
  web_native?: boolean;
  proxy_port: number;
  cpu_limit: string;
  mem_limit: string;
  container_image: string | null;
  web_url: string | null;
  mount_home: boolean;
  env_json?: Record<string, string>;
  is_enabled: boolean;
  is_vpn?: boolean;
  // App may keep running in the background when the user opted in (Terminal)
  bg_allowed?: boolean;
  // Set only for a user's own self-service web app (Profile → My web apps) —
  // that user's id, letting the UI show edit/delete controls just for them.
  created_by?: string | null;
}

export interface Session {
  id: string;
  app_id: string | null;
  session_token: string;
  status: "starting" | "running" | "suspended" | "stopping" | "stopped" | "error";
  app_type: AppType;
  started_at: string;
  connect_url: string;
  app_name?: string | null;
  app_icon?: string;
  window_state: WindowState;
  // null/undefined = launched without VPN plumbing (no toggle);
  // boolean = per-window VPN routing state (shield button)
  vpn_enabled?: boolean | null;
}

export interface WindowState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  minimized?: boolean;
  maximized?: boolean;
}

export interface AdminSession extends Session {
  user_id: string;
  user_email: string | null;
  username: string | null;
  app_name: string | null;
  pod_name: string;
}

export interface StorageConfig {
  id: string;
  name: string;
  provider: "sftp" | "s3" | "webdav" | "gdrive" | "onedrive";
  mount_path: string;
  created_at: string;
}

// Kept for admin pages that still reference old naming
export type Image = App;
