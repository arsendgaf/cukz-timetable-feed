export interface TimetableEvent {
    date: string;       // e.g. "2026-09-15"
    start: string;      // e.g. "09:00"
    end: string;        // e.g. "10:30"
    module?: string;
    title?: string;
    activity?: string;
    room?: string;
    staff?: string;
    group?: string;
    type?: string;
    timetableId?: string;
}

export interface TimetablePayload {
    students: Record<string, string[]>; // Student ID -> Array of event IDs
    events: Record<string, TimetableEvent>; // Event ID -> Event details
}

export interface ScriptConfig {
    ALLOWED_SENDER: string;
    ATTACHMENT_NAME: string;
    MY_STUDENT_ID: string;
    CALENDAR_ID: string;
}