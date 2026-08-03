import type { NextPage } from "next";
import React from "react";

const PrivacyPolicy: NextPage = () => {
  return (
    <main style={{ margin: "4rem auto", maxWidth: "900px", padding: "0 2rem", lineHeight: 1.6 }}>
      <h1>USC Schedule Helper Privacy Policy</h1>
      <p>Last updated: August 3, 2026</p>
      <p>
        USC Schedule Helper is a browser extension and companion notification service operated by JonLuca DeCaro. It
        improves USC class-search and registration pages with ratings, schedule information, conflict indicators, and
        optional class-availability notifications.
      </p>
      <p>This policy covers the USC Schedule Helper browser extension and the service at usc.jonlu.ca.</p>

      <h2>Information processed locally</h2>
      <p>
        The extension reads the USC Classes and Web Registration pages on which it runs so it can identify course and
        section information, display ratings and schedule tools, detect schedule conflicts, and offer a notification
        signup for a selected class. It does not monitor unrelated websites.
      </p>
      <p>
        The extension stores feature preferences locally, such as whether the extension, conflict display, and units
        display are enabled. When a user enters an email address or optional phone number in the notification form, the
        browser may remember those values locally for convenience.
      </p>

      <h2>Information sent to the notification service</h2>
      <p>
        Nothing is sent to USC Schedule Helper merely because the extension is installed. When a user explicitly
        submits a class-notification request, the extension sends the following to https://usc.jonlu.ca:
      </p>
      <ul>
        <li>the user&apos;s email address;</li>
        <li>an optional phone number when the user requests text notifications;</li>
        <li>the selected class section, department, and semester; and</li>
        <li>an optional USC identifier if the user supplies one through a supported service flow.</li>
      </ul>
      <p>
        The service also creates account-verification and payment-reference identifiers and records watched classes,
        notification status, payment status, and relevant timestamps. Its web server and infrastructure providers may
        receive standard request information such as IP address, browser type, and request time for operation,
        security, and troubleshooting.
      </p>

      <h2>How information is used</h2>
      <p>USC Schedule Helper uses this information only to:</p>
      <ul>
        <li>create and verify the user&apos;s notification account;</li>
        <li>monitor the requested class sections;</li>
        <li>send class-availability and account emails;</li>
        <li>send optional paid SMS alerts;</li>
        <li>show and manage watched classes in the user&apos;s dashboard;</li>
        <li>reconcile optional notification payments; and</li>
        <li>operate, secure, support, and troubleshoot the service.</li>
      </ul>
      <p>
        USC Schedule Helper does not sell personal information and does not use extension data for advertising, credit,
        lending, or unrelated profiling.
      </p>

      <h2>Service providers and disclosures</h2>
      <p>Information is disclosed only as needed to operate the requested service:</p>
      <ul>
        <li>hosting and database providers process application and account data;</li>
        <li>Amazon Simple Email Service processes email addresses and email content to deliver messages;</li>
        <li>Twilio processes phone numbers and message content when a user enables SMS notifications;</li>
        <li>
          Venmo processes payment information when a user chooses to follow a Venmo payment link, and the service may
          use the payment reference to mark a notification as paid; and
        </li>
        <li>
          information may be disclosed when required by law or to protect the security and rights of users or the
          service.
        </li>
      </ul>
      <p>
        These providers process information under their own terms and privacy practices. USC Schedule Helper does not
        authorize them to use extension data for the developer&apos;s advertising purposes.
      </p>

      <h2>Retention, security, and user choices</h2>
      <p>
        Local extension preferences remain until the user changes them, clears extension data, or removes the
        extension. Notification account and watched-class records are kept while needed to provide the service and for
        reasonable security, backup, payment, and legal purposes. Data that is no longer required is deleted or
        de-identified where practical.
      </p>
      <p>
        Users may stop future notifications, remove the extension, or request access, correction, or deletion of their
        service data by emailing <a href="mailto:usc@jonlu.ca">usc@jonlu.ca</a>. A request may require verification
        through the email address associated with the account.
      </p>
      <p>
        Reasonable technical and organizational safeguards are used, but no internet transmission or storage system can
        be guaranteed completely secure.
      </p>

      <h2>Changes and contact</h2>
      <p>
        Material changes to this policy will be reflected on this page and in its updated date. Privacy questions or
        requests may be sent to <a href="mailto:usc@jonlu.ca">usc@jonlu.ca</a>.
      </p>
    </main>
  );
};

export default PrivacyPolicy;
