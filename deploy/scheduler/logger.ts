type LogArguments = Parameters<typeof console.error>;
type Severity = "warn" | "error";
type Category = "abort" | "timeout" | "type_error" | "range_error" | "error" | "warning";

function category(args: LogArguments, level: Severity): Category {
  for (const argument of args) {
    if (argument instanceof Error) {
      if (argument.name === "AbortError") {
        return "abort";
      }
      if (argument.name === "TimeoutError") {
        return "timeout";
      }
      if (argument instanceof TypeError) {
        return "type_error";
      }
      if (argument instanceof RangeError) {
        return "range_error";
      }
      return "error";
    }
  }
  return level === "error" ? "error" : "warning";
}

/** Library messages often contain recipients, SQL or provider data. Emit only fixed categories. */
export function createSchedulerLogger(write: (entry: string) => void = (entry) => console.log(entry)) {
  const emit = (level: Severity, args: LogArguments) =>
    write(JSON.stringify({ event: "usc_scheduler_library_log", level, category: category(args, level) }));
  return {
    debug: (..._args: LogArguments) => undefined,
    info: (..._args: LogArguments) => undefined,
    warn: (...args: LogArguments) => emit("warn", args),
    error: (...args: LogArguments) => emit("error", args),
  };
}

// Do not replace global console: the entry point owns its separate structured job events.
export default createSchedulerLogger();
