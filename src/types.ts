/** OneBot v11 最小类型集：只覆盖本项目实际用到的部分，其余宽松兜底。 */

export interface TextSegment {
  type: 'text';
  data: { text: string };
}
export interface AtSegment {
  type: 'at';
  data: { qq: string | number };
}
export interface ImageSegment {
  type: 'image';
  data: { file: string; url?: string; sub_type?: number };
}
export interface RecordSegment {
  type: 'record';
  data: { file: string; url?: string };
}
export interface ReplySegment {
  type: 'reply';
  data: { id: string | number };
}
export interface FaceSegment {
  type: 'face';
  data: { id: string | number };
}

export type KnownSegment =
  | TextSegment
  | AtSegment
  | ImageSegment
  | RecordSegment
  | ReplySegment
  | FaceSegment;

/** 未列出的 18 种消息段统一走宽松分支。 */
export type MessageSegment = KnownSegment | { type: string; data: Record<string, any> };

export interface MessageSender {
  user_id: number;
  nickname?: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface MessageEvent {
  post_type: 'message';
  message_type: 'group' | 'private';
  sub_type?: string;
  self_id: number;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: MessageSegment[];
  raw_message: string;
  time: number;
  sender: MessageSender;
}

export interface MetaEvent {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  self_id: number;
  time: number;
  status?: Record<string, unknown>;
  interval?: number;
}

export type OneBotEvent = MessageEvent | MetaEvent | { post_type: string; [key: string]: any };

export interface ActionResponse<T = any> {
  status: 'ok' | 'failed';
  retcode: number;
  data?: T;
  msg?: string;
  wording?: string;
  echo?: number | string;
}

/** 发送用：把消息段转成可读文本，供入库 / 上下文 / 日志使用。 */
export function segmentsToText(segments: MessageSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text':
          return String(seg.data?.text ?? '');
        case 'at':
          return seg.data?.qq === 'all' ? '@全体成员' : `@${seg.data?.qq ?? ''}`;
        case 'image':
          return '[图片]';
        case 'record':
          return '[语音]';
        case 'face':
          return '[表情]';
        case 'reply':
          return '';
        case 'file':
          return '[文件]';
        case 'video':
          return '[视频]';
        case 'mface':
          return '[表情]';
        default:
          return `[${seg.type}]`;
      }
    })
    .join('')
    .trim();
}

export function isMessageEvent(evt: OneBotEvent): evt is MessageEvent {
  return evt.post_type === 'message' && Array.isArray((evt as MessageEvent).message);
}
