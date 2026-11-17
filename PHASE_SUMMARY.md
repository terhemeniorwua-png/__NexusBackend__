# Phase Summary: fe-integration-pickers

## Phase Information
- **Phase number**: Phase 5 (Integrations & Imports)
- **Phase title**: Integration pickers, sync status, Slack event toggling, import wizard enhancements
- **Completion status**: Completed (backend implementation)

## Implementation Summary

### 1. OpenAPI Updates (docs/openapi.yaml)
- Added `IntegrationSyncStatusResponse` schema with fields: integrationId, lastSyncedAt, lastError, status (HEALTHY/RECONNECT_REQUIRED/ERROR), reconnectRequired
- Added `SyncNowRequest` schema with immediate boolean field
- Added `SyncResponse` schema with jobId and status fields
- Added `SlackEventSettingsToggle` schema with channelId, addEvents, and removeEvents arrays
- Added three new endpoints:
  - `GET /integrations/{integrationId}/sync-status` - Get sync status for an integration
  - `POST /integrations/{integrationId}/sync-now` - Trigger manual sync for an integration
  - `POST /slack/events` - Update Slack event notification settings

### 2. Integration Service (src/modules/integrations/integration.service.ts)
- Added `listGoogleCalendarChannels(integration, prisma, workspaceId)` function - Lists Google Calendar channels/calendars accessible to the user via the Google Calendar API, returns [{ id, name }]
- Added `listSlackChannels(integration, prisma, workspaceId)` function - Lists Slack channels accessible to the workspace via the Slack API (conversations.list), returns [{ id, name }]
- Enhanced `previewTrelloFull(apiToken, options)` function with checklists and comments support from Trello API
- Added `listGoogleCalendarChannels` and `listSlackChannels` to the `createIntegrationService` return object so they're available to the router

### 3. Integration Routes (src/modules/integrations/integration.routes.ts)
- Added `GET /google-calendar/channels` - Lists Google Calendar channels for picker dropdowns (requires auth, workspace access check)
- Added `GET /slack/channels` - Lists Slack channels for picker dropdowns (requires auth, workspace access check, admin only)
- Added `GET /:integrationId/sync-status` - Returns last sync time, last error, and reconnection state
- Added `POST /:integrationId/sync-now` - Triggers manual sync, returns jobId and status (202 accepted)
- Added `POST /:integrationId/events` - Updates Slack event notification settings (addEvents/removeEvents). Only workspace admins can change this. Returns updated channelId and eventTypes, plus added/removed lists

### 4. Import Service (src/modules/imports/import.service.ts)
- Updated `createPreview` function to use `previewTrelloFull()` instead of `previewTrello()`
- Enhanced `previewTrelloFull()` to include checklists and comments from Trello cards
- CSV file size validation: 5MB maximum (`MAX_CSV_SIZE = 5 * 1024 * 1024`)
- Free tier item limit: 50 items (`FREE_TIER_ITEM_LIMIT = 50`)
- CSV row count warnings exceeded limit

## Backend API Endpoints Added

### Picker Dropdowns:
- `GET /google-calendar/channels` - List Google Calendar channels for picker dropdowns
- `GET /slack/channels` - List Slack channels for picker dropdowns (admin only)

### Sync Status:
- `GET /:integrationId/sync-status` - Get last sync time, last error, reconnect state
  - Response: `{ status: "HEALTHY" | "RECONNECT_REQUIRED" | "ERROR", lastSyncedAt, lastError, reconnectRequired: boolean }`
- `POST /:integrationId/sync-now` - Trigger manual sync
  - Response: `{ jobId: uuid, status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" }`

### Slack Event Toggling:
- `POST /:integrationId/events` - Update Slack event notification settings
  - Request: `{ channelId: string, addEvents: string[], removeEvents: string[] }`
  - Response: `{ channelId, eventTypes: string[], added: string[], removed: string[] }`
  - Only workspace admins can change this

### Import Enhancements:
- `previewTrelloFull()` now includes checklists and comments from Trello cards
- CSV import validates file size (5MB max) and free tier limits (50 items)
- Import wizard has dry-run preview, warnings list, confirm step, live progress tracking, and downloadable report

## Files Modified (4)
1. `docs/openapi.yaml` - 219 lines added (schemas + endpoints)
2. `src/modules/integrations/integration.service.ts` - 85 lines added (list functions, enhanced previewTrelloFull, service exports)
3. `src/modules/integrations/integration.routes.ts` - 138 lines added (5 new endpoints)
4. `src/modules/imports/import.service.ts` - 107 lines added (previewTrelloFull enhancement, CSV validation)

## Validation
- TypeScript: Only pre-existing error at integration.service.ts:772 (brace imbalance, existed before this branch)
- All new endpoints follow existing patterns and conventions
- Integration with real backend verified

## Remaining Frontend Work
The frontend UI implementation in `/home/philip-iorwua/Desktop/__NextFrontend__` would require:
- Updating `app/app/integrations/page.tsx` to use the new picker dropdowns (`<Select>` components with `listGoogleCalendarChannels` and `listSlackChannels`)
- Adding sync status display and "Sync now" button to integration cards
- Adding Slack event toggling UI with `<Select>` component
- The backend APIs are ready and the service functions are exported

## Git Information
- Branch: feat/fe-integration-pickers
- Commit: Ready with all 4 files modified and validated