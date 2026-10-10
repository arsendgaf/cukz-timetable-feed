import { ScriptConfig, TimetableEvent, TimetablePayload } from './types';
import { CONFIG } from "./config";

/**
 * Main Google Apps Script trigger entry point.
 *
 * Searches for unread timetable emails matching the configured sender and attachment,
 * extracts schedule data, and initiates a differential sync into Google Calendar.
 *
 * @remarks
 * External time-driven triggers (e.g. every 5 minutes) invoke this function directly.
 * Idempotency is preserved by only marking messages as read once synchronization is 100% complete.
 */
function processTimetableEmails(): void {
  // Use `is:unread` (not `in:inbox`) because Gmail filters archive timetable emails to silence alerts.
  const searchQuery = `is:unread from:${CONFIG.ALLOWED_SENDER} filename:${CONFIG.ATTACHMENT_NAME}`;
  const threads = GmailApp.search(searchQuery);

  if (threads.length === 0) return;

  for (const thread of threads) {
    const messages = thread.getMessages();

    for (const message of messages) {
      if (!message.isUnread()) continue;

      const sender = message.getFrom();
      if (!sender.includes(CONFIG.ALLOWED_SENDER)) continue;

      const attachments = message.getAttachments();

      for (const attachment of attachments) {
        if (attachment.getName().toLowerCase() === CONFIG.ATTACHMENT_NAME.toLowerCase()) {
          try {
            const htmlContent = attachment.getDataAsString();
            const payload = parseJsonFromHtml(htmlContent);

            if (payload?.students && payload?.events) {
              const fullySynced = syncToGoogleCalendar(payload);
              if (fullySynced) {
                // Mark read only upon complete sync to prevent re-processing in subsequent runs
                message.markRead();
                Logger.log('The timetable has been successfully synced.');
              } else {
                Logger.log('The timetable was partially synced due to time limits; remaining classes will sync on next run.');
                return; // Exit immediately to avoid exceeding GAS's 6-minute execution limit on subsequent messages
              }
            }
          } catch (error) {
            Logger.log(`Sync unsuccessful. Error: ${(error as Error).toString()}`);
          }
        }
      }
    }
  }
}

/**
 * Synchronizes the parsed timetable dataset into a dedicated Google Calendar.
 *
 * Implements a resilient differential sync pipeline:
 * 1. Resolves all events assigned to `CONFIG.MY_STUDENT_ID`.
 * 2. Fetches existing calendar events within week-padded bounds in a single bulk API call.
 * 3. Matches incoming events using a 3-tier lookup hierarchy (Tag -> Time range -> Legacy title).
 * 4. Only calls mutation setters if event properties differ, conserving API quotas.
 * 5. Prunes orphaned timetable events (cancellations/reschedules) if the sync completed fully.
 * 6. Enforces a 4-minute soft deadline to gracefully exit before the Google Apps Script 6-minute limit.
 *
 * @param payload - Parsed student-to-event mappings and event dictionaries.
 * @returns `true` if all events and cleanup completed; `false` if paused due to execution limits.
 */
function syncToGoogleCalendar(payload: TimetablePayload): boolean {
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!calendar) {
    throw new Error(`Calendar with ID ${CONFIG.CALENDAR_ID} was not found.`);
  }

  const rawEventIds = payload.students[CONFIG.MY_STUDENT_ID];
  if (!rawEventIds || rawEventIds.length === 0) {
    Logger.log(`No classes were found for Student ID ${CONFIG.MY_STUDENT_ID}.`);
    return true;
  }

  // Deduplicate incoming IDs
  const myEventIds = Array.from(new Set(rawEventIds));

  // Map IDs to hydrated event objects with their unique timetable identifier attached
  const myEvents: TimetableEvent[] = myEventIds
    .map((id: string): TimetableEvent | null => {
      const eventObj = payload.events[id];
      if (eventObj) {
        return { ...eventObj, timetableId: String(id) };
      }
      return null;
    })
    .filter((e): e is TimetableEvent => e !== null);

  if (myEvents.length === 0) {
    Logger.log(`No valid class events mapped for Student ID ${CONFIG.MY_STUDENT_ID}.`);
    return true;
  }

  const incomingIds = new Set(myEvents.map(e => e.timetableId!));

  // Determine local date bounds covering the entire earliest to latest class day,
  // padded to full week boundaries (Monday to Sunday) to capture boundary cancellations
  let minTime = Infinity;
  let maxTime = -Infinity;

  for (const ev of myEvents) {
    const [year, month, day] = ev.date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
    if (dayStart < minTime) minTime = dayStart;
    if (dayEnd > maxTime) maxTime = dayEnd;
  }

  // Align minDate to Monday 00:00:00 of the earliest week
  const minDateObj = new Date(minTime);
  const minDayOfWeek = minDateObj.getDay();
  const diffToMonday = (minDayOfWeek + 6) % 7;
  minDateObj.setDate(minDateObj.getDate() - diffToMonday);
  minDateObj.setHours(0, 0, 0, 0);
  const minDate = minDateObj;

  // Align maxDate to Sunday 23:59:59 (+ 1s to make 00:00:00 next day) of the latest week
  const maxDateObj = new Date(maxTime);
  const maxDayOfWeek = maxDateObj.getDay();
  const diffToSunday = (7 - maxDayOfWeek) % 7;
  maxDateObj.setDate(maxDateObj.getDate() + diffToSunday);
  maxDateObj.setHours(23, 59, 59, 999);
  const maxDate = new Date(maxDateObj.getTime() + 1000);

  // Single bulk fetch of existing events in the date range to minimize CalendarApp API calls
  const existingEvents = calendar.getEvents(minDate, maxDate);

  // Multi-index existing events for fast O(1) in-memory lookup
  const claimedEventIds = new Set<string>();
  const existingById = new Map<string, GoogleAppsScript.Calendar.CalendarEvent[]>();
  const existingByTimeRange = new Map<string, GoogleAppsScript.Calendar.CalendarEvent[]>();
  const existingByLegacyKey = new Map<string, GoogleAppsScript.Calendar.CalendarEvent[]>();

  for (const e of existingEvents) {
    const tagId = e.getTag('timetableId');
    if (tagId) {
      const list = existingById.get(tagId) || [];
      list.push(e);
      existingById.set(tagId, list);
    }

    const startMin = Math.floor(e.getStartTime().getTime() / 60000);
    const endMin = Math.floor(e.getEndTime().getTime() / 60000);
    const timeKey = `${startMin}_${endMin}`;

    const rangeList = existingByTimeRange.get(timeKey) || [];
    rangeList.push(e);
    existingByTimeRange.set(timeKey, rangeList);

    const legacyKey = `${startMin}_${e.getTitle()}`;
    const legacyList = existingByLegacyKey.get(legacyKey) || [];
    legacyList.push(e);
    existingByLegacyKey.set(legacyKey, legacyList);
  }

  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let deletedCount = 0;
  let mutationCount = 0;

  const executionStartTime = Date.now();
  const MAX_EXECUTION_TIME_MS = 240000; // 4 minutes safety limit (GAS hard limit is 6 min)
  let syncCompleted = true;

  for (const ev of myEvents) {
    // Check execution deadline before processing the next event
    if (Date.now() - executionStartTime > MAX_EXECUTION_TIME_MS) {
      Logger.log('Execution time limit approaching. Pausing calendar sync to avoid timeout.');
      syncCompleted = false;
      break;
    }

    const [year, month, day] = ev.date.split('-').map(Number);
    const [startHour, startMin] = ev.start.split(':').map(Number);
    const [endHour, endMin] = ev.end.split(':').map(Number);

    const startTime = new Date(year, month - 1, day, startHour, startMin);
    const endTime = new Date(year, month - 1, day, endHour, endMin);

    const rawTitle = ev.module || ev.title || ev.activity || 'Class';
    const courseCode = extractCourseCode(rawTitle);

    let eventTitle = courseCode ?? rawTitle;
    if (courseCode && ev.type) {
      eventTitle += ` (${ev.type})`;
    }

    const location = ev.room || 'TBA';
    const uniqueId = ev.timetableId!;
    const targetColor = getColorForCourse(courseCode || eventTitle);

    // Build human-readable event description metadata
    const descParts: string[] = [];
    if (ev.title && ev.title !== eventTitle) descParts.push(ev.title);
    if (ev.activity && ev.activity !== eventTitle) descParts.push(ev.activity);
    if (ev.staff) descParts.push(`Seminar by ${ev.staff}`);
    if (ev.group) descParts.push(`Group: ${ev.group}`);
    if (ev.type) descParts.push(`Type: ${ev.type}`);
    const description = descParts.join('\n\n');

    const sMin = Math.floor(startTime.getTime() / 60000);
    const eMin = Math.floor(endTime.getTime() / 60000);
    const timeRangeKey = `${sMin}_${eMin}`;
    const legacyKey = `${sMin}_${eventTitle}`;

    // Lookup hierarchy:
    // 1. Primary: Exact timetableId tag match
    // 2. Secondary: Exact SAME time range match (prevents duplicates at the same time slot)
    // 3. Fallback: Legacy start time + title match (for events created before tagging)
    let existingEvent: GoogleAppsScript.Calendar.CalendarEvent | null = null;

    const idMatches = existingById.get(uniqueId);
    if (idMatches) {
      existingEvent = idMatches.find(e => !claimedEventIds.has(e.getId())) || null;
    }

    if (!existingEvent) {
      const timeMatches = existingByTimeRange.get(timeRangeKey);
      if (timeMatches) {
        const unclaimed = timeMatches.filter(e => !claimedEventIds.has(e.getId()));
        if (unclaimed.length > 0) {
          // Prefer event with matching title, or untagged/non-conflicting tag
          existingEvent =
            unclaimed.find(e => e.getTitle() === eventTitle) ||
            unclaimed.find(e => {
              const tag = e.getTag('timetableId');
              return !tag || !incomingIds.has(tag);
            }) ||
            unclaimed[0];
        }
      }
    }

    if (!existingEvent) {
      const legacyMatches = existingByLegacyKey.get(legacyKey);
      if (legacyMatches) {
        const unclaimed = legacyMatches.filter(e => !claimedEventIds.has(e.getId()));
        if (unclaimed.length > 0) {
          existingEvent = unclaimed[0];
        }
      }
    }

    if (existingEvent) {
      claimedEventIds.add(existingEvent.getId());
      let mutated = false;

      // Update fields ONLY if changed to conserve Google Apps Script API quotas
      if ((existingEvent.getTitle() || '') !== eventTitle) {
        existingEvent.setTitle(eventTitle);
        mutated = true;
      }

      const curStart = existingEvent.getStartTime().getTime();
      const curEnd = existingEvent.getEndTime().getTime();
      if (Math.abs(curStart - startTime.getTime()) >= 60000 || Math.abs(curEnd - endTime.getTime()) >= 60000) {
        existingEvent.setTime(startTime, endTime);
        mutated = true;
      }

      if ((existingEvent.getLocation() || '') !== location) {
        existingEvent.setLocation(location);
        mutated = true;
      }

      if ((existingEvent.getDescription() || '') !== description) {
        existingEvent.setDescription(description);
        mutated = true;
      }

      if (existingEvent.getTag('timetableId') !== uniqueId) {
        existingEvent.setTag('timetableId', uniqueId);
        mutated = true;
      }

      if (String(existingEvent.getColor() || '') !== String(targetColor)) {
        existingEvent.setColor(targetColor);
        mutated = true;
      }

      if (mutated) {
        updatedCount++;
        mutationCount++;
        // Throttle write operations to avoid Google Calendar burst rate limits
        if (mutationCount % 5 === 0) {
          Utilities.sleep(200);
        }
      } else {
        unchangedCount++;
      }
    } else {
      // Event not found in calendar — create new entry
      const newEvent = calendar.createEvent(eventTitle, startTime, endTime, {
        location,
        description
      });

      newEvent.setTag('timetableId', uniqueId);
      newEvent.setColor(targetColor);
      claimedEventIds.add(newEvent.getId());

      createdCount++;
      mutationCount++;
      if (mutationCount % 5 === 0) {
        Utilities.sleep(200);
      }
    }
  }

  // Prune orphaned/cancelled events that were previously tagged by this script
  // but are no longer present in the updated timetable.
  // CRITICAL: Only execute if the full sync completed, preventing partial runs from deleting unprocessed classes.
  if (syncCompleted) {
    for (const existing of existingEvents) {
      if (Date.now() - executionStartTime > MAX_EXECUTION_TIME_MS) {
        Logger.log('Time limit reached during event cleanup; remaining deletions will resume next run.');
        syncCompleted = false;
        break;
      }

      const tag = existing.getTag('timetableId');
      if (tag && !claimedEventIds.has(existing.getId())) {
        existing.deleteEvent();
        deletedCount++;
        mutationCount++;

        if (mutationCount % 5 === 0) {
          Utilities.sleep(200);
        }
      }
    }
  }

  Logger.log(
    `Sync completed. Created: ${createdCount}, Updated: ${updatedCount}, Deleted: ${deletedCount}, Unchanged: ${unchangedCount}. Total: ${myEvents.length} classes.`
  );

  return syncCompleted;
}

/**
 * Extracts normalized module code (e.g. `EL0016`) from a raw class title or activity string.
 *
 * @param s - Raw title or activity string from timetable payload.
 * @returns Clean, uppercase module code without spaces, or `null` if no match found.
 */
function extractCourseCode(s: string | undefined): string | null {
  if (!s) return null;
  const match = s.match(/\b([A-Za-z]+\s*\d+)\b/);
  if (!match) return null;
  return match[1].replace(/\s+/g, '').toUpperCase();
}

/**
 * Maps a course name to a deterministic Google Calendar color using string hashing.
 * Ensures all sessions of a module share the same visual color across the calendar.
 *
 * @param courseName - Course code or fallback course title.
 * @returns A deterministic `GoogleAppsScript.Calendar.EventColor` enum value.
 */
function getColorForCourse(courseName: string): GoogleAppsScript.Calendar.EventColor {
  const colors: GoogleAppsScript.Calendar.EventColor[] = [
    CalendarApp.EventColor.PALE_BLUE,
    CalendarApp.EventColor.PALE_GREEN,
    CalendarApp.EventColor.MAUVE,
    CalendarApp.EventColor.PALE_RED,
    CalendarApp.EventColor.YELLOW,
    CalendarApp.EventColor.ORANGE,
    CalendarApp.EventColor.CYAN,
    CalendarApp.EventColor.GREEN,
    CalendarApp.EventColor.BLUE,
    CalendarApp.EventColor.RED,
    CalendarApp.EventColor.GRAY
  ];

  let hash = 0;
  for (let i = 0; i < courseName.length; i++) {
    hash = courseName.charCodeAt(i) + ((hash << 5) - hash);
  }

  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

/**
 * Extracts and parses embedded JSON timetable payload from HTML attachment content.
 *
 * @param htmlContent - Raw HTML string of the attachment (`timetable.html`).
 * @returns Parsed `TimetablePayload` containing students and events mappings.
 * @throws `Error` if neither primary nor fallback script tags contain JSON data.
 */
function parseJsonFromHtml(htmlContent: string): TimetablePayload {
  // Primary target: <script id="students-data">
  const scriptRegex = /<script[^>]*id=["']students-data["'][^>]*>([\s\S]*?)<\/script>/i;
  const match = htmlContent.match(scriptRegex);

  if (match && match[1]) {
    const unescapedText = unescapeHtmlEntities(match[1].trim());
    return JSON.parse(unescapedText) as TimetablePayload;
  }

  // Fallback target: <script type="application/json">
  const fallbackRegex = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i;
  const fallbackMatch = htmlContent.match(fallbackRegex);

  if (fallbackMatch && fallbackMatch[1]) {
    const unescapedText = unescapeHtmlEntities(fallbackMatch[1].trim());
    return JSON.parse(unescapedText) as TimetablePayload;
  }

  throw new Error('Data script not found in the HTML content.');
}

/**
 * Unescapes HTML-encoded characters (`&quot;`, `&amp;`, etc.) to valid JSON characters.
 * Required because the university's timetable exporter escapes characters inside `<script>` tags.
 *
 * @param str - HTML-encoded string.
 * @returns Decoded plaintext string suitable for `JSON.parse`.
 */
function unescapeHtmlEntities(str: string): string {
  return str
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&#34;/g, '"');
}

// Expose entrypoint function to the global Google Apps Script scope
declare let global: any;
global.processTimetableEmails = processTimetableEmails;