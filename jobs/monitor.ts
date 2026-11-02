import "dotenv/config";

import { AsyncTask, SimpleIntervalJob, ToadScheduler } from "toad-scheduler";
import { createClassInfo, runRefresh } from "@/server/api/controller";
import logger from "@/server/logger";
import { isProd } from "@/constants";
import { GmailVenmoImapClient } from "./venmoGmail/gmailClient.ts";
import { sendMessage } from "@/server/Twilio.ts";
import { sendPaidNotificationsEmails } from "@/server/paid-notifications-emails.ts";
import { prisma } from "@/server/db";
import { MonitorLifecycle } from "./monitorLifecycle";
import { isMaintenanceMode } from "@/server/maintenance";

const scheduler = new ToadScheduler();
const maintenance = isMaintenanceMode();
let maintenanceKeepalive: ReturnType<typeof setInterval> | undefined;
const lifecycle = new MonitorLifecycle({
  maintenance,
  stopScheduling: () => {
    scheduler.stop();
    if (maintenanceKeepalive) {
      clearInterval(maintenanceKeepalive);
    }
  },
  closeDatabase: () => prisma.$disconnect(),
});
const job = new SimpleIntervalJob(
  { minutes: 5, runImmediately: true },
  new AsyncTask(
    "Refresh classes",
    () => lifecycle.run(runRefresh),
    (err: Error) => {
      console.error(err);
    },
  ),
  {
    preventOverrun: true,
  },
);
const classInfoJob = new SimpleIntervalJob(
  { hours: 24, runImmediately: true },
  new AsyncTask(
    "Create class info",
    () => lifecycle.run(createClassInfo),
    (err: Error) => {
      console.error(err);
    },
  ),
  {
    preventOverrun: true,
  },
);

const client = new GmailVenmoImapClient();

const checkVenmoEmails = async () => {
  try {
    await client.checkEmails();
    return;
  } catch (e) {
    logger.error("Error checking Venmo emails via Gmail", e);
    try {
      await sendMessage({ to: process.env.TO_NUMBER!, message: `Error checking Venmo emails via Gmail: ${e}` });
    } catch (alertError) {
      logger.error("Failed to send Venmo Gmail error alert", alertError);
    }
    throw e;
  }
};

const gmailJob = new SimpleIntervalJob(
  { minutes: 15, runImmediately: true },
  new AsyncTask(
    "Venmo Gmail checker",
    () => lifecycle.run(checkVenmoEmails),
    (err: Error) => {
      logger.error("Error in Venmo Gmail checker task");
      logger.error(err);
    },
  ),
  {
    preventOverrun: true,
  },
);

const paidNotificationJob = new SimpleIntervalJob(
  { minutes: 5, runImmediately: true },
  new AsyncTask(
    "Pending payment notification sender",
    () => lifecycle.run(sendPaidNotificationsEmails),
    (err: Error) => {
      logger.error("Error in pending payment notification task", err);
    },
  ),
  {
    preventOverrun: true,
  },
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(JSON.stringify({ event: "usc_monitor_draining", activeJobs: lifecycle.activeJobs }));
  try {
    const result = await lifecycle.drain();
    logger.info(
      JSON.stringify({ event: result.drained ? "usc_monitor_drained" : "usc_monitor_drain_timeout", ...result }),
    );
    process.exit(result.drained ? 0 : 1);
  } catch {
    logger.error(JSON.stringify({ event: "usc_monitor_drain_failed", activeJobs: lifecycle.activeJobs }));
    process.exit(1);
  }
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

if (maintenance) {
  logger.info(JSON.stringify({ event: "usc_monitor_maintenance", activeJobs: 0 }));
  // Stay healthy but admit no work until maintenance is cleared by a new deployment.
  maintenanceKeepalive = setInterval(() => {}, 60_000);
} else {
  logger.info(`Starting monitor jobs - ${isProd ? "PROD" : "DEV"}`);
  scheduler.addSimpleIntervalJob(gmailJob);
  scheduler.addSimpleIntervalJob(paidNotificationJob);
  scheduler.addSimpleIntervalJob(job);
  scheduler.addSimpleIntervalJob(classInfoJob);
}
