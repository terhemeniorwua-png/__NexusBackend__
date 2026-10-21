# Nexus Backend

**Real-Time Workspace & Project Management Platform**

Nexus is a collaborative workspace platform designed to bring project management, task tracking, team communication, shared documents, notifications, meetings, and AI-assisted productivity into one connected environment.

The Nexus backend powers the platform's business logic, data persistence, authentication, authorization, real-time communication, integrations, and API services.

## Table of Contents

- [Overview](#overview)
- [Core Features](#core-features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [User Roles](#user-roles)
- [Task Workflow](#task-workflow)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Configuration](#environment-configuration)
- [Database Setup](#database-setup)
- [Running the Server](#running-the-server)
- [API Design](#api-design)
- [Real-Time Communication](#real-time-communication)
- [Redis and Caching](#redis-and-caching)
- [Email and Notifications](#email-and-notifications)
- [Meetings and AI Integration](#meetings-and-ai-integration)
- [Security](#security)
- [Testing](#testing)
- [Frontend Integration](#frontend-integration)
- [Deployment](#deployment)
- [Development Workflow](#development-workflow)
- [Contributing](#contributing)

## Overview

Modern teams often use separate applications for project management, documents, messaging, and meetings. This can fragment conversations, decisions, and task information.

Nexus aims to bring these activities together in one workspace, connecting communication directly to the work being performed.

The backend provides the services required to manage users, workspaces, teams, projects, tasks, conversations, documents, notifications, and supported external integrations.

The backend and frontend are maintained in separate repositories and communicate through documented HTTP APIs and real-time events where supported.

## Core Features

### 1. Authentication and User Management

- User registration and login.
- Session management and logout.
- Secure password handling.
- User profiles and account settings.
- Authentication failure and expired-session handling.
- Role-aware access control.
- Email verification and password recovery where implemented.

### 2. Workspaces and Teams

- Workspace creation and management.
- Team membership and invitations.
- Member management.
- Workspace and project access control.
- Role-based permissions.
- Private and shared workspaces according to configured permissions.

### 3. Project Management

- Create and manage projects.
- Assign members to projects.
- Manage project visibility and access.
- Organize work into tasks and relevant resources.
- Track project activity and progress.
- Support project-level discussions and collaboration.

### 4. Task Management

- Create, update, and assign tasks.
- Manage task descriptions, priority, due dates, and status.
- Support Kanban and list-based task organization.
- Track task comments and activity where implemented.
- Support task submission, review, approval, and change requests.
- Calculate project progress according to defined business rules.

### 5. Connected Communication

Nexus connects conversations to the work they concern.

Potential capabilities include:

- Direct messages.
- Team and project conversations.
- Task-specific discussions.
- User mentions.
- Message-to-task conversion.
- Contextual file sharing.
- Real-time message delivery where supported.
- Notifications for relevant activity.

### 6. Documents and Collaboration

- Store and organize workspace documents.
- Control access to shared resources.
- Support document creation and editing where implemented.
- Track saving and update states.
- Integrate collaborative editing services when configured.

Real-time collaborative editing requires a compatible implementation; it is not guaranteed by ordinary REST endpoints or Socket.IO alone.

### 7. Notifications

- Task assignment notifications.
- Comment and mention notifications.
- Project activity notifications.
- Messaging notifications.
- Read and unread status where implemented.
- Real-time notification delivery where supported.
- Email notifications through a configured provider.

### 8. Meetings and AI-Assisted Productivity

The architecture may support integrations for:

- Starting meetings from a workspace, project, or conversation.
- Meeting metadata and participant management.
- Meeting summaries and action items.
- AI-assisted task or project workflows.
- Summarization of authorized workspace content.

These capabilities depend on the relevant providers, credentials, permissions, and backend services being configured.

### 9. Files and Attachments

Where implemented, file-related services should support:

- Uploading and associating files with relevant resources.
- File metadata and access control.
- Configurable storage providers.
- File type and size restrictions.
- Authorized file retrieval.

Large files should generally use appropriate object storage rather than being stored directly in relational database records.

## Architecture

Nexus uses a separated frontend/backend architecture.

```text
┌─────────────────────────────────────┐
│        Nexus Frontend               │
│     Next.js + TypeScript            │
└──────────────────┬──────────────────┘
                   │
          HTTPS / REST API
                   │
          Socket.IO connection
                   │
┌──────────────────▼──────────────────┐
│          Nexus Backend              │
│        Node.js + Express            │
│             TypeScript              │
├─────────────────────────────────────┤
│ Authentication and Authorization    │
│ Workspace and Project Services      │
│ Task and Document Services          │
│ Messaging and Notification Services │
│ Integration and Validation Layers   │
└───────────┬─────────────┬───────────┘
            │             │
     ┌──────▼──────┐ ┌────▼─────┐
     │ PostgreSQL  │ │  Redis   │
     │  + Prisma   │ │ Cache /  │
     │             │ │ Support  │
     └─────────────┘ └──────────┘
```

The exact implementation may include additional services for email delivery, file storage, meetings, AI processing, or background jobs.

### Architectural Principles

- Separation of concerns.
- Explicit API contracts.
- Centralized validation and error handling.
- Authentication and authorization enforced on the server.
- Reusable business services.
- Database integrity and transactional consistency.
- Real-time events that reflect authorized state changes.
- Environment-based configuration.
- Testable, maintainable code.

## Technology Stack

| Technology | Purpose |
|---|---|
| Node.js | JavaScript runtime |
| Express.js | HTTP API framework |
| TypeScript | Type-safe application development |
| PostgreSQL | Relational database |
| Prisma ORM | Database access, schema, and migrations |
| Redis | Caching and other configured real-time or background-work support |
| Socket.IO | Real-time communication |
| JWT or secure session mechanism | Authentication, according to the implementation |
| Email provider | Transactional email where configured |
| Testing tools | Automated quality assurance |

Use the versions and scripts defined in the repository's package manifest and lockfile.

## User Roles

Nexus supports the following intended roles:

| Role | Intended responsibility |
|---|---|
| Owner | Workspace administration and ownership |
| PM | Project planning and management |
| Member | Participation in assigned or authorized work |
| Viewer | Read-only access where permitted |
| Collaborator | Access to explicitly shared resources |

The backend must enforce the actual permission matrix for each resource and action. The descriptions above are conceptual; the implemented authorization rules are authoritative.

## Task Workflow

The intended task lifecycle is:

`ASSIGNED → IN_PROGRESS → SUBMITTED → UNDER_REVIEW → APPROVED`

An additional state is:

`CHANGES_REQUESTED`

The backend should validate permitted transitions, verify the acting user's permissions, and preserve the task's relevant activity history.

Project progress should follow a consistent server-defined calculation rather than relying on independently calculated frontend values.

## Project Structure

The following is an illustrative structure. Adapt it to the repository's actual organization.

```text
nexusbackend/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── config/
│   ├── controllers/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   ├── repositories/
│   ├── validators/
│   ├── types/
│   ├── utils/
│   ├── sockets/
│   ├── integrations/
│   ├── app.ts
│   └── server.ts
├── tests/
├── nexus-database/
│   └── SKILL.md
├── emailing/
│   └── SKILL.md
├── ai-meetings/
│   └── SKILL.md
├── real-messaging/
│   └── SKILL.md
├── testing-deployment/
│   └── SKILL.md
├── agent.md
├── PHASES.md
├── .env.example
├── package.json
└── README.md
```

Not every folder must exist. Follow the actual project architecture and avoid creating unnecessary layers.

## Prerequisites

Install or configure:

- A supported Node.js version.
- npm, pnpm, or the package manager specified by the repository.
- PostgreSQL.
- Redis if required by the configured application features.
- Git.
- Access to any external services required for the features being developed.

## Installation

Clone the backend repository and enter its directory:

```bash
git clone <YOUR_NEXUS_BACKEND_REPOSITORY_URL>
cd nexusbackend
```

Install dependencies using the repository's package manager.

For npm:

```bash
npm install
```

Create your local environment file from the example, if provided:

```bash
cp .env.example .env
```

Configure the required values before starting the application.

Never commit `.env` or real credentials.

## Environment Configuration

The exact environment variable names must match the application's configuration code.

Typical configuration categories include:

| Variable or setting | Purpose |
|---|---|
| `NODE_ENV` | Runtime environment |
| `PORT` | HTTP server port |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string, if used |
| `FRONTEND_URL` | Trusted frontend origin |
| `JWT_SECRET` | JWT signing secret, if JWT is used |
| `SESSION_SECRET` | Session signing secret, if applicable |
| `EMAIL_*` | Email provider configuration |
| `AI_*` | AI provider configuration, if integrated |
| `MEETING_*` | Meeting provider configuration, if integrated |
| `STORAGE_*` | File storage configuration, if integrated |

These names are examples, not a guarantee of the repository's current variable names. Inspect the configuration code and `.env.example` before using them.

Use strong secrets in development and production. Never expose backend secrets to the frontend.

## Database Setup

Nexus uses PostgreSQL as its relational data store and Prisma for schema management and database access.

After configuring the database connection, inspect the Prisma scripts in `package.json`.

Typical development commands, if supported by the project, include:

```bash
npx prisma validate
npx prisma generate
npx prisma migrate dev
```

For production deployments, use the repository's approved migration process, commonly:

```bash
npx prisma migrate deploy
```

Do not run migrations against production without reviewing the migration, confirming the target database, and following the deployment procedure.

Avoid destructive database resets unless explicitly authorized and safely isolated to a disposable development database.

## Running the Server

Inspect `package.json` for the actual scripts.

Common examples include:

```bash
npm run dev
```

For a configured production build:

```bash
npm run build
npm start
```

The exact commands depend on the repository's scripts and TypeScript build configuration.

When running locally, confirm that:

- The server starts successfully.
- PostgreSQL is reachable.
- Required migrations have been applied.
- Redis connects if required.
- Required environment variables are present.
- The frontend can reach the API using the configured URL.

## API Design

Organize APIs by resource and domain.

Potential resource groups include:

- Authentication and users.
- Workspaces and teams.
- Members and invitations.
- Projects and project membership.
- Tasks and task activity.
- Documents.
- Conversations and messages.
- Notifications.
- Meetings and AI-assisted features.
- Files and attachments.

These are domain categories, not claims that specific endpoints already exist.

### API Guidelines

- Use consistent HTTP methods and status codes.
- Validate request parameters and bodies.
- Authenticate protected requests.
- Enforce resource-level authorization.
- Return consistent response and error structures.
- Apply pagination to large collections.
- Validate sorting and filtering parameters.
- Use database transactions for operations that must succeed or fail together.
- Document request and response contracts for the frontend.
- Avoid returning sensitive fields unnecessarily.

Maintain API documentation using the documentation approach adopted by the repository.

## Real-Time Communication

Socket.IO may be used for live messaging, task updates, notifications, presence, and other supported events.

Real-time events should:

- Authenticate connections.
- Verify access to requested resources and rooms.
- Validate event payloads.
- Avoid exposing private workspace information.
- Use consistent event names and payload schemas.
- Avoid broadcasting sensitive data to unauthorized users.
- Cleanly handle disconnects and reconnections.
- Integrate with persisted database state where appropriate.

If multiple backend instances are deployed, configure a suitable shared Socket.IO adapter when cross-instance event delivery is required.

Document the event contract so the frontend can subscribe to the correct events without guessing.

## Redis and Caching

Redis can support selected infrastructure needs, including:

- Caching frequently accessed data.
- Rate limiting.
- Temporary state.
- Background-job infrastructure, if configured.
- Socket.IO cross-instance coordination when the relevant adapter is installed.

Use Redis only for responsibilities actually configured in the project.

Define cache expiration and invalidation rules. Do not allow stale cached data to bypass authorization or expose data after permissions change.

PostgreSQL should remain the authoritative store for persistent relational application data unless a specific service has a documented alternative.

## Email and Notifications

Email functionality should use a configured provider through a dedicated service or integration layer.

Potential email use cases include:

- Account verification.
- Password recovery.
- Workspace invitations.
- Task assignment notifications.
- Relevant project activity.
- Meeting or collaboration updates.

Requirements:

- Keep provider credentials server-side.
- Validate recipient addresses.
- Handle provider failures and retries appropriately.
- Avoid duplicate notifications.
- Do not expose credentials or sensitive content in logs.
- Use templates consistently.
- Record delivery status where required and supported.

Do not assume email delivery is working until the provider is configured and tested.

## Meetings and AI Integration

Integrations should be isolated behind clear service boundaries.

For AI and meeting providers:

- Store API credentials securely.
- Validate incoming requests.
- Apply appropriate user and resource permissions.
- Handle timeouts, rate limits, and provider errors.
- Track relevant usage where required.
- Protect transcripts, recordings, summaries, and other private content.
- Avoid treating AI-generated output as verified facts without appropriate validation.

Do not make external services mandatory for unrelated features unless the product architecture requires it.

## Security

Security must be enforced by the backend, regardless of what the frontend displays.

Key requirements include:

- Secure password hashing.
- Strong session or token management.
- Authorization on every protected resource.
- Input validation.
- SQL injection protection through safe database access patterns.
- Rate limiting for sensitive or abuse-prone operations.
- Secure CORS configuration.
- Safe error responses.
- Secret management.
- Upload validation and access controls.
- Protection against unauthorized workspace and project access.
- Appropriate audit logging.
- Dependency and configuration maintenance.

Never log passwords, access tokens, private keys, or unnecessary sensitive user data.

## Testing

Test the system at multiple levels:

- Unit tests for services and utilities.
- API integration tests.
- Authentication and authorization tests.
- Database integration tests using isolated test data.
- Task workflow and permission tests.
- Real-time event tests where applicable.
- Email and external-provider tests using safe test configurations.
- Regression tests for existing functionality.

Run the scripts actually configured in `package.json`. Do not run tests against production data.

## Frontend Integration

The frontend is a separate Next.js and TypeScript application.

Integration requires agreement on:

- API base URL.
- Authentication and session strategy.
- Request and response types.
- Error formats.
- Pagination conventions.
- CORS and allowed origins.
- Socket.IO URL and authentication.
- Event names and payload schemas.
- Upload and download behavior.
- Date, time, and timezone conventions.

Maintain a documented contract between both repositories. Update the frontend types and integration code when a backend contract intentionally changes.

## Deployment

Before deploying:

1. Review configuration and secrets.
2. Verify database connectivity.
3. Review pending migrations.
4. Run the appropriate automated checks.
5. Build the application.
6. Configure Redis and required external services.
7. Configure frontend origins and CORS.
8. Configure HTTPS and production secrets.
9. Deploy using the approved process.
10. Verify health, logs, database access, and essential user flows.

Use backward-compatible database changes when possible. Prepare a rollback or recovery procedure for risky releases.

## Development Workflow

The repository may contain:

- `agent.md` for project-wide development instructions.
- `PHASES.md` for the implementation roadmap and progress.
- Specialized `SKILL.md` files for database work, messaging, email, AI meetings, testing, and deployment.

Before implementing a feature:

1. Read the relevant instructions and phase.
2. Inspect existing code and configuration.
3. Identify dependencies and API contracts.
4. Implement the smallest coherent change.
5. Run relevant tests and checks.
6. Document unresolved issues.
7. Update phase status only when acceptance criteria are verified.

## Contributing

Contributions should preserve the existing architecture, maintain security and data integrity, and include appropriate tests.

Before submitting changes:

- Verify the affected functionality.
- Run applicable lint, type-check, test, and build commands.
- Document API or schema changes.
- Avoid committing credentials or local environment files.
- Explain known limitations and required configuration.

## Project Status

The precise implementation status of each feature is determined by the source code, tests, configuration, and current roadmap—not by the feature descriptions in this README.

