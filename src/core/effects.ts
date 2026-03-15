export interface ReplyTarget {
  channel: string;
  id: string;
}

export type AppEffect = {
  type: "send-text";
  target: ReplyTarget;
  text: string;
};
