export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: { id: number };
  chat: { id: number; type: string };
  photo?: Array<{ file_id: string; file_size?: number }>;
}

export interface SessionRequest {
  updateId: number;
  message: TelegramMessage;
}
