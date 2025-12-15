export interface ProjectLead {
  id: string;
  name: string;
  displayName: string;
  url: string;
}

export interface AttachmentInfo {
  id: string;
  title: string | null;
  subtitle: string | null;
  url: string;
  metadata?: Record<string, string | number>;
}

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
  attachments?: AttachmentInfo[];
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

/**
 * Comment info for caching (slightly different from TicketComment)
 */
export interface CommentInfo {
  id: string;
  body: string;
  user?: {
    id: string;
    name: string;
    isBot?: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Response from fileUpload mutation
 * Used to request a pre-signed URL for file upload
 */
export interface FileUploadResponse {
  uploadFile: {
    uploadUrl: string;
    assetUrl: string;
  };
}

/**
 * Response from attachmentCreate mutation
 * Used to create an attachment record after file upload
 */
export interface AttachmentCreateResponse {
  attachmentCreate: {
    success: boolean;
    attachment?: {
      id: string;
      url: string;
    };
  };
}
