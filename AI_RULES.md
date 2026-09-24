# Tech Stack & Architecture

- **Framework**: Next.js 16 with App Router (`src/app/`) and React 19 in TypeScript 5 (`strict: true`).
- **Database & Persistence**: SQLite via `better-sqlite3` (`src/lib/db.ts`) with versioned schema migrations (`src/lib/migrations.ts`).
- **Styling**: Tailwind CSS 4 (`@tailwindcss/postcss`) using CSS custom properties for theming and `cn()` (`clsx` + `tailwind-merge`) for dynamic classes.
- **Client State**: Zustand (`src/store/index.ts`) for global application state (active panel, workspace selection, metrics, filters).
- **Internationalization & Theming**: `next-intl` for localization (`src/i18n/`) and `next-themes` for dark/light/system mode switching.
- **Data Visualization & Graphs**: `recharts` for metrics, telemetry, and cost trends; `reagraph` for agent network and memory knowledge graphs.
- **Terminal & Real-time I/O**: `@xterm/xterm` (with `@xterm/addon-fit` and `@xterm/addon-web-links`) alongside WebSocket (`ws`) and `node-pty` for terminal sessions.
- **Content & Markdown**: `react-markdown` with `remark-gfm` for rich text rendering in logs, tasks, sessions, and chat transcripts.
- **Validation & Logging**: `zod` for API contracts and payload validation; `pino` (`src/lib/logger.ts`) for structured server logging.
- **Testing & Quality**: Vitest and `@testing-library/react` for unit/integration tests; Playwright for E2E tests (`pnpm test:e2e`).

---

# Library & Tool Usage Rules

### 1. UI, Styling & Layout
- **Tailwind CSS 4**: Use utility classes for all styling, layout, spacing, and colors. Use `cn(...)` from `@/lib/utils` to merge class names conditionally.
- **Icons**: Do **not** use icon libraries like `lucide-react` or `react-icons`. Use native text characters, emojis, or inline SVGs according to established codebase conventions.
- **Radix UI Primitives**: Use `@radix-ui/react-slot` and headless components for accessible UI composition where applicable.

### 2. State Management & Data Fetching
- **Global State**: Use Zustand (`src/store/index.ts`) for global cross-panel state (selected workspace, navigation, dashboard widgets, real-time caches).
- **Component State**: Use standard React hooks (`useState`, `useReducer`, `useRef`, `useCallback`) for localized UI interactions.
- **API Communication**: Use `apiFetch` from `@/lib/api-client` for client-to-server HTTP calls with integrated error and auth handling.
- **Real-time Events**: Use `useServerEvents` or WebSocket helpers (`@/lib/websocket.ts`, `@/lib/event-bus.ts`) for live updates.

### 3. Backend & Database
- **Database Access**: Always use `getDb()` from `@/lib/db.ts` to query SQLite.
- **SQL Safety**: Always use parametrized queries (`db.prepare('... WHERE id = ?').get(id)`) to eliminate SQL injection risks.
- **Migrations**: Add new schema changes as numbered migrations in `@/lib/migrations.ts` rather than modifying existing migration steps.
- **File System Operations**: Use atomic write utilities (`@/lib/atomic-file.ts`) when persisting config files or logs.

### 4. Validation & Security
- **Schema Validation**: Use `zod` to parse and validate incoming HTTP request payloads, route query parameters, and external integration data.
- **Authentication & RBAC**: Verify authentication via session cookies or API keys using helpers in `@/lib/auth.ts`. Check workspace and tenant isolation with `@/lib/workspace-isolation.ts`.
- **Path Security**: Validate and sanitize file paths using `@/lib/paths.ts` and `@/lib/config-path.ts` to prevent directory traversal.

### 5. Logging & Diagnostics
- **Server Logging**: Use `logger` from `@/lib/logger.ts` (`pino`) for structured backend logging. Avoid bare `console.log` in production server code.
- **Client Logging**: Use `clientLogger` from `@/lib/client-logger.ts` for browser-side diagnostics.

### 6. Terminal & Visualization
- **Terminal Emulator**: Use `@xterm/xterm` together with `@xterm/addon-fit` for all interactive CLI/PTY sessions.
- **Charts**: Use `recharts` (`ResponsiveContainer`, `LineChart`, `BarChart`, `AreaChart`) for telemetry and time-series data.
- **Graph Visualizations**: Use `reagraph` for interactive graph canvas layouts (e.g., agent memory networks, dependency graphs).

### 7. Documentation & Markdown
- **Markdown Rendering**: Use `react-markdown` configured with `remark-gfm` via `MarkdownRenderer` (`@/components/markdown-renderer.tsx`) for sanitized output.
- **API Reference**: Use `@scalar/api-reference-react` for rendering the OpenAPI interactive documentation at `/docs`.

### 8. Testing & Verification
- **Unit & Integration Tests**: Place tests in `src/lib/__tests__/` or next to their source files matching `*.test.ts(x)` using `vitest`.
- **E2E Tests**: Use Playwright (`playwright.config.ts`) for browser-level scenario validation.
- **Type Checking**: Verify all changes with `pnpm typecheck` (`tsc --noEmit`).
