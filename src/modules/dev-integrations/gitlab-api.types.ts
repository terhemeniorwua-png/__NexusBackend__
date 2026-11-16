export interface GitLabTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  created_at?: number;
}

export interface GitLabUser {
  id?: number;
  username?: string;
  name?: string;
  email?: string;
  avatar_url?: string;
  web_url?: string;
  bot?: boolean;
}
