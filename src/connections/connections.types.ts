export interface Connection {
  id: string;
  name: string;
  headline: string | null;
  profile_url: string;
  connected_at: string | null;
  message_sent: boolean;
  created_at: string;
}

export interface SendConnectionParams {
  profileUrl: string;
  message?: string; // max 300 chars, opcional
}

export interface SendMessageParams {
  profileUrl: string;
  message: string;
}
