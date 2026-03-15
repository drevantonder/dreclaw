export interface GoogleOAuthSettings {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string;
  encryptionKey?: string;
}

export interface GooglePluginDeps {
  db: D1Database;
  settings: GoogleOAuthSettings;
}
