import type { NextPage } from "next";
import { useRouter } from "next/router";
import {
  buildPaymentSupportMailto,
  buildVenmoPaymentUrl,
  formatSemester,
  PAYMENT_SUPPORT_EMAIL,
} from "@/utils/venmoPayment";

function readQueryValue(value: string | string[] | undefined, maxLength = 80): string {
  const singleValue = Array.isArray(value) ? value[0] : value;
  return singleValue?.trim().slice(0, maxLength) || "";
}

const PaymentHelp: NextPage = () => {
  const { query } = useRouter();
  const details = {
    paidId: readQueryValue(query.paidId),
    section: readQueryValue(query.section),
    semester: readQueryValue(query.semester),
    courseNumber: readQueryValue(query.courseNumber),
  };
  const hasValidPaymentNote = /^\d{8}$/.test(details.paidId);
  const semester = formatSemester(details.semester);
  const supportMailto = buildPaymentSupportMailto(details);

  return (
    <div className="mx-auto w-full max-w-3xl px-2 py-10 sm:px-6 sm:py-16">
      <header className="space-y-3 text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-red-700">Venmo payment help</p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Fix a payment without paying twice</h1>
        <p className="mx-auto max-w-2xl text-base text-gray-600 sm:text-lg">
          Each $1.00 payment covers text alerts for one section in one semester. It must include that section’s exact
          eight-digit payment note.
        </p>
      </header>

      {(details.courseNumber || details.section || details.semester) && (
        <section className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-5" aria-labelledby="payment-context">
          <h2 id="payment-context" className="text-lg font-semibold">
            Payment details
          </h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            {details.courseNumber && (
              <div>
                <dt className="font-medium text-gray-500">Course</dt>
                <dd className="text-gray-900">{details.courseNumber}</dd>
              </div>
            )}
            {details.section && (
              <div>
                <dt className="font-medium text-gray-500">Section</dt>
                <dd className="text-gray-900">{details.section}</dd>
              </div>
            )}
            {details.semester && (
              <div>
                <dt className="font-medium text-gray-500">Semester</dt>
                <dd className="text-gray-900">{semester}</dd>
              </div>
            )}
          </dl>
          {hasValidPaymentNote && (
            <div className="mt-5 rounded-xl border-2 border-gray-900 bg-white p-4 text-center">
              <p className="text-sm font-semibold">Required eight-digit Venmo payment note</p>
              <p className="mt-1 font-mono text-3xl font-bold tracking-widest">{details.paidId}</p>
              <p className="mt-2 text-sm text-gray-600">Use only these eight digits as the payment note.</p>
            </div>
          )}
        </section>
      )}

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <section className="rounded-2xl border border-gray-200 p-5">
          <h2 className="text-xl font-semibold">I have not paid yet</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-gray-700">
            <li>Send exactly $1.00 for this section.</li>
            <li>Keep the eight-digit payment note unchanged.</li>
            <li>Send a separate $1.00 payment for every additional section.</li>
          </ol>
          {hasValidPaymentNote ? (
            <a
              className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-gray-950 px-4 py-3 text-center font-semibold text-white hover:bg-gray-800"
              href={buildVenmoPaymentUrl(details.paidId)}
            >
              Pay exactly $1.00 — note prefilled
            </a>
          ) : (
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
              Open this page from your dashboard or “now watching” email to get the correct prefilled payment note.
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 p-5">
          <h2 className="text-xl font-semibold">I already paid</h2>
          <p className="mt-3 text-gray-700">
            Allow up to 20 minutes for automatic processing. If it is still not marked paid—or you sent the wrong or
            missing note—do not send another payment.
          </p>
          <a
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl border-2 border-gray-950 px-4 py-3 text-center font-semibold text-gray-950 hover:bg-gray-100"
            href={supportMailto}
          >
            Email support with payment details
          </a>
        </section>
      </div>

      <section className="mt-6 rounded-2xl bg-red-50 p-5 text-red-950">
        <h2 className="font-semibold">Important: recipient verification is different</h2>
        <p className="mt-1 text-sm">
          If Venmo asks you to verify the recipient, that verification value is only for confirming the recipient. Do
          not use it as the payment note. The payment note must be your section’s unique eight-digit code.
        </p>
      </section>

      <p className="mt-6 text-center text-sm text-gray-500">
        If the email button does not open, contact{" "}
        <a className="underline" href={`mailto:${PAYMENT_SUPPORT_EMAIL}`}>
          {PAYMENT_SUPPORT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
};

export default PaymentHelp;
