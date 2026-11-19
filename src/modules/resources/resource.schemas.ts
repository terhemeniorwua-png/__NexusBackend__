import { z } from 'zod';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from '../files/file.schemas';

const uuid = z.string().uuid();

export const workspaceScopeParamsSchema = z.object({
  workspaceId: uuid,
});

export const projectScopeParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
});

export const folderParamsSchema = z.object({
  workspaceId: uuid,
  folderId: uuid,
});

export const projectFolderParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  folderId: uuid,
});

export const resourceFileParamsSchema = z.object({
  workspaceId: uuid,
  fileId: uuid,
});

export const projectResourceFileParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  fileId: uuid,
});

export const bookmarkParamsSchema = z.object({
  workspaceId: uuid,
  bookmarkId: uuid,
});

export const projectBookmarkParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  bookmarkId: uuid,
});

export const listFoldersQuerySchema = z
  .object({
    parentId: uuid.nullable().optional(),
    projectId: uuid.optional(),
  })
  .strict();

export const createFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    parentId: uuid.nullable().optional(),
    projectId: uuid.nullable().optional(),
  })
  .strict();

export const renameFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
  })
  .strict();

export const moveFolderSchema = z
  .object({
    parentId: uuid.nullable(),
  })
  .strict();

export const listResourceFilesQuerySchema = z
  .object({
    folderId: uuid.nullable().optional(),
    projectId: uuid.optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const renameResourceFileSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
  })
  .strict();

export const moveResourceFileSchema = z
  .object({
    folderId: uuid.nullable(),
  })
  .strict();

export const bookmarkSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    url: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: 'Only http and https URLs are allowed',
      }),
    projectId: uuid.nullable().optional(),
  })
  .strict();

export const updateBookmarkSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    url: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: 'Only http and https URLs are allowed',
      })
      .optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.url !== undefined, {
    message: 'Provide at least title or url',
  });

export const listBookmarksQuerySchema = z
  .object({
    projectId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const recentItemTypeSchema = z.enum(['TASK', 'DOCUMENT', 'FILE', 'BOOKMARK']);

export const recordRecentSchema = z
  .object({
    itemType: recentItemTypeSchema,
    itemId: uuid,
  })
  .strict();

export const listRecentQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(10).default(10),
  })
  .strict();

export const dashboardPreferenceCardSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    visible: z.boolean(),
    order: z.number().int().min(0).max(1000),
  })
  .strict();

export const dashboardPreferenceSchema = z
  .object({
    cards: z.array(dashboardPreferenceCardSchema).max(100),
  })
  .strict();

export const folderUploadMetaSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            relativePath: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
};

export const RESOURCE_BATCH_MAX_FILES = 200;
export const RESOURCE_BATCH_MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB total batch cap
export const RESOURCE_FOLDER_MAX_DEPTH = 10;
export const RESOURCE_PATH_SEGMENT_MAX_LENGTH = 255;

export type ListFoldersQuery = z.infer<typeof listFoldersQuerySchema>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type RenameFolderInput = z.infer<typeof renameFolderSchema>;
export type MoveFolderInput = z.infer<typeof moveFolderSchema>;
export type ListResourceFilesQuery = z.infer<typeof listResourceFilesQuerySchema>;
export type RenameResourceFileInput = z.infer<typeof renameResourceFileSchema>;
export type MoveResourceFileInput = z.infer<typeof moveResourceFileSchema>;
export type BookmarkInput = z.infer<typeof bookmarkSchema>;
export type UpdateBookmarkInput = z.infer<typeof updateBookmarkSchema>;
export type ListBookmarksQuery = z.infer<typeof listBookmarksQuerySchema>;
export type RecordRecentInput = z.infer<typeof recordRecentSchema>;
export type DashboardPreferenceInput = z.infer<typeof dashboardPreferenceSchema>;
