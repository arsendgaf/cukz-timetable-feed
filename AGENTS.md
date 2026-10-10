# AGENTS.md — Cardiff University Kazakhstan Timetable Sync

Guidance and project documentation for AI agents, automated assistants, and pair-programming agents working in this repository.

---

## 1. Project Overview

`cukz-timetable-feed` (package name `cuk-timetable-feed`) is a serverless Google Apps Script (GAS) service written in TypeScript. It automates synchronizing university timetable schedules for Cardiff University Kazakhstan students into Google Calendar.

### End-to-End Data Pipeline
1. **Source Update**: The university publishes/updates `timetable.html` in a SharePoint folder.
2. **Forwarding**: A Microsoft Power Automate automated cloud flow triggers upon file modification and emails `timetable.html` as an attachment to the user's Gmail with the subject `[TIMETABLE]`.
3. **Filtering**: A Gmail filter silences notifications and skips the inbox (archives the message) while keeping it unread.
4. **Processing (GAS Trigger)**: A time-driven Google Apps Script trigger runs `processTimetableEmails()` every 5 minutes.
5. **Extraction**: The script queries unread emails matching the sender and attachment name, parses JSON timetable payload embedded within the HTML, and matches classes by the user's Student ID.
6. **Calendar Synchronization**: Events are mapped, deduplicated, color-coded by course module code, and synced to a dedicated Google Calendar. Once synced, the message is marked read to ensure idempotency.

---

## 2. Tech Stack & Environment

- **Local Runtime / Package Manager**: [Bun](https://bun.sh/)
- **Language**: TypeScript (`ES2022`, strict mode, `@types/google-apps-script`)
- **Bundler**: `esbuild` with `esbuild-gas-plugin`
- **Deployment Tool**: `@google/clasp` (v3+)
- **Target Execution Environment**: Google Apps Script V8 Runtime (`appsscript.json`)
- **Default Timezone**: `Asia/Almaty` (UTC+5)

---

## 3. Directory & File Structure

```text
cukz-timetable-feed/
├── .clasp.json              # Clasp project config (scriptId, rootDir: "dist") [GITIGNORED]
├── .gitignore               # Excludes node_modules, dist/, .clasp.json, src/config.ts
├── appsscript.json          # Google Apps Script manifest (V8 runtime, timezone)
├── build.ts                 # esbuild bundling script with esbuild-gas-plugin
├── bun.lock                 # Bun lockfile
├── package.json             # NPM package scripts and dependencies
├── tsconfig.json            # TypeScript configuration
├── README.md                # End-user setup guide (Calendar, GAS, Clasp, Power Automate, Gmail)
├── AGENTS.md                # This agent guideline file
├── dist/                    # Bundled output pushed to Google Apps Script [GITIGNORED]
│   ├── appsscript.json      # Copied GAS manifest
│   └── index.js             # Bundled GAS-compatible script
├── public/
│   └── images/              # Documentation screenshots for README.md
└── src/
    ├── config.ts            # Live user configuration (Student ID, emails, Calendar ID) [GITIGNORED]
    ├── config.example.ts    # Template reference for user configuration
    ├── index.ts             # Main entrypoint, email processing, parsing, and calendar sync
    └── types.ts             # TypeScript interfaces for timetable data and configuration
```

---

## 4. Key Workflows & CLI Commands

Always run these commands from the repository root:

| Command | Purpose |
| :--- | :--- |
| `bun install` | Install project dependencies. |
| `bunx tsc --noEmit` | Validate TypeScript types without generating output. |
| `bun run build` | Runs `build.ts` to bundle `src/index.ts` into `dist/index.js` and copy `appsscript.json` to `dist/`. |
| `bun run push` | Executes `bun run build` then pushes the bundle to GAS via `bunx clasp push`. |
| `bunx clasp status` | Check status of files tracked by clasp. |
| `bunx clasp open` | Opens the script in the Google Apps Script web editor. |
| `bunx clasp logs` | Fetches Google Apps Script execution logs. |

> **Note on clasp v3+**: Clasp no longer compiles TypeScript directly. Code must always be bundled into `dist/` before running `clasp push`. `rootDir` in `.clasp.json` is set to `"dist"`.

---

## 5. Architectural & Implementation Details

### 5.1 Google Apps Script Entry Point & Global Exposure
- GAS executes top-level function names directly (e.g. `processTimetableEmails`).
- In `src/index.ts`:
  ```typescript
  declare let global: any;
  global.processTimetableEmails = processTimetableEmails;
  ```
- `build.ts` uses `esbuild-gas-plugin` (`GasPlugin`), which ensures top-level function declarations are hoisted and visible in the global Apps Script scope.

### 5.2 Email Search & Idempotency
- Uses `GmailApp.search(searchQuery)` with:
  ```text
  is:unread from:${CONFIG.ALLOWED_SENDER} filename:${CONFIG.ATTACHMENT_NAME}
  ```
- **Crucial**: Use `is:unread`, **not** `in:inbox` or `label:unread`, because the user's Gmail filter archives timetable emails (skips the inbox).
- Once processed successfully, the script calls `message.markRead()` to prevent re-processing in subsequent trigger executions.

### 5.3 HTML Payload Parsing
- The timetable file (`timetable.html`) embeds its dataset inside a `<script>` tag:
  1. Primary: `<script id="students-data">`
  2. Fallback: `<script type="application/json">`
- The script contents are HTML-entity encoded (`&quot;`, `&amp;`, `&#39;`, etc.).
- `parseJsonFromHtml()` unescapes HTML entities using `unescapeHtmlEntities()` before running `JSON.parse()`.
- Payload schema:
  - `students`: mapping of `StudentID -> string[]` (array of event IDs).
  - `events`: mapping of `EventID -> TimetableEvent`.

### 5.4 Calendar Synchronization & Deduplication
- **Date Range Query**: Computes the min and max dates of all student events, padding the query window to full week bounds (Monday to Sunday) to capture boundary cancellations, and queries `calendar.getEvents(minDate, maxDate)`.
- **Deduplication & Lookup Strategy**:
  - Primary identifier: `event.getTag('timetableId')`. Matches `ev.timetableId`.
  - Secondary identifier (Time Range): Minute-normalized start and end time `${startMin}_${endMin}`. If an event already occupies the SAME time slot, it reuses and updates that existing event rather than creating duplicate overlapping classes.
  - Fallback key: `${startMin}_${eventTitle}` for legacy untagged events created before tagging.
  - Multi-event tracking: Uses `claimedEventIds` set to prevent multiple incoming events from claiming the same calendar event.
- **Update Logic & GAS Limit Optimization**:
  - If event exists: Compares `title`, `time`, `location`, `description`, `color`, and `timetableId` tag against the incoming event, and only calls setter RPCs if values have changed. If nothing changed, zero setters are executed, drastically reducing execution time and quota usage.
  - If event does not exist: Creates event with `calendar.createEvent(...)`, sets the `timetableId` tag, and assigns a deterministic color.
- **Orphan Reconciliation & Deletion**:
  - Once all incoming events are processed (and only if the sync completed without reaching time limits), any existing event with a `timetableId` tag that was not claimed in `claimedEventIds` is deleted (`existing.deleteEvent()`). This cleans up cancelled, dropped, or rescheduled classes.
- **Rate-Limiting & Timeout Protection**:
  - Creating, updating, or deleting calendar events in rapid succession can trigger Google Calendar burst rate limits.
  - The script throttles mutations: every 5 mutating operations (creates, updates, or deletes), it calls `Utilities.sleep(200)`.
  - Includes a 4-minute execution guard (`MAX_EXECUTION_TIME_MS`) to stop cleanly before Google Apps Script's 6-minute hard execution limit. Unfinished syncs resume on the next scheduled trigger.

### 5.5 Course Code Parsing & Deterministic Color Coding
- `extractCourseCode(title)` matches patterns like `EL0016` via regex `/\b([A-Za-z]+\s*\d+)\b/`.
- Event titles format as `<CourseCode> (<Type>)` if type is present (e.g., `EL0016 (Lecture)`), falling back to raw title.
- `getColorForCourse(courseName)` computes a string hash modulo 11 palette entries (`CalendarApp.EventColor.*`), ensuring the same course always receives the same visual calendar color.

---

## 6. Configuration & Security Constraints

### Sensitive / Gitignored Files
- `src/config.ts`: Contains live student credentials:
  - `ALLOWED_SENDER`: Email allowed to forward timetables.
  - `ATTACHMENT_NAME`: File name (`timetable.html`).
  - `MY_STUDENT_ID`: Student identifier.
  - `CALENDAR_ID`: Dedicated Google Calendar ID.
- `.clasp.json`: Contains the Google Apps Script project ID (`scriptId`).
- **RULE**: Never commit `src/config.ts` or `.clasp.json` to version control. They are explicitly listed in `.gitignore`.
- When adding or changing configuration options:
  1. Update `src/types.ts` (`ScriptConfig` interface).
  2. Update `src/config.example.ts` with sanitized placeholders.
  3. Update `src/config.ts` if working in local active development.
  4. Update `README.md` if user setup steps change.

---

## 7. Guidelines for AI Agents

1. **GAS Environment Constraints**:
   - Google Apps Script V8 does **not** provide Node.js standard libraries (`fs`, `http`, `crypto`, `path`), browser DOM APIs (`window`, `document`), or `fetch` (use `UrlFetchApp` if HTTP calls are needed).
   - Only use Google Apps Script built-ins (`GmailApp`, `CalendarApp`, `Logger`, `Utilities`, `Session`, etc.) or pure JS/TS utilities compatible with esbuild bundling.
2. **Build and Verification**:
   - Before completing tasks, always run `bunx tsc --noEmit` to verify type safety.
   - Run `bun run build` to ensure the bundling pipeline succeeds and produces valid `dist/index.js` and `dist/appsscript.json`.
3. **Preserve Compatibility**:
   - Do not alter the function name `processTimetableEmails` without updating `README.md`, `build.ts`, and alerting the user, as external time-driven triggers in Google Apps Script reference this exact function name.
   - Preserve `newEvent.setTag('timetableId', uniqueId)` tagging to prevent duplicate calendar events.
4. **Code Quality & Style**:
   - Use TypeScript strict typing; avoid `any` wherever possible.
   - Keep comments concise and informative. Preserve existing docstrings and logic explanations.
