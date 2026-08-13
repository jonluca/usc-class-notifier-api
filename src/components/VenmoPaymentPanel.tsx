import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { buildPaymentHelpUrl, buildVenmoPaymentUrl, formatSemester } from "@/utils/venmoPayment";

interface VenmoPaymentPanelProps {
  className?: string;
  courseNumber?: string | null;
  paidId: string;
  section: string;
  semester: string;
  showQr?: boolean;
}

const copyPaymentNote = async (paidId: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(paidId);
    return;
  }

  const input = document.createElement("textarea");
  input.value = paidId;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
};

export const VenmoPaymentPanel = ({
  className = "",
  courseNumber,
  paidId,
  section,
  semester,
  showQr = false,
}: VenmoPaymentPanelProps) => {
  const [didCopy, setDidCopy] = useState(false);
  const venmoUrl = buildVenmoPaymentUrl(paidId);
  const paymentHelpUrl = buildPaymentHelpUrl({ courseNumber, paidId, section, semester });

  const copy = async () => {
    try {
      await copyPaymentNote(paidId);
      setDidCopy(true);
      window.setTimeout(() => setDidCopy(false), 2_000);
    } catch {
      setDidCopy(false);
    }
  };

  return (
    <section
      className={`flex w-full flex-col gap-3 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-left text-neutral-900 ${className}`}
      aria-label={`Text notification payment for section ${section}`}
    >
      <div>
        <p className="m-0 text-sm font-semibold text-violet-900">Enable text notifications</p>
        <p className="m-0 text-xs text-neutral-600">
          {courseNumber ? `${courseNumber} · ` : ""}Section {section} · {formatSemester(semester)}
        </p>
      </div>

      <p className="m-0 text-sm">
        Send <strong>exactly $1.00</strong> for this section. Send a separate $1 payment for every section.
      </p>

      <div className="rounded-xl border-2 border-violet-500 bg-white p-3 text-center">
        <p className="m-0 text-xs font-bold uppercase tracking-wide text-violet-800">Required payment note</p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <code className="select-all font-mono text-2xl font-black tracking-widest text-black">{paidId}</code>
          <button
            type="button"
            onClick={copy}
            className="rounded-lg border border-violet-300 bg-violet-100 px-3 py-1.5 text-sm font-bold text-violet-900 hover:bg-violet-200"
          >
            {didCopy ? "Copied" : "Copy note"}
          </button>
        </div>
        <p className="m-0 mt-1 text-xs font-semibold text-red-700">
          Do not edit or replace this note with a class name, phone number, emoji, or “text notifications.”
        </p>
      </div>

      <a
        href={venmoUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="rounded-xl bg-[#008CFF] px-4 py-3 text-center text-base font-black text-white no-underline hover:bg-[#0074d4]"
      >
        Pay exactly $1.00 in Venmo — note prefilled
      </a>

      {showQr && (
        <details className="rounded-xl border border-neutral-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-bold">Pay from another device: show payment QR</summary>
          <div className="mt-3 flex flex-col items-center gap-2 text-center">
            <QRCodeSVG
              value={venmoUrl}
              size={184}
              level="M"
              marginSize={4}
              title={`Venmo payment for section ${section} with note ${paidId}`}
            />
            <p className="m-0 max-w-xs text-xs text-neutral-600">
              This QR is unique to this section and includes the $1 amount and required payment note.
            </p>
          </div>
        </details>
      )}

      <details className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700">
        <summary className="cursor-pointer font-semibold">Did Venmo ask you to verify the recipient?</summary>
        <p className="m-0 mt-2">
          Enter <strong>9020</strong> only in Venmo’s recipient-verification prompt.
          <strong> Never use 9020 as the payment note.</strong>
        </p>
      </details>
      <p className="m-0 text-xs text-neutral-600">
        Confirmation can take up to 20 minutes. Already paid with the wrong note?{" "}
        <a
          className="font-bold text-violet-800 underline"
          href={paymentHelpUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Recover your payment
        </a>
        .
      </p>
    </section>
  );
};
