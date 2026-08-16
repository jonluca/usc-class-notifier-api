import type { LoggerOptions } from "winston";
import winston from "winston";
import { isObjectLike, isString, partition } from "lodash-es";
const { combine, timestamp, printf, colorize, errors, splat } = winston.format;
export const winstonTimestamp = timestamp({
  format: "YYYY-MM-DD HH:mm:ss",
});
const winstonPrint = () =>
  printf((info) => {
    if (isObjectLike(info.message)) {
      info.message = JSON.stringify(info.message);
    }
    return (
      `[${info.timestamp}] [${info.level}] - ${info.message}` +
      (info.splat !== undefined ? `${info.splat}` : " ") +
      (info.stack !== undefined ? `\n${info.stack}` : " ")
    );
  });

export const localFormat = () =>
  combine(winstonTimestamp, colorize(), splat(), errors({ stack: true }), winstonPrint());

const consoleTransport = new winston.transports.Console({
  format: localFormat(),
});

const transports: LoggerOptions["transports"] = [consoleTransport];

const logger = winston.createLogger({
  level: "debug",
  exitOnError: false,
  transports,
});

type ConsoleArguments = Parameters<typeof console.log>;
type ConsoleLogLevel = "debug" | "error" | "info" | "warn";

const getArgs = (args: ConsoleArguments): ConsoleArguments => {
  const [strings, others] = partition(args, isString);
  if (strings.length) {
    return [strings.join(" "), ...others];
  }
  return args;
};

const logConsoleArguments = (level: ConsoleLogLevel, args: ConsoleArguments) => {
  const [message, ...metadata] = getArgs(args);
  switch (level) {
    case "debug":
      logger.debug(message, ...metadata);
      break;
    case "error":
      logger.error(message, ...metadata);
      break;
    case "info":
      logger.info(message, ...metadata);
      break;
    case "warn":
      logger.warn(message, ...metadata);
      break;
  }
};

console.log = (...args) => logConsoleArguments("info", args);
console.info = (...args) => logConsoleArguments("info", args);
console.warn = (...args) => logConsoleArguments("warn", args);
console.error = (...args) => logConsoleArguments("error", args);
console.debug = (...args) => logConsoleArguments("debug", args);
export default logger;
