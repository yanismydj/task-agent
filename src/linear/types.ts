export interface TicketInfo {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: {
    id: string;
    name: string;
    type: string;
  };
  assignee: {
    id: string;
    name: string;
  } | null;
  labels: Array<{
    id: string;
    name: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
  url: string;
}

export interface TicketComment {
  id: string;
  body: string;
  createdAt: Date;
  user: {
    id: string;
    name: string;
    isMe: boolean;
  } | null;
}

export interface TicketUpdate {
  stateId?: string;
  assigneeId?: string;
  labelIds?: string[];
}
