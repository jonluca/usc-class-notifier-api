import { z } from "zod";

export interface Schedule {
  Data: ScheduleEntry[];
}

export interface ScheduleEntry {
  Title: string;
  Start: string | Date;
  End: string | Date;
}

const scheduleSchema = z.object({
  Data: z.array(
    z.object({
      Title: z.string(),
      Start: z.string(),
      End: z.string(),
    }),
  ),
});

export function parseScheduleDocument(text: string): Schedule | null {
  const syncScript = text.split("<script>kendo.syncReady")[1]?.split("\n")[0];
  if (!syncScript) {
    return null;
  }
  // There's a JSON object of the form `"data":{"Data"` that we want to parse.
  const json = syncScript.split('data":{"Data":')[1]?.split("]")[0];
  if (!json) {
    return null;
  }

  try {
    const parsedSchedule = scheduleSchema.safeParse(JSON.parse(`{"Data":${json}]}`));
    return parsedSchedule.success ? parsedSchedule.data : null;
  } catch {
    return null;
  }
}
